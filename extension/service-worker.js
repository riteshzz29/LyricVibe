const LRCLIB_BASE = 'https://lrclib.net/api';
const sessions = new Map();

/* ── Lyrics cache: in-memory + chrome.storage.session so it survives
   service-worker suspension (MV3 workers die after ~30s idle) ── */
const lyricsCache = new Map();
const CACHE_MAX = 60;

function cacheKey(track, artist) {
  return `${(artist || '').toLowerCase().trim()}|${(track || '').toLowerCase().trim()}`;
}

async function getCachedLyrics(track, artist) {
  const key = cacheKey(track, artist);
  if (lyricsCache.has(key)) return lyricsCache.get(key);
  // Fall back to session storage (survives SW restarts within the browser session)
  try {
    const stored = await chrome.storage.session.get(`lvxCache:${key}`);
    const hit = stored[`lvxCache:${key}`];
    if (hit) {
      lyricsCache.set(key, hit);
      return hit;
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
  try {
    chrome.storage.session.set({ [`lvxCache:${key}`]: payload });
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

  if (message.type === 'LV_SPOTIFY_TRACK_CHANGED' && sender.tab && sender.tab.id) {
    startSession(sender.tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
});

/* ══════════════════════════════════════
   SESSION MANAGEMENT
   ══════════════════════════════════════ */
async function startSession(tab) {
  const tabId = tab.id;
  sessions.set(tabId, { active: true });

  await injectOverlay(tabId);
  sendToTab(tabId, { type: 'LV_STATUS', text: 'Detecting song...' });

  const hints = await getPageHints(tabId);
  const isSpotify = (hints.host || '').includes('spotify.com');

  // STEP 0: Check cache first (instant)
  if (hints.track) {
    const cached = await getCachedLyrics(hints.track, hints.artist);
    if (cached) {
      // Update playOffsetMs from current hints
      if (cached.track && hints.currentTime != null) {
        cached.track.playOffsetMs = Math.round((hints.currentTime || 0) * 1000);
      }
      await handleRecognitionResult(tabId, cached);
      return;
    }
  }

  // STEP 1: Try metadata detection directly (no server)
  const metadataResult = await recognize({ mode: 'metadata', hints });

  if (metadataResult && metadataResult.ok && hasUsableLyrics(metadataResult)) {
    await handleRecognitionResult(tabId, metadataResult);
    return;
  }

  // STEP 2: Spotify — metadata only with progressive retry (SPA needs time to settle)
  if (isSpotify) {
    const retryDelays = [200, 500, 1000, 2000, 3500];
    let lastDetectedTrack = '';
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      await new Promise((r) => setTimeout(r, retryDelays[attempt]));

      // Re-inject in case SPA navigation dropped our content script
      if (attempt >= 2) {
        try { await injectOverlay(tabId); } catch (_) {}
      }

      const retryHints = await getPageHints(tabId);
      if (retryHints.track || retryHints.pageTitle) {
        lastDetectedTrack = retryHints.track || retryHints.pageTitle || '';
        sendToTab(tabId, { type: 'LV_STATUS', text: `Searching lyrics for: ${lastDetectedTrack}` });
        const retryResult = await recognize({ mode: 'metadata', hints: retryHints });
        if (retryResult && retryResult.ok && hasUsableLyrics(retryResult)) {
          await handleRecognitionResult(tabId, retryResult);
          return;
        }
      }
    }
    sendToTab(tabId, {
      type: 'LV_ERROR',
      text: lastDetectedTrack
        ? `Lyrics not available for "${lastDetectedTrack}". This song may not be in any lyrics database.`
        : 'Could not find lyrics for this Spotify track. Make sure a song is playing and try again.'
    });
    return;
  }

  // STEP 3: Generic sites — retry metadata a few times (SPAs may need time to settle)
  const genericDelays = [400, 1000, 2200];
  let lastTrack = hints.track || hints.pageTitle || '';
  for (const delay of genericDelays) {
    await new Promise((r) => setTimeout(r, delay));
    const retryHints = await getPageHints(tabId);
    lastTrack = retryHints.track || retryHints.pageTitle || lastTrack;
    if (lastTrack) {
      sendToTab(tabId, { type: 'LV_STATUS', text: `Searching lyrics for: ${lastTrack}` });
    }
    const retryResult = await recognize({ mode: 'metadata', hints: retryHints });
    if (retryResult && retryResult.ok && hasUsableLyrics(retryResult)) {
      await handleRecognitionResult(tabId, retryResult);
      return;
    }
  }

  sendToTab(tabId, {
    type: 'LV_ERROR',
    text: lastTrack
      ? `No lyrics found for "${lastTrack}". This song may not be in the lyrics database yet.`
      : 'Could not detect a song on this page. Works best on YouTube Music, Spotify, and SoundCloud.'
  });
}

async function stopSession(tabId, reason) {
  sessions.delete(tabId);
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

  const lyricResult = await findLyrics(detected, hints);

  if (!lyricResult) {
    return {
      ok: false,
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
    lyricsProvider: 'LRCLIB'
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
  // PRIORITY 1: LRCLIB direct metadata lookup — most accurate
  if (track.title && track.artist) {
    const direct = await getLrclibByMetadata(track);
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

  // PRIORITY 2: Search — finds the best result across all available versions
  const queries = buildLyricQueries(track, hints);

  for (const query of queries) {
    const results = await searchLrclib(query);
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
      try {
        const fallbackUrl = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(fallbackUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          if (data && data.lyrics && data.lyrics.trim().length > 30) {
            return {
              lyrics: {
                synced: '',
                plain: cleanPlainLyrics(data.lyrics),
                provider: 'lyrics.ovh'
              },
              match: { trackName: title, artistName: artist }
            };
          }
        }
      } catch (e) {
        // Ignore fallback errors
      }
    }
  }

  return null;
}

async function getLrclibByMetadata(track) {
  try {
    const params = new URLSearchParams();
    params.set('track_name', track.title);
    params.set('artist_name', track.artist);
    if (track.album) params.set('album_name', track.album);
    if (track.durationMs > 0) {
      params.set('duration', String(Math.round(track.durationMs / 1000)));
    }
    const response = await fetch(`${LRCLIB_BASE}/get?${params.toString()}`, {
      headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
    });
    if (response.ok) {
      const data = await response.json();
      if (data && data.id) return data;
    }

    // Retry without album
    if (track.album) {
      const p2 = new URLSearchParams();
      p2.set('track_name', track.title);
      p2.set('artist_name', track.artist);
      if (track.durationMs > 0) p2.set('duration', String(Math.round(track.durationMs / 1000)));
      const r2 = await fetch(`${LRCLIB_BASE}/get?${p2.toString()}`, {
        headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
      });
      if (r2.ok) {
        const d2 = await r2.json();
        if (d2 && d2.id) return d2;
      }
    }

    // Retry without duration (Spotify duration may not match LRCLIB)
    if (track.durationMs > 0) {
      const p3 = new URLSearchParams();
      p3.set('track_name', track.title);
      p3.set('artist_name', track.artist);
      const r3 = await fetch(`${LRCLIB_BASE}/get?${p3.toString()}`, {
        headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
      });
      if (r3.ok) {
        const d3 = await r3.json();
        if (d3 && d3.id) return d3;
      }
    }

    // Retry with just the first artist (Spotify: "Artist1, Artist2" → "Artist1")
    const firstArtist = (track.artist || '').split(/[,&]|\bfeat\.?\b|\bft\.?\b/i)[0].trim();
    if (firstArtist && firstArtist !== track.artist) {
      const p4 = new URLSearchParams();
      p4.set('track_name', track.title);
      p4.set('artist_name', firstArtist);
      const r4 = await fetch(`${LRCLIB_BASE}/get?${p4.toString()}`, {
        headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
      });
      if (r4.ok) {
        const d4 = await r4.json();
        if (d4 && d4.id) return d4;
      }
    }

    return null;
  } catch {
    return null;
  }
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
  try {
    const url = `${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
    });
    if (!response.ok) return [];
    const json = await response.json();
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

async function hydrateLrclibResult(result) {
  if ((result.syncedLyrics || result.plainLyrics) || !result.id) return result;
  try {
    const response = await fetch(`${LRCLIB_BASE}/get/${result.id}`, {
      headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
    });
    if (!response.ok) return result;
    return response.json();
  } catch {
    return result;
  }
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

  for (const sep of [' - ', ' | ', ' by ']) {
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
    .replace(/\s*\|\s*SoundCloud\s*$/i, '')
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

  sendToTab(tabId, { type: 'LV_TRACK', payload });
}

function hasUsableLyrics(payload) {
  return Boolean(payload && payload.lyrics && (payload.lyrics.synced || payload.lyrics.plain));
}

function sendToTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}
