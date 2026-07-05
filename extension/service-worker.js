const LRCLIB_BASE = 'https://lrclib.net/api';
const sessions = new Map();

/* MV3 service workers are killed after ~30s idle, wiping the in-memory
   `sessions` Map. That made the extension "stop detecting songs": the overlay
   kept sending LV_TRACK_CHANGED, but the session lookup failed so the message
   was silently ignored. Persist active tab ids so sessions survive SW death. */
(async () => {
  try {
    const stored = await chrome.storage.session.get('lvxActiveTabs');
    (stored.lvxActiveTabs || []).forEach((id) => sessions.set(id, { active: true }));
  } catch (_) {}
})();

function persistSessions() {
  try { chrome.storage.session.set({ lvxActiveTabs: [...sessions.keys()] }); } catch (_) {}
}

/* ── API Health Tracking (Circuit Breaker) ── */
const DEGRADED_THRESHOLD = 5;    // weighted failures → degraded (timeouts=0.5, server errors=1.5)
const RECOVERY_WINDOW_MS = 30000; // auto-recover after 30s (was 60s — recover faster)
const DETECT_TIMEOUT_MS = 28000;  // global detection timeout — must exceed the slowest single request

/* Per-endpoint timeouts.
   LRCLIB /get without a warm server-side cache queries external sources and can
   legitimately take 5-10s. The old 2-5s timeouts were aborting healthy-but-slow
   requests (visible as "(canceled)" with 0 kB in DevTools), then counting those
   SELF-INFLICTED aborts as API failures → circuit breaker tripped → false
   "server is slow" errors even though the API was perfectly fine. */
const TIMEOUT_CACHED_MS = 4000;   // /get-cached — genuinely fast endpoint
const TIMEOUT_GET_MS    = 10000;  // /get — can be slow on cold cache, that's NORMAL
const TIMEOUT_SEARCH_MS = 8000;   // /search and /get/{id}
const TIMEOUT_OVH_MS    = 6000;   // lyrics.ovh fallback

const apiHealth = {
  lrclib:     { failures: 0, lastFailure: 0, lastSuccess: 0, degraded: false, lastErrorType: null },
  lyricsOvh:  { failures: 0, lastFailure: 0, lastSuccess: 0, degraded: false, lastErrorType: null }
};

function recordApiSuccess(apiName) {
  const h = apiHealth[apiName];
  if (!h) return;
  h.failures = 0;
  h.degraded = false;
  h.lastErrorType = null;
  h.lastSuccess = Date.now();
}

/**
 * Record an API failure with weighted severity.
 * TIMEOUT = 0.5 (slow ≠ dead), SERVER_ERROR = 1.5, NETWORK_ERROR = 1, RATE_LIMITED = 2.
 * This prevents the death spiral where slow responses trigger aggressive timeout reduction.
 */
function recordApiFailure(apiName, errorType) {
  const h = apiHealth[apiName];
  if (!h) return;
  const weights = { TIMEOUT: 0.5, SERVER_ERROR: 1.5, NETWORK_ERROR: 1, RATE_LIMITED: 2 };
  h.failures += weights[errorType] || 1;
  h.lastFailure = Date.now();
  h.lastErrorType = errorType || null;
  if (h.failures >= DEGRADED_THRESHOLD) h.degraded = true;
}

function isApiDegraded(apiName) {
  const h = apiHealth[apiName];
  if (!h) return false;
  // Auto-recover after RECOVERY_WINDOW_MS
  if (h.degraded && (Date.now() - h.lastFailure) > RECOVERY_WINDOW_MS) {
    h.degraded = false;
    h.failures = 0;
    h.lastErrorType = null;
    return false;
  }
  return h.degraded;
}

/**
 * Unified fetch wrapper with error classification.
 * Returns { ok, data, errorType } instead of throwing.
 * errorType: 'TIMEOUT' | 'NETWORK_ERROR' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'UNAUTHORIZED' | 'NOT_FOUND' | null
 */
const inflightRequests = new Map();

async function apiFetch(url, apiName, timeoutMs) {
  // De-duplicate identical concurrent requests. Retry loops used to fire the
  // exact same URL several times in parallel — the request flood visible in DevTools.
  if (inflightRequests.has(url)) return inflightRequests.get(url);
  const promise = _apiFetchRaw(url, apiName, timeoutMs);
  inflightRequests.set(url, promise);
  try {
    return await promise;
  } finally {
    inflightRequests.delete(url);
  }
}

async function _apiFetchRaw(url, apiName, timeoutMs) {
  const effectiveTimeout = timeoutMs; // No timeout reduction — degraded mode skips slow endpoints instead
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (response.ok) {
      recordApiSuccess(apiName);
      const data = await response.json();
      return { ok: true, data, errorType: null };
    }
    // Classify HTTP errors
    if (response.status === 429) {
      recordApiFailure(apiName, 'RATE_LIMITED');
      return { ok: false, data: null, errorType: 'RATE_LIMITED' };
    }
    if (response.status === 404) {
      // 404 is "not found" — NOT an API failure, don't count against health
      return { ok: false, data: null, errorType: 'NOT_FOUND' };
    }
    if (response.status === 401) {
      // 401 is auth/token expired — not a server crash
      return { ok: false, data: null, errorType: 'UNAUTHORIZED' };
    }
    if (response.status >= 500) {
      recordApiFailure(apiName, 'SERVER_ERROR');
      return { ok: false, data: null, errorType: 'SERVER_ERROR' };
    }
    return { ok: false, data: null, errorType: 'NOT_FOUND' };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      recordApiFailure(apiName, 'TIMEOUT');
      return { ok: false, data: null, errorType: 'TIMEOUT' };
    }
    recordApiFailure(apiName, 'NETWORK_ERROR');
    return { ok: false, data: null, errorType: 'NETWORK_ERROR' };
  }
}

/* ── Lyrics cache: 3-tier for maximum resilience ──
   Tier 1: In-memory Map (instant, lost on SW death)
   Tier 2: chrome.storage.session (survives SW suspension within browser session)
   Tier 3: chrome.storage.local (PERSISTENT — survives browser restarts, works when API is down)
   This means any song that was EVER successfully fetched will always be available. ── */
const lyricsCache = new Map();
const CACHE_MAX = 100;

/* Negative-result cache: tracks that definitively had NO lyrics while the API
   was healthy. Prevents the DOM-retry loops from re-firing the exact same
   /get + /search queries 5-6 times in a row (the request flood in DevTools).
   NEVER set when the failure was caused by an API error — those should retry. */
const negativeCache = new Map();
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

function isKnownMiss(track, artist) {
  const key = cacheKey(track, artist);
  const t = negativeCache.get(key);
  if (!t) return false;
  if (Date.now() - t > NEGATIVE_TTL_MS) { negativeCache.delete(key); return false; }
  return true;
}

function markMiss(track, artist) {
  if (negativeCache.size > 200) negativeCache.clear();
  negativeCache.set(cacheKey(track, artist), Date.now());
}
const PERSISTENT_CACHE_MAX = 500;   // max songs in chrome.storage.local
const PERSISTENT_PREFIX = 'lvxP:';  // prefix for persistent cache keys

function cacheKey(track, artist) {
  return `${(artist || '').toLowerCase().trim()}|${(track || '').toLowerCase().trim()}`;
}

async function getCachedLyrics(track, artist) {
  const key = cacheKey(track, artist);

  // Tier 1: In-memory
  if (lyricsCache.has(key)) return lyricsCache.get(key);

  // Tier 2: Session storage (survives SW restarts within the browser session)
  try {
    const stored = await chrome.storage.session.get(`lvxCache:${key}`);
    const hit = stored[`lvxCache:${key}`];
    if (hit) {
      lyricsCache.set(key, hit);
      return hit;
    }
  } catch (_) {}

  // Tier 3: Persistent storage (survives browser restarts — works when API is down!)
  try {
    const persisted = await chrome.storage.local.get(`${PERSISTENT_PREFIX}${key}`);
    const pHit = persisted[`${PERSISTENT_PREFIX}${key}`];
    if (pHit) {
      // Promote back to faster tiers
      lyricsCache.set(key, pHit);
      try { chrome.storage.session.set({ [`lvxCache:${key}`]: pHit }); } catch (_) {}
      return pHit;
    }
  } catch (_) {}

  return null;
}

/**
 * Tier 4 (OUTAGE-ONLY): fuzzy match against the persistent cache.
 * Exact keys often miss because the same song arrives with slightly different
 * metadata ("Song (Official Video)" vs "Song", "A, B" vs "A"). During a real
 * API outage this rescues any song you've played before, even with messy keys.
 */
async function getFuzzyCachedLyrics(track, artist) {
  try {
    const norm = (s) => (s || '').toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, '')                    // strip (...) [...]
      .replace(/official|video|audio|lyrics|hd|4k/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const wantTrack = norm(track);
    if (!wantTrack) return null;
    const wantArtist = norm((artist || '').split(/[,&]/)[0]);

    const all = await chrome.storage.local.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(PERSISTENT_PREFIX) || !v) continue;
      const [cArtist, cTrack] = k.slice(PERSISTENT_PREFIX.length).split('|');
      const haveTrack = norm(cTrack);
      const haveArtist = norm((cArtist || '').split(/[,&]/)[0]);
      const trackMatch = haveTrack && (haveTrack === wantTrack ||
        haveTrack.includes(wantTrack) || wantTrack.includes(haveTrack));
      const artistMatch = !wantArtist || !haveArtist ||
        haveArtist.includes(wantArtist) || wantArtist.includes(haveArtist);
      if (trackMatch && artistMatch) return v;
    }
  } catch (_) {}
  return null;
}

function setCachedLyrics(track, artist, payload) {
  const key = cacheKey(track, artist);
  if (lyricsCache.size >= CACHE_MAX) {
    const oldest = lyricsCache.keys().next().value;
    lyricsCache.delete(oldest);
  }
  lyricsCache.set(key, payload);

  // Tier 2: Session storage
  try {
    chrome.storage.session.set({ [`lvxCache:${key}`]: payload });
  } catch (_) {}

  // Tier 3: Persistent storage (fire-and-forget, with LRU eviction)
  persistLyricsCache(key, payload);
}

/** Persist to chrome.storage.local with LRU eviction when over limit */
async function persistLyricsCache(key, payload) {
  try {
    const fullKey = `${PERSISTENT_PREFIX}${key}`;
    // Store with a timestamp for LRU eviction
    const entry = { ...payload, _cachedAt: Date.now() };
    await chrome.storage.local.set({ [fullKey]: entry });

    // Periodically check size and evict old entries (every ~20 writes)
    if (Math.random() < 0.05) {
      evictOldPersistentCache();
    }
  } catch (_) {}
}

async function evictOldPersistentCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const cacheEntries = Object.entries(all)
      .filter(([k]) => k.startsWith(PERSISTENT_PREFIX));

    if (cacheEntries.length <= PERSISTENT_CACHE_MAX) return;

    // Sort by _cachedAt ascending (oldest first) and remove excess
    cacheEntries.sort((a, b) => (a[1]._cachedAt || 0) - (b[1]._cachedAt || 0));
    const toRemove = cacheEntries.slice(0, cacheEntries.length - PERSISTENT_CACHE_MAX);
    await chrome.storage.local.remove(toRemove.map(([k]) => k));
  } catch (_) {}
}

/* ══════════════════════════════════════
   ACTION CLICK HANDLER
   ══════════════════════════════════════ */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  const existing = sessions.get(tab.id);
  if (existing && existing.active) {
    await stopSession(tab.id, 'Stopped');
    return;
  }

  await startSession(tab);
});

/* ══════════════════════════════════════
   MESSAGE ROUTING
   ══════════════════════════════════════ */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.type) return;

  if (message.type === 'LV_CONTENT_STOP' && sender.tab && sender.tab.id) {
    stopSession(sender.tab.id, 'Stopped');
  }

  // Retry button pressed in content script — clear negative cache so the
  // user's explicit retry always performs a genuinely fresh lookup.
  if (message.type === 'LV_RETRY' && sender.tab && sender.tab.id) {
    negativeCache.clear();
    clearTimeout(autoRetryTimers.get(sender.tab.id));
    autoRetryTimers.delete(sender.tab.id);
    startSession(sender.tab);
  }

  // Spotify track change: full restart (proven flow)
  if (message.type === 'LV_SPOTIFY_TRACK_CHANGED' && sender.tab && sender.tab.id) {
    startSession(sender.tab);
  }

  // Non-Spotify track change (YT Music, SoundCloud, plain YouTube):
  // Re-detect lyrics WITHOUT tearing down the overlay — just swap to the new track.
  if (message.type === 'LV_TRACK_CHANGED' && sender.tab && sender.tab.id) {
    // FIX: if the MV3 service worker was killed and restarted, `sessions` is
    // empty even though the overlay is clearly alive (it just messaged us!).
    // Previously this message was silently dropped — the #1 cause of
    // "extension stopped detecting songs". Recreate the session instead.
    let session = sessions.get(sender.tab.id);
    if (!session) {
      session = { active: true };
      sessions.set(sender.tab.id, session);
      persistSessions();
    }
    session.active = true;
    // Because content.js now uses a stability timer, we don't need to poll or wait.
    // The track is guaranteed to be fully loaded and settled in the DOM.
    injectOverlay(sender.tab.id).then(() => {
      detectAndSync(sender.tab.id, message.prevKey || '');
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  persistSessions();
  clearTimeout(autoRetryTimers.get(tabId));
  autoRetryTimers.delete(tabId);
});

/* ══════════════════════════════════════
   SESSION MANAGEMENT
   ══════════════════════════════════════ */
async function startSession(tab) {
  const tabId = tab.id;
  sessions.set(tabId, { active: true });
  persistSessions();

  await injectOverlay(tabId);
  await detectAndSync(tabId);
}

function getHintsTrackKey(h) {
  const track = (h.track || h.pageTitle || '').trim();
  const artist = (h.artist || '').trim();
  return track ? `${track}|||${artist}` : '';
}

/**
 * Shared detection pipeline used by both startSession and track changes.
 * Handles cache check, metadata detection, platform-specific retries.
 * Wrapped in a global timeout to prevent infinite "Detecting..." states.
 * @param {string} [prevKey] - If provided (from track change), used to validate
 *   that the current track is actually different before serving cached results.
 */
/* Per-tab detection lock: LV_TRACK_CHANGED, LV_RETRY and periodic observer
   ticks could all start detectAndSync concurrently for the same tab, racing
   each other and multiplying identical API requests. Serialize them. */
const detectionLocks = new Map();

async function detectAndSync(tabId, prevKey) {
  if (detectionLocks.get(tabId)) {
    // A detection is already running for this tab — remember the latest
    // request so we run ONE follow-up when the current one finishes.
    detectionLocks.set(tabId, { pending: true, prevKey });
    return;
  }
  detectionLocks.set(tabId, { pending: false, prevKey });
  try {
    await _detectAndSyncLocked(tabId, prevKey);
  } finally {
    const lock = detectionLocks.get(tabId);
    detectionLocks.delete(tabId);
    if (lock && lock.pending) {
      // A newer track-change arrived mid-detection — handle it now.
      detectAndSync(tabId, lock.prevKey);
    }
  }
}

async function _detectAndSyncLocked(tabId, prevKey) {
  // Show degraded-aware status
  if (isApiDegraded('lrclib')) {
    sendToTab(tabId, { type: 'LV_STATUS_WARNING', text: 'Lyrics service is busy — trying anyway...' });
  } else {
    sendToTab(tabId, { type: 'LV_STATUS', text: 'Detecting song...' });
  }

  // Wrap entire detection in a hard timeout to prevent infinite "Detecting..."
  const detectStart = Date.now();
  let timedOut = false;
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error('DETECT_TIMEOUT'));
    }, DETECT_TIMEOUT_MS);
  });

  try {
    await Promise.race([_detectAndSyncInner(tabId, prevKey, detectStart), timeoutPromise]);
  } catch (err) {
    if (err.message === 'DETECT_TIMEOUT') {
      const h = apiHealth.lrclib;
      const lastErr = h ? h.lastErrorType : null;
      const isServerDown = (lastErr === 'SERVER_ERROR' || lastErr === 'NETWORK_ERROR') &&
                           h.lastFailure > h.lastSuccess;
      // Only blame the server for "slowness" if it ACTUALLY timed out recently.
      // A detection timeout can also happen from DOM-retry loops on a song that
      // simply has no lyrics — that's not the server's fault.
      const isServerSlow = lastErr === 'TIMEOUT' && h.lastFailure > h.lastSuccess;
      if (isServerDown || isServerSlow) {
        // OUTAGE RESCUE: fuzzy-match the persistent cache before erroring
        if (await _tryOfflineRescue(tabId)) return;
        sendToTab(tabId, {
          type: 'LV_API_ERROR',
          text: isServerDown
            ? 'Lyrics server is temporarily unavailable. Songs you\'ve played before still load from cache!'
            : 'Lyrics server is responding slowly — this usually clears up quickly. Tap retry!',
          canRetry: true
        });
        scheduleAutoRetry(tabId); // silently recover in the background
      } else {
        sendToTab(tabId, {
          type: 'LV_ERROR',
          text: 'Couldn\'t find lyrics for this track in time. It may not be in the lyrics database yet.'
        });
      }
    }
    // Other unexpected errors — show generic message
    else {
      sendToTab(tabId, {
        type: 'LV_ERROR',
        text: 'Something went wrong while searching for lyrics. Please try again.'
      });
    }
  }
}

/** Inner detection logic — separated so the outer function can race it against a timeout. */
async function _detectAndSyncInner(tabId, prevKey, detectStart) {
  const hints = await getPageHints(tabId);
  const isSpotify = (hints.host || '').includes('spotify.com');
  const isYouTubeMusic = (hints.host || '').includes('music.youtube.com');

  // STEP 0: Cache hit — instant, no network needed
  // But ONLY if we've confirmed the track actually changed (prevKey validation).
  // Without this check, a stale DOM read would serve the previous song's cached lyrics.
  if (hints.track) {
    const currentKey = getHintsTrackKey(hints);
    const cacheStale = prevKey && currentKey === prevKey;
    if (!cacheStale) {
      const cached = await getCachedLyrics(hints.track, hints.artist);
      if (cached) {
        if (cached.track && hints.currentTime != null) {
          cached.track.playOffsetMs = Math.round((hints.currentTime || 0) * 1000);
        }
        await handleRecognitionResult(tabId, cached);
        return;
      }
    }
  }

  // STEP 1: Try immediately — YouTube Music always has metadata ready on first attempt
  const metadataResult = await recognize({ mode: 'metadata', hints });
  if (metadataResult && metadataResult.ok && hasUsableLyrics(metadataResult)) {
    await handleRecognitionResult(tabId, metadataResult);
    return;
  }

  // If recognize returned an API error, warn the user while retrying
  if (metadataResult && metadataResult.apiError) {
    sendToTab(tabId, { type: 'LV_STATUS_WARNING', text: 'Lyrics server is slow — still trying...' });
  }

  // Track which hint-keys we've already run a FULL lookup for. Re-running
  // recognize() with identical metadata just re-fires the same API queries
  // (the request flood in DevTools) and can never produce a different answer
  // unless the API errored. Only retry when the DOM gave us something NEW.
  const attemptedKeys = new Set();
  const firstKey = getHintsTrackKey(hints);
  if (firstKey && metadataResult && !metadataResult.apiError) attemptedKeys.add(firstKey);

  // YouTube Music: if first attempt failed, retry with fresh hints.
  // YTM DOM may still be settling — give it multiple chances on initial startup.
  if (isYouTubeMusic) {
    const ytmRetryDelays = [200, 500, 1000, 1500, 2500];
    for (const delay of ytmRetryDelays) {
      await new Promise((r) => setTimeout(r, delay));
      const retryHints = await getPageHints(tabId);
      const retryKey = getHintsTrackKey(retryHints);
      if (prevKey && retryKey === prevKey) continue;
      if (retryKey && attemptedKeys.has(retryKey)) continue; // identical metadata → identical result, skip
      if (retryHints.track) {
        const retryResult = await recognize({ mode: 'metadata', hints: retryHints });
        if (retryResult && retryResult.ok && hasUsableLyrics(retryResult)) {
          await handleRecognitionResult(tabId, retryResult);
          return;
        }
        if (retryKey && !(retryResult && retryResult.apiError)) attemptedKeys.add(retryKey);
      }
    }
    const finalHints = await getPageHints(tabId);
    _sendSmartError(tabId, finalHints.track || hints.track || 'this song');
    return;
  }

  // SoundCloud: page title always has track info, retry quickly
  const isSoundCloud = (hints.host || '').includes('soundcloud.com');
  if (isSoundCloud) {
    const scRetryDelays = [200, 500];
    let scTrack = hints.track || '';
    for (const delay of scRetryDelays) {
      await new Promise((r) => setTimeout(r, delay));
      const retryHints = await getPageHints(tabId);
      scTrack = retryHints.track || retryHints.pageTitle || scTrack;
      const scKey = getHintsTrackKey(retryHints);
      if (scKey && attemptedKeys.has(scKey)) continue; // same metadata — don't re-query
      if (scTrack) {
        sendToTab(tabId, { type: 'LV_STATUS', text: `Searching lyrics for: ${scTrack}` });
        const retryResult = await recognize({ mode: 'metadata', hints: retryHints });
        if (retryResult && retryResult.ok && hasUsableLyrics(retryResult)) {
          await handleRecognitionResult(tabId, retryResult);
          return;
        }
        if (scKey && !(retryResult && retryResult.apiError)) attemptedKeys.add(scKey);
      }
    }
    if (scTrack) {
      _sendSmartError(tabId, scTrack);
    } else {
      sendToTab(tabId, {
        type: 'LV_ERROR',
        text: 'Could not detect a song. Make sure a track is playing on SoundCloud.'
      });
    }
    return;
  }

  // STEP 2: Spotify — SPA needs DOM to settle; retry with tighter delays
  if (isSpotify) {
    const retryDelays = [100, 300, 700, 1500];
    let lastDetectedTrack = hints.track || '';
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      await new Promise((r) => setTimeout(r, retryDelays[attempt]));
      if (attempt >= 2) {
        try { await injectOverlay(tabId); } catch (_) {}
      }
      const retryHints = await getPageHints(tabId);
      if (retryHints.track || retryHints.pageTitle) {
        lastDetectedTrack = retryHints.track || retryHints.pageTitle || '';
        const spKey = getHintsTrackKey(retryHints);
        if (spKey && attemptedKeys.has(spKey)) continue; // same metadata — don't re-query
        sendToTab(tabId, { type: 'LV_STATUS', text: `Searching lyrics for: ${lastDetectedTrack}` });
        const retryResult = await recognize({ mode: 'metadata', hints: retryHints });
        if (retryResult && retryResult.ok && hasUsableLyrics(retryResult)) {
          await handleRecognitionResult(tabId, retryResult);
          return;
        }
        if (spKey && !(retryResult && retryResult.apiError)) attemptedKeys.add(spKey);
      }
    }
    if (lastDetectedTrack) {
      _sendSmartError(tabId, lastDetectedTrack);
    } else {
      sendToTab(tabId, {
        type: 'LV_ERROR',
        text: 'Could not find lyrics for this Spotify track. Make sure a song is playing and try again.'
      });
    }
    return;
  }

  // STEP 3: Generic sites — shorter retry window
  const genericDelays = [250, 700, 1500];  // was [400, 1000, 2200]
  let lastTrack = hints.track || hints.pageTitle || '';
  for (const delay of genericDelays) {
    await new Promise((r) => setTimeout(r, delay));
    const retryHints = await getPageHints(tabId);
    lastTrack = retryHints.track || retryHints.pageTitle || lastTrack;
    const genKey = getHintsTrackKey(retryHints);
    if (genKey && attemptedKeys.has(genKey)) continue; // same metadata — don't re-query
    if (lastTrack) {
      sendToTab(tabId, { type: 'LV_STATUS', text: `Searching lyrics for: ${lastTrack}` });
    }
    const retryResult = await recognize({ mode: 'metadata', hints: retryHints });
    if (retryResult && retryResult.ok && hasUsableLyrics(retryResult)) {
      await handleRecognitionResult(tabId, retryResult);
      return;
    }
    if (genKey && !(retryResult && retryResult.apiError)) attemptedKeys.add(genKey);
  }

  if (lastTrack) {
    _sendSmartError(tabId, lastTrack);
  } else {
    sendToTab(tabId, {
      type: 'LV_ERROR',
      text: 'Could not detect a song on this page. Works best on YouTube Music, Spotify, and SoundCloud.'
    });
  }
}

/**
 * OUTAGE RESCUE: when the API is genuinely down, try to serve the song from
 * the persistent cache with fuzzy matching before showing any error.
 * Returns true if lyrics were served.
 */
async function _tryOfflineRescue(tabId) {
  try {
    const hints = await getPageHints(tabId);
    if (!hints.track && !hints.pageTitle) return false;
    const fuzzy = await getFuzzyCachedLyrics(hints.track || hints.pageTitle, hints.artist);
    if (fuzzy && fuzzy.ok && hasUsableLyrics(fuzzy)) {
      if (fuzzy.track && hints.currentTime != null) {
        fuzzy.track.playOffsetMs = Math.round((hints.currentTime || 0) * 1000);
      }
      sendToTab(tabId, { type: 'LV_STATUS_WARNING', text: 'Server is down — playing from offline cache' });
      await handleRecognitionResult(tabId, fuzzy);
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * AUTO-RETRY: during a genuine outage, silently retry in the background with
 * backoff (10s → 20s → 40s). If the API recovers, lyrics appear automatically
 * without the user having to press TRY AGAIN.
 */
const autoRetryTimers = new Map();
function scheduleAutoRetry(tabId, attempt = 0) {
  if (attempt >= 3) return;
  clearTimeout(autoRetryTimers.get(tabId));
  const delay = 10000 * Math.pow(2, attempt);
  autoRetryTimers.set(tabId, setTimeout(async () => {
    const session = sessions.get(tabId);
    if (!session || !session.active) return;
    try {
      // Cheap health probe before a full re-detect
      const probe = await apiFetch(`${LRCLIB_BASE}/search?q=test`, 'lrclib', 5000);
      if (probe.ok) {
        recordApiSuccess('lrclib');
        detectAndSync(tabId);
      } else {
        scheduleAutoRetry(tabId, attempt + 1);
      }
    } catch (_) {
      scheduleAutoRetry(tabId, attempt + 1);
    }
  }, delay));
}

/**
 * Send the right error type depending on whether the API is degraded vs lyrics just not found.
 * This is the key UX distinction — users need to know if it's the service or the song.
 */
async function _sendSmartError(tabId, trackName) {
  const h = apiHealth.lrclib;
  // FIX for false "server is slow" alarms:
  // Previously ANY single sub-request error (e.g. one of two parallel /get calls
  // timing out while the other answered fine) left lastErrorType set, and we'd
  // blame the server even though it was healthy. Now we only claim the server
  // has a problem when the evidence is real:
  //   - the circuit breaker is actually tripped (degraded), OR
  //   - the last error is newer than the last success AND we have meaningful
  //     accumulated failures (>= 2 weighted) — not just one flaky request.
  const errRecent = h && h.lastErrorType && h.lastErrorType !== 'NOT_FOUND' &&
                    h.lastFailure > h.lastSuccess;
  const hadApiError = isApiDegraded('lrclib') || (errRecent && h.failures >= 2);
  if (hadApiError) {
    // OUTAGE RESCUE: fuzzy-match the persistent cache before erroring
    if (await _tryOfflineRescue(tabId)) return;
    sendToTab(tabId, {
      type: 'LV_API_ERROR',
      text: h.lastErrorType === 'TIMEOUT'
        ? `Lyrics server is responding slowly. Couldn't fetch lyrics for "${trackName}" in time — tap retry!`
        : `Lyrics server is having issues. Could not fetch lyrics for "${trackName}". Try again in a moment!`,
      canRetry: true
    });
    scheduleAutoRetry(tabId); // silently recover in the background
  } else {
    sendToTab(tabId, {
      type: 'LV_ERROR',
      text: `No lyrics found for "${trackName}". This song may not be in the lyrics database yet.`
    });
  }
}

async function stopSession(tabId, reason) {
  sessions.delete(tabId);
  persistSessions();
  clearTimeout(autoRetryTimers.get(tabId));
  autoRetryTimers.delete(tabId);
  sendToTab(tabId, { type: 'LV_STOP', text: reason || 'Stopped' });
}

/* ══════════════════════════════════════
   CORE RECOGNITION LOGIC
   (previously lived in server.js)
   ══════════════════════════════════════ */
async function recognize(body) {
  const hints = normalizeHints(body && body.hints ? body.hints : {});
  const detected = trackFromHints(hints);

  if (!detected) {
    return {
      ok: false,
      message: 'Could not read a song title from this page.',
      hints
    };
  }

  // Check cache before hitting API
  const cached = await getCachedLyrics(detected.title, detected.artist);
  if (cached) {
    if (cached.track && detected.playOffsetMs != null) {
      cached.track.playOffsetMs = detected.playOffsetMs;
    }
    return cached;
  }

  // Known miss (recent, API was healthy) — don't hammer the API again
  if (isKnownMiss(detected.title, detected.artist)) {
    return {
      ok: false,
      apiError: false,
      knownMiss: true,
      message: `Song detected as "${displayTrack(detected)}", but no lyrics were found.`,
      track: detected,
      hints
    };
  }

  const lyricResult = await findLyrics(detected, hints);

  if (!lyricResult) {
    const h = apiHealth.lrclib;
    const apiTrouble = isApiDegraded('lrclib') ||
      (h.lastErrorType && h.lastErrorType !== 'NOT_FOUND' && h.lastFailure > h.lastSuccess);
    // Only cache as a definitive miss if the API was healthy — a failure during
    // an outage must stay retryable once the server recovers.
    if (!apiTrouble) markMiss(detected.title, detected.artist);
    return {
      ok: false,
      apiError: apiTrouble,  // surface API health to caller
      message: `Song detected as "${displayTrack(detected)}", but no lyrics were found.`,
      track: detected,
      hints
    };
  }

  const matched = lyricResult.match || {};
  const track = {
    title: detected.title || matched.trackName || matched.name || '',
    artist: detected.artist || matched.artistName || '',
    album: detected.album || matched.albumName || '',
    durationMs: detected.durationMs || secondsToMs(matched.duration),
    playOffsetMs: Number.isFinite(detected.playOffsetMs)
      ? detected.playOffsetMs
      : secondsToMs(hints.currentTime || 0),
    source: detected.source,
    lyricsProvider: lyricResult.lyrics.provider || 'LRCLIB'
  };

  const result = {
    ok: true,
    message: lyricResult.lyrics.synced ? 'Synced lyrics ready.' : 'Plain lyrics ready.',
    track,
    lyrics: lyricResult.lyrics,
    match: matched,
    hints
  };

  // Cache for future use
  setCachedLyrics(track.title, track.artist, result);

  return result;
}

function trackFromHints(hints) {
  if (hints.track && hints.artist) {
    return {
      title: cleanTrackTitle(hints.track),
      artist: cleanArtistName(hints.artist),
      rawTitle: hints.track,
      rawArtist: hints.artist,
      album: hints.album || '',
      durationMs: secondsToMs(hints.duration),
      playOffsetMs: secondsToMs(hints.currentTime),
      source: 'page-metadata'
    };
  }

  if (hints.track) {
    return {
      title: cleanTrackTitle(hints.track),
      artist: '',
      rawTitle: hints.track,
      rawArtist: '',
      album: hints.album || '',
      query: cleanTrackTitle(hints.track),
      durationMs: secondsToMs(hints.duration),
      playOffsetMs: secondsToMs(hints.currentTime),
      source: 'page-metadata-partial'
    };
  }

  const parsed = parsePageTitle(hints.pageTitle || '');
  if (parsed.title || parsed.query) {
    return {
      title: parsed.title || '',
      artist: parsed.artist || '',
      album: '',
      query: parsed.query,
      durationMs: secondsToMs(hints.duration),
      playOffsetMs: secondsToMs(hints.currentTime),
      source: 'page-title'
    };
  }

  return null;
}

async function findLyrics(track, hints) {
  const lrclibDown = isApiDegraded('lrclib');

  // FIX: lastErrorType is shared/global state that used to leak across songs.
  // A single timeout on Song A would silently poison the fallback logic for
  // every Song B, C, D... after it until a request happened to succeed.
  // Reset it here so each song's lookup starts with a clean slate — it will
  // still get set correctly by real failures that happen DURING this lookup,
  // but no longer inherits stale failures from a previous, unrelated song.
  apiHealth.lrclib.lastErrorType = null;

  // ── PRIORITY 0: Fast cache-only lookup + parallel standard lookup ──
  // /api/get-cached returns in ~50-100ms — always safe, even when degraded.
  // We start the slower /api/get in parallel so it has a head start if cached misses.
  if (track.title && track.artist) {
    const cachedPromise = getLrclibCached(track);
    const directPromise = !lrclibDown ? getLrclibByMetadata(track) : null;

    const cached = await cachedPromise;
    if (cached && (cached.syncedLyrics || cached.plainLyrics)) {
      const isFake = cached.syncedLyrics && isFakeLRC(cached.syncedLyrics);
      if (!isFake) {
        return {
          lyrics: {
            synced: cached.syncedLyrics || '',
            plain: cleanPlainLyrics(cached.plainLyrics || ''),
            provider: 'LRCLIB'
          },
          match: cached
        };
      }
    }

    if (directPromise) {
      const direct = await directPromise;
      if (direct && (direct.syncedLyrics || direct.plainLyrics)) {
        const directIsFake = direct.syncedLyrics && isFakeLRC(direct.syncedLyrics);
        if (!directIsFake) {
          return {
            lyrics: {
              synced: direct.syncedLyrics || '',
              plain: cleanPlainLyrics(direct.plainLyrics || ''),
              provider: 'LRCLIB'
            },
            match: direct
          };
        }
      }
    }
  }

  // When LRCLIB is degraded, skip remaining slow endpoints and go to fallback
  if (!lrclibDown) {

    // If getLrclibByMetadata failed due to TIMEOUT, SERVER_ERROR, RATE_LIMITED, or NETWORK_ERROR, skip the rest of LRCLIB and jump straight to fallback APIs.
    const errType = apiHealth.lrclib.lastErrorType;
    if (!errType || errType === 'NOT_FOUND') {
      // PRIORITY 1b: Try with raw (uncleaned) metadata if cleaned version failed
      if (track.rawTitle && track.rawArtist && (track.rawTitle !== track.title || track.rawArtist !== track.artist)) {
        const rawTrack = { title: track.rawTitle, artist: track.rawArtist, album: track.album, durationMs: track.durationMs };
        const directRaw = await getLrclibByMetadata(rawTrack);
        if (directRaw && (directRaw.syncedLyrics || directRaw.plainLyrics)) {
          const isFake = directRaw.syncedLyrics && isFakeLRC(directRaw.syncedLyrics);
          if (!isFake) {
            return {
              lyrics: {
                synced: directRaw.syncedLyrics || '',
                plain: cleanPlainLyrics(directRaw.plainLyrics || ''),
                provider: 'LRCLIB'
              },
              match: directRaw
            };
          }
        }
      }
    }

    if (!apiHealth.lrclib.lastErrorType || apiHealth.lrclib.lastErrorType === 'NOT_FOUND') {
      // PRIORITY 2: Search — finds the best result across all available versions
      const queries = buildLyricQueries(track, hints);

      for (const query of queries) {
        const results = await searchLrclib(query);
        if (apiHealth.lrclib.lastErrorType && apiHealth.lrclib.lastErrorType !== 'NOT_FOUND') {
          break; // stop searching if LRCLIB starts timing out
        }
        const best = chooseBestLyricResult(results, track, hints);
        if (!best) continue;

        const full = await hydrateLrclibResult(best);
        const lyrics = {
          synced: full.syncedLyrics || '',
          plain: cleanPlainLyrics(full.plainLyrics || ''),
          provider: 'LRCLIB'
        };

        if (lyrics.synced || lyrics.plain) {
          return { lyrics, match: full };
        }
      }
    }

    if (!apiHealth.lrclib.lastErrorType || apiHealth.lrclib.lastErrorType === 'NOT_FOUND') {
      // PRIORITY 3: If search failed but direct had plain lyrics, use those
      if (track.title && track.artist) {
        const direct = await getLrclibByMetadata(track);
        if (direct && direct.plainLyrics) {
          return {
            lyrics: {
              synced: '',
              plain: cleanPlainLyrics(direct.plainLyrics),
              provider: 'LRCLIB'
            },
            match: direct
          };
        }
      }
    }
  }

  // PRIORITY 4: lyrics.ovh fallback — try cleaned, raw, and first-artist
  const artistsToTry = [
    track.artist,
    track.rawArtist,
    (track.artist || '').split(/[,&]/)[0].trim()
  ].filter((a, i, arr) => a && arr.indexOf(a) === i);
  const titlesToTry = [
    track.title,
    track.rawTitle
  ].filter((t, i, arr) => t && arr.indexOf(t) === i);

  for (const artist of artistsToTry) {
    for (const title of titlesToTry) {
      const fallbackUrl = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
      const result = await apiFetch(fallbackUrl, 'lyricsOvh', TIMEOUT_OVH_MS);
      if (result.ok && result.data && result.data.lyrics && result.data.lyrics.trim().length > 30) {
        return {
          lyrics: {
            synced: '',
            plain: cleanPlainLyrics(result.data.lyrics),
            provider: 'lyrics.ovh'
          },
          match: { trackName: title, artistName: artist }
        };
      }
      if (apiHealth.lyricsOvh.lastErrorType && apiHealth.lyricsOvh.lastErrorType !== 'NOT_FOUND') {
        break;
      }
    }
  }

  return null;
}

async function getLrclibByMetadata(track) {
  try {
    const DUR = track.durationMs > 0 ? String(Math.round(track.durationMs / 1000)) : null;
    const firstArtist = (track.artist || '').split(/[,&]|\bfeat\.?\b|\bft\.?\b/i)[0].trim();

    // Build primary query (with album + duration if available)
    const p1 = new URLSearchParams({ track_name: track.title, artist_name: track.artist });
    if (track.album) p1.set('album_name', track.album);
    if (DUR) p1.set('duration', DUR);

    // Build secondary query (no album, no duration)
    const p2 = new URLSearchParams({ track_name: track.title, artist_name: track.artist });

    // Fire both in parallel — use allSettled so a failure in one doesn't block the other
    const [r1, r2] = await Promise.allSettled([
      apiFetch(`${LRCLIB_BASE}/get?${p1.toString()}`, 'lrclib', TIMEOUT_GET_MS),
      apiFetch(`${LRCLIB_BASE}/get?${p2.toString()}`, 'lrclib', TIMEOUT_GET_MS)
    ]);

    // Prefer primary (with album/duration) over secondary
    if (r1.status === 'fulfilled' && r1.value.ok && r1.value.data && r1.value.data.id) return r1.value.data;
    if (r2.status === 'fulfilled' && r2.value.ok && r2.value.data && r2.value.data.id) return r2.value.data;

    // If LRCLIB failed due to a server error or timeout, do not waste time on the fallback query
    if (apiHealth.lrclib.lastErrorType && apiHealth.lrclib.lastErrorType !== 'NOT_FOUND') return null;

    // Fallback: first artist only (handles "Artist1, Artist2 feat. X" style)
    if (firstArtist && firstArtist !== track.artist) {
      const p4 = new URLSearchParams({ track_name: track.title, artist_name: firstArtist });
      const r4 = await apiFetch(`${LRCLIB_BASE}/get?${p4.toString()}`, 'lrclib', TIMEOUT_GET_MS);
      if (r4.ok && r4.data && r4.data.id) return r4.data;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fast cache-only LRCLIB lookup using /api/get-cached.
 * Returns in ~50-100ms on hit, fast 404 on miss. Does NOT trigger
 * expensive external-source queries like /api/get does.
 * Always safe to call even when API is degraded.
 * Requires exact track_name, artist_name, album_name, and duration.
 */
async function getLrclibCached(track) {
  if (!track.title || !track.artist) return null;
  const duration = track.durationMs > 0 ? String(Math.round(track.durationMs / 1000)) : null;
  if (!duration) return null; // duration is REQUIRED for /api/get-cached
  const params = new URLSearchParams({
    track_name: track.title,
    artist_name: track.artist,
    album_name: track.album || '',
    duration: duration
  });
  const result = await apiFetch(`${LRCLIB_BASE}/get-cached?${params.toString()}`, 'lrclib', TIMEOUT_CACHED_MS);
  if (result.ok && result.data && result.data.id) return result.data;
  return null;
}

function buildLyricQueries(track, hints) {
  const queries = [];
  const titleArtist = [track.artist, track.title].filter(Boolean).join(' ').trim();
  const artistTitle = [track.title, track.artist].filter(Boolean).join(' ').trim();
  const titleOnly  = track.title || '';
  const rawQuery   = track.query || '';
  const pageTitle  = cleanPageTitle(hints.pageTitle || '');

  // Also try with just the first artist (for multi-artist entries)
  const firstArtist = (track.artist || '').split(/[,&]|\bfeat\.?\b|\bft\.?\b/i)[0].trim();
  const firstArtistTitle = firstArtist ? `${firstArtist} ${track.title}` : '';

  [titleArtist, artistTitle, firstArtistTitle, titleOnly, rawQuery, pageTitle].forEach((q) => {
    const cleaned = cleanupSearchQuery(q);
    if (cleaned && !queries.includes(cleaned)) queries.push(cleaned);
  });

  return queries;
}

async function searchLrclib(query) {
  if (!query) return [];
  const url = `${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`;
  const result = await apiFetch(url, 'lrclib', TIMEOUT_SEARCH_MS);
  if (result.ok && Array.isArray(result.data)) return result.data;
  return [];
}

async function hydrateLrclibResult(result) {
  if ((result.syncedLyrics || result.plainLyrics) || !result.id) return result;
  const response = await apiFetch(`${LRCLIB_BASE}/get/${result.id}`, 'lrclib', TIMEOUT_SEARCH_MS);
  if (response.ok && response.data) return response.data;
  return result;
}

function chooseBestLyricResult(results, track, hints) {
  if (!Array.isArray(results) || !results.length) return null;
  const targetTitle    = normalizeText(track.title || track.query || hints.pageTitle || '');
  const targetArtist   = normalizeText(track.artist || '');
  const targetAlbum    = normalizeText(track.album || '');
  const targetDuration = secondsToMs(hints.duration) || track.durationMs || 0;

  const scored = results
    .map((item) => ({
      item,
      score: scoreLyricResult(item, targetTitle, targetArtist, targetAlbum, targetDuration)
    }))
    .sort((a, b) => b.score - a.score);

  // Lower threshold — 15 is enough to avoid completely wrong songs
  // while still allowing matches when artist name differs slightly
  return scored[0].score >= 15 ? scored[0].item : null;
}

function scoreLyricResult(item, targetTitle, targetArtist, targetAlbum, targetDurationMs) {
  const title  = normalizeText(item.trackName || item.name || '');
  const artist = normalizeText(item.artistName || '');
  const album  = normalizeText(item.albumName || '');
  let score = 0;

  // Synced lyrics bonus — but penalize fake/auto-generated LRC
  if (item.syncedLyrics) {
    if (isFakeLRC(item.syncedLyrics)) {
      score += 5;  // Has synced but they're fake — barely better than plain
    } else {
      score += 50; // Real synced lyrics — strongly prefer
    }
  }
  if (item.plainLyrics) score += 8;
  if (item.instrumental) score -= 100; // We want lyrics, so penalize instrumentals

  // Title matching
  if (targetTitle && title) {
    // Strip artist name from title field (some LRCLIB entries have "Artist - Title" as trackName)
    const cleanTitle = title.replace(targetArtist, '').trim();
    const cleanTarget = targetTitle.replace(targetArtist, '').trim();
    if (cleanTitle === cleanTarget || title === targetTitle) score += 30;
    else if (title.includes(targetTitle) || targetTitle.includes(title)) score += 22;
    else if (cleanTitle.includes(cleanTarget) || cleanTarget.includes(cleanTitle)) score += 20;
  }

  // Artist matching
  if (targetArtist && artist) {
    if (artist === targetArtist) score += 25;
    else if (artist.includes(targetArtist) || targetArtist.includes(artist)) score += 18;
    else {
      // Word-level matching: Spotify "Artist1, Artist2" vs LRCLIB "Artist1"
      const targetWords = targetArtist.split(/\s+/);
      const resultWords = artist.split(/\s+/);
      const overlap = targetWords.filter(w => w.length > 2 && resultWords.some(rw => rw.includes(w) || w.includes(rw)));
      if (overlap.length > 0) {
        score += 12; // partial artist match
      } else {
        score -= 15; // wrong artist, but don't over-penalize
      }
    }
  }

  // Album matching — strong signal when available
  if (targetAlbum && album) {
    if (album === targetAlbum) score += 20;
    else if (album.includes(targetAlbum) || targetAlbum.includes(album)) score += 12;
    // Penalize clearly wrong albums ("Videos", "Songs", "unknown", "null")
    if (/\b(videos?|songs?|unknown|null)\b/i.test(item.albumName || '')) score -= 8;
  }

  // Duration matching — critical for picking the right version
  const durationMs = secondsToMs(item.duration);
  if (targetDurationMs && durationMs) {
    const diff = Math.abs(targetDurationMs - durationMs);
    if (diff < 1500)       score += 22; // near-exact
    else if (diff < 3000)  score += 14;
    else if (diff < 6000)  score += 5;
    else                   score -= 30; // very wrong duration, sync WILL be off
  }

  return score;
}

/* ── Detect auto-generated / fake LRC timestamps ──
   Many LRCLIB entries have machine-generated timestamps with perfectly uniform gaps
   (e.g., every 5.2s or every 4.2s). Real synced lyrics have IRREGULAR gaps because
   actual song lines have different lengths. */
function isFakeLRC(syncedLyrics) {
  if (!syncedLyrics) return true;
  const times = [];
  const lines = syncedLyrics.split('\n');
  for (const line of lines) {
    const match = line.match(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/);
    if (match) {
      const ms = Number(match[1]) * 60000 + Number(match[2]) * 1000 +
        (match[3] ? Number(match[3].padEnd(3, '0').slice(0, 3)) : 0);
      times.push(ms);
    }
  }
  if (times.length < 6) return false; // too few lines to judge

  // Calculate gaps between consecutive timestamps
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < 5) return false;

  // Check 1: Do gaps have suspiciously low variance? (real lyrics have varied timing)
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / (mean || 1); // coefficient of variation

  // Real lyrics typically have CV > 0.3 (lots of variation)
  // Fake uniform timestamps have CV < 0.15
  if (cv < 0.12) return true;

  // Check 2: Does it start at exactly [00:00.00] with very first lyric text?
  // Real songs usually have intros — lyrics don't start at 0
  if (times[0] === 0 && times.length > 10) {
    // If all gaps are very uniform AND starts at 0, almost certainly fake
    if (cv < 0.25) return true;
  }

  return false;
}

/* ══════════════════════════════════════
   PAGE TITLE PARSING
   ══════════════════════════════════════ */
function parsePageTitle(title) {
  const cleaned = cleanPageTitle(title);
  if (!cleaned) return {};

  const spotifySplit = cleaned.split(' · ');
  if (spotifySplit.length >= 2) {
    return {
      title:  spotifySplit[0].trim(),
      artist: spotifySplit.slice(1).join(' ').trim(),
      query:  `${spotifySplit.slice(1).join(' ').trim()} ${spotifySplit[0].trim()}`
    };
  }

  // SoundCloud format: "Track Name by Artist Name" (after "| SoundCloud" is stripped)
  const byMatch = cleaned.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    return {
      title: byMatch[1].trim(),
      artist: byMatch[2].trim(),
      query: `${byMatch[2].trim()} ${byMatch[1].trim()}`
    };
  }

  for (const sep of [' - ', ' | ']) {
    const parts = cleaned.split(sep).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { artist: parts[0], title: parts[1], query: `${parts[0]} ${parts[1]}` };
    }
  }

  return { query: cleaned };
}

function cleanPageTitle(title) {
  return String(title || '')
    .replace(/\s*-\s*YouTube Music\s*$/i, '')
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .replace(/\s*\|\s*Spotify\s*$/i, '')
    .replace(/\s*·\s*Spotify\s*$/i, '')
    .replace(/\s*-\s*Spotify\s*$/i, '')
    .replace(/\s*[|\u00b7-]\s*SoundCloud\s*$/i, '')
    .replace(/^Stream\s+/i, '')
    .replace(/\s*\|\s*Listen\s.*$/i, '')
    .replace(/\[[^\]]*(official|lyrics?|visualizer|audio|video|mv)[^\]]*\]/gi, '')
    .replace(/\([^)]*(official|lyrics?|visualizer|audio|video|mv)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanupSearchQuery(query) {
  return cleanPageTitle(query)
    .replace(/\b(official|lyrics?|visualizer|audio|video|mv|hd|4k|feat\.?|ft\.?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Clean Spotify metadata before LRCLIB lookup ── */
function cleanTrackTitle(title) {
  return String(title || '')
    // Remove parenthetical extras: (feat. X), (Remix), (Deluxe), (Explicit), etc.
    .replace(/\s*\((?:feat\.?|ft\.?|with|prod\.?)[^)]*\)/gi, '')
    .replace(/\s*\[(?:feat\.?|ft\.?|with|prod\.?)[^]]*\]/gi, '')
    // Remove remaster/reissue/deluxe/explicit tags
    .replace(/\s*[-–]\s*(?:remaster(?:ed)?|reissue|deluxe|explicit|clean|radio edit|single version|album version).*$/gi, '')
    .replace(/\s*\((?:remaster(?:ed)?|reissue|deluxe|explicit|clean|radio edit|single|album)\s*(?:version|edition|mix)?\s*(?:\d{4})?\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtistName(artist) {
  return String(artist || '')
    .replace(/\s*(?:feat\.?|ft\.?|with)[,&]\s+.*/i, '')
    .replace(/[,&]\s+.*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanPlainLyrics(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[0-9:.]+\]/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

/* ══════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════ */
function normalizeHints(hints) {
  return {
    url:       stringValue(hints.url),
    host:      stringValue(hints.host),
    pageTitle: stringValue(hints.pageTitle),
    track:     cleanMaybe(hints.track),
    artist:    cleanMaybe(hints.artist),
    album:     cleanMaybe(hints.album),
    currentTime: finiteNumber(hints.currentTime),
    duration:    finiteNumber(hints.duration)
  };
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function displayTrack(track) {
  return [track.artist, track.title || track.query].filter(Boolean).join(' - ');
}

function secondsToMs(seconds) {
  const n = Number(seconds || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1000);
}

function cleanMaybe(value)  { return String(value || '').replace(/\s+/g, ' ').trim(); }
function stringValue(value) { return typeof value === 'string' ? value : ''; }
function finiteNumber(value){ const n = Number(value); return Number.isFinite(n) ? n : null; }

/* ══════════════════════════════════════
   CONTENT SCRIPT INJECTION
   ══════════════════════════════════════ */
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  } catch {}

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch {
    return false;
  }
}

async function getPageHints(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'LV_GET_HINTS' });
    return response || {};
  } catch {
    return {};
  }
}

/* ══════════════════════════════════════
   RECOGNITION RESULT HANDLER
   ══════════════════════════════════════ */
async function handleRecognitionResult(tabId, payload) {
  if (!payload || !payload.ok) {
    sendToTab(tabId, {
      type: 'LV_ERROR',
      text: payload && payload.message ? payload.message : 'Song not recognized.'
    });
    return;
  }

  if (!hasUsableLyrics(payload)) {
    sendToTab(tabId, {
      type: 'LV_ERROR',
      text: payload.message || 'Song found, but no synced lyrics were available.'
    });
    return;
  }

  const session = sessions.get(tabId);
  if (session) session.active = true;

  // Success — cancel any pending background auto-retry for this tab
  clearTimeout(autoRetryTimers.get(tabId));
  autoRetryTimers.delete(tabId);

  sendToTab(tabId, { type: 'LV_TRACK', payload });
}

function hasUsableLyrics(payload) {
  return Boolean(payload && payload.lyrics && (payload.lyrics.synced || payload.lyrics.plain));
}

function sendToTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}
