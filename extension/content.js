(function initLyricVibeOverlay() {
  /* ══════════════════════════════════════
     CONSTANTS & CONFIG
     ══════════════════════════════════════ */
  const DEFAULT_SYNC_OFFSET_MS = -80;
  const SYNC_NUDGE_MS = 80;
  const THEMES = ['samay', 'hype', 'soft', 'neon', 'clean', 'retro', 'glass', 'fire', 'elegant', 'aurora', 'matrix', 'vinyl', 'cosmic'];
  const THEME_LABELS = {
    samay: 'SAMAY', hype: 'HYPE', soft: 'SOFT', neon: 'NEON',
    clean: 'CLEAN', retro: 'RETRO', glass: 'GLASS', fire: 'FIRE', elegant: 'ELEGANT',
    aurora: 'AURORA', matrix: 'MATRIX', vinyl: 'VINYL', cosmic: 'COSMIC'
  };
  const ANIMATIONS = ['slam', 'fade-up', 'scale-pop', 'slide-left', 'slide-right', 'blur-in', 'glitch', 'typewriter', 'shatter', 'wave'];

  const SETUP_OPENERS = new Set([
    'after', 'although', 'and', 'as', 'before', 'because', 'but', 'even',
    'if', 'i', 'just', 'maybe', 'my', 'now', 'once', 'she', 'since', 'so',
    'still', 'that', 'the', 'then', 'they', 'though', 'till', 'until',
    'when', 'while', 'with', 'you'
  ]);
  const TAG_OPENERS = new Set(['is', 'are', 'was', 'were', 'not', 'no', 'never', 'only', 'all']);

  /* If overlay already exists, just show it */
  if (window.__lyricVibeOverlay && window.__lyricVibeOverlay.show) {
    window.__lyricVibeOverlay.show();
    return;
  }

  /* ══════════════════════════════════════
     STATE
     ══════════════════════════════════════ */
  const state = {
    active: false,
    lines: [],
    currentIndex: -1,
    currentMoment: null,
    revealTimers: [],
    rafId: 0,
    hudTimer: 0,
    trackTitle: '',
    lyricSource: '',
    syncOffsetMs: DEFAULT_SYNC_OFFSET_MS,
    fallbackStartMs: 0,
    fallbackMediaStartMs: 0,
    theme: 'samay',
    // Sync tracking for auto-adjustment
    lastMediaTime: 0,
    lastWallTime: 0,
    mediaDriftSamples: [],
    playbackRate: 1,
    // Real-time auto-calibration
    timingErrors: [],        // recent render timing errors vs LRC timestamp
    autoCalibrated: false,   // true after first calibration pass
    baseOffsetMs: DEFAULT_SYNC_OFFSET_MS, // original computed offset
    // Spotify-specific: polling for time from DOM
    spotifyPollInterval: 0,
    spotifyCurrentTimeMs: 0,
    spotifyLastPollWall: 0,
    spotifyPauseDetected: false,
    spotifyNullCount: 0,       // count of consecutive null time reads
    spotifyLastGoodWall: 0,    // last wall time when we got a non-null read
    isSpotify: false,
    // New: user preferences & track context
    fontScale: 1,              // user font size multiplier (+/- keys)
    liteMode: false,           // see-through mode (B key)
    trackKey: '',              // cache key for per-song offset memory
    trackDurationMs: 0,        // for the progress bar
    offsetWasRestored: false,  // true if offset loaded from per-song memory
    errorShown: false          // true when error screen is up (observer stays active)
  };

  /* ══════════════════════════════════════
     DOM CONSTRUCTION
     ══════════════════════════════════════ */
  const root = document.createElement('div');
  root.id = 'lvx-root';

  const stage = document.createElement('div');
  stage.className = 'lvx-stage';

  const hud = document.createElement('div');
  hud.className = 'lvx-hud';

  const hudLabel = document.createElement('span');
  hudLabel.className = 'lvx-hud-label';
  hudLabel.textContent = 'LYRICVIBE';

  const hudText = document.createElement('span');
  hudText.className = 'lvx-hud-text';
  hudText.textContent = 'Ready';

  const stopButton = document.createElement('button');
  stopButton.className = 'lvx-stop';
  stopButton.textContent = '✕';
  stopButton.title = 'Stop LyricVibe (Esc)';
  stopButton.addEventListener('click', () => {
    try { chrome.runtime?.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {}); } catch (_) {}
    teardown();
  });

  const themeButton = document.createElement('button');
  themeButton.className = 'lvx-theme-btn';
  themeButton.textContent = 'SAMAY';
  themeButton.title = 'Cycle theme (T)';
  themeButton.addEventListener('click', () => cycleTheme());

  const syncEarlier = document.createElement('button');
  syncEarlier.className = 'lvx-sync-btn';
  syncEarlier.textContent = '[ ←';
  syncEarlier.title = 'Lyrics earlier ([)';
  syncEarlier.addEventListener('click', () => nudgeSync(-SYNC_NUDGE_MS));

  const syncLater = document.createElement('button');
  syncLater.className = 'lvx-sync-btn';
  syncLater.textContent = '→ ]';
  syncLater.title = 'Lyrics later (])';
  syncLater.addEventListener('click', () => nudgeSync(SYNC_NUDGE_MS));

  hud.append(hudLabel, hudText, syncEarlier, syncLater, themeButton, stopButton);

  /* Next-line preview (bottom center) */
  const preview = document.createElement('div');
  preview.className = 'lvx-preview';

  /* Song progress bar (bottom edge) */
  const progress = document.createElement('div');
  progress.className = 'lvx-progress';
  const progressFill = document.createElement('div');
  progressFill.className = 'lvx-progress-fill';
  progress.appendChild(progressFill);

  root.append(stage, preview, progress, hud);
  document.documentElement.appendChild(root);

  window.__lyricVibeOverlay = {
    show,
    hide: teardown,
    hints: getPageHints
  };

  setHud('Ready. Play music, then click LyricVibe.', false, true);

  /* Load saved preferences (theme, font scale, lite mode) */
  try {
    chrome.storage.local.get(['lvxTheme', 'lvxFontScale', 'lvxLiteMode'], (result) => {
      if (result && result.lvxTheme && THEMES.includes(result.lvxTheme)) {
        applyTheme(result.lvxTheme);
      }
      if (result && Number.isFinite(result.lvxFontScale)) {
        state.fontScale = clamp(result.lvxFontScale, 0.6, 1.6);
      }
      if (result && result.lvxLiteMode) {
        state.liteMode = true;
        root.classList.add('lvx-lite');
      }
    });
  } catch (_) {}

  /* Detect if we're on Spotify */
  state.isSpotify = location.hostname.includes('spotify.com');

  /* Universal track-change observer: auto-refresh when song changes
     on ANY supported platform (YouTube Music, SoundCloud, Spotify, etc.) */
  setupTrackChangeObserver();

  /* ══════════════════════════════════════
     MESSAGE LISTENER
     ══════════════════════════════════════ */
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return; // extension context invalidated
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'LV_GET_HINTS') {
      sendResponse(getPageHints());
      return true;
    }

    if (message.type === 'LV_STATUS') {
      setHud(message.text || 'Working...');
    }

    if (message.type === 'LV_ERROR') {
      // Soft teardown: stop playback loop but KEEP overlay open and
      // KEEP the observer active so it can auto-recover on the next track.
      clearRevealTimers();
      cancelLoop();
      stopSpotifyPolling();
      state.currentIndex = -1;
      state.currentMoment = null;
      state.errorShown = true; // observer stays active to catch next song

      show();
      const errorMsg = message.text || 'Lyrics not available';
      stage.innerHTML = '';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'lvx-not-available';
      errorDiv.textContent = errorMsg;
      stage.appendChild(errorDiv);
      progressFill.style.width = '0%';
      preview.textContent = '';
      root.classList.add('lvx-active');
      setHud(`${errorMsg}  ·  Will retry on next track`, true, true);
    }

    if (message.type === 'LV_TRACK') {
      startTrack(message.payload);
    }

    if (message.type === 'LV_STOP') {
      teardown();
    }
  });

  document.addEventListener('keydown', handleKeys, true);
  window.addEventListener('resize', () => {
    if (state.currentMoment) fitMoment(state.currentMoment);
  });

  /* ══════════════════════════════════════
     PAGE HINTS (works for YT, Spotify, SC, etc.)
     ══════════════════════════════════════ */
  function getPageHints() {
    const media = getMedia();
    const url = location.href;
    const title = document.title || '';
    const host = location.hostname;
    const hints = {
      url,
      host,
      pageTitle: title,
      currentTime: media && Number.isFinite(media.currentTime) ? media.currentTime : null,
      duration: media && Number.isFinite(media.duration) ? media.duration : null
    };

    if (host.includes('music.youtube.com')) {
      hints.track = textFrom('.title.ytmusic-player-bar') ||
        textFrom('ytmusic-player-bar .title') ||
        textFrom('yt-formatted-string.title');
      hints.artist = textFrom('.byline.ytmusic-player-bar a') ||
        textFrom('ytmusic-player-bar .byline a');
      // Try to get album from YouTube Music
      hints.album = textFrom('ytmusic-player-bar .byline a:nth-child(3)') ||
        textFrom('ytmusic-player-bar .subtitle a[href*="browse/"]') || '';
    } else if (host.includes('youtube.com')) {
      hints.track = textFrom('h1 yt-formatted-string') ||
        textFrom('h1.title') ||
        title.replace(/ - YouTube$/i, '');
    } else if (host.includes('spotify.com')) {
      /* ── SPOTIFY RESILIENT SELECTORS (2026) ── */
      hints.track = spotifyGetTrack(title);
      hints.artist = spotifyGetArtist(title);
      hints.album = spotifyGetAlbum();

      // Spotify time from DOM (no <audio>/<video> element exposed)
      const spotifyTime = getSpotifyCurrentTimeFromDom();
      if (spotifyTime !== null) {
        hints.currentTime = spotifyTime / 1000;
      }
      const spotifyDuration = getSpotifyDurationFromDom();
      if (spotifyDuration !== null) {
        hints.duration = spotifyDuration / 1000;
      }
    } else if (host.includes('soundcloud.com')) {
      hints.track = textFrom('.playbackSoundBadge__titleLink') ||
        textFrom('.soundTitle__title');
      hints.artist = textFrom('.playbackSoundBadge__lightLink') ||
        textFrom('.soundTitle__username');
    }

    // Stable key so the service worker can tell whether the page DOM
    // has caught up to a new track yet (prevents reading stale data).
    const t = (hints.track || hints.pageTitle || '').trim();
    const a = (hints.artist || '').trim();
    hints.trackKey = t ? `${t}|||${a}` : '';

    return hints;
  }

  /* ══════════════════════════════════════
     SPOTIFY DOM HELPERS — multi-strategy cascade
     ══════════════════════════════════════ */
  function spotifyGetPlayerRoot() {
    return document.querySelector('[data-testid="now-playing-widget"]') ||
           document.querySelector('[data-testid="now-playing-bar"]') ||
           document.querySelector('footer') ||
           null;
  }

  function spotifyGetTrack(pageTitle) {
    // Strategy 1: data-testid selectors
    let t = textFrom('[data-testid="context-item-info-title"]') ||
            textFrom('[data-testid="now-playing-widget"] [data-testid="context-item-info-title"]') ||
            textFrom('[data-testid="context-item-link"] [dir="auto"]');
    if (t) return t;

    // Strategy 2: Links in now-playing widget (non-artist links)
    const root = spotifyGetPlayerRoot();
    if (root) {
      // First try links to /track/ paths
      for (const link of root.querySelectorAll('a[href*="/track/"]')) {
        const txt = link.textContent.trim();
        if (txt && txt.length > 1) return txt;
      }
      // Then try first non-artist, non-album link
      for (const link of root.querySelectorAll('a')) {
        const txt = link.textContent.trim();
        const href = link.href || '';
        if (txt && txt.length > 1 && !href.includes('/artist/') && !href.includes('/album/') && !href.includes('/playlist/')) return txt;
      }
      // Try any [dir="auto"] text node (Spotify uses this for song titles)
      const dirAuto = root.querySelector('[dir="auto"]');
      if (dirAuto) {
        const txt = dirAuto.textContent.trim();
        if (txt && txt.length > 1) return txt;
      }
    }

    // Strategy 3: Page title parsing
    if (pageTitle) {
      const parsed = parseSpotifyTitle(pageTitle);
      if (parsed.track) return parsed.track;
    }
    return '';
  }

  function spotifyGetArtist(pageTitle) {
    // Strategy 1: data-testid selectors
    let a = textFrom('[data-testid="context-item-info-subtitles"]') ||
            textFrom('[data-testid="context-item-info-artist"]');
    if (a) return a;

    // Strategy 2: Links to /artist/ in player root
    const root = spotifyGetPlayerRoot();
    if (root) {
      const artistLinks = root.querySelectorAll('a[href*="/artist/"]');
      const names = [];
      for (const link of artistLinks) {
        const txt = link.textContent.trim();
        if (txt && txt.length > 1) names.push(txt);
      }
      if (names.length) return names.join(', ');
    }

    // Strategy 3: Page title parsing
    if (pageTitle) {
      const parsed = parseSpotifyTitle(pageTitle);
      if (parsed.artist) return parsed.artist;
    }
    return '';
  }

  function spotifyGetAlbum() {
    const root = spotifyGetPlayerRoot();
    if (!root) return '';
    for (const link of root.querySelectorAll('a[href*="/album/"]')) {
      const txt = link.textContent.trim();
      if (txt && txt.length > 1) return txt;
    }
    return '';
  }

  function parseSpotifyTitle(title) {
    let cleaned = (title || '')
      .replace(/\s*[|·•]\s*Spotify\s*$/i, '')
      .replace(/\s*-\s*Spotify\s*$/i, '')
      .trim();
    const dotSplit = cleaned.split(' · ');
    if (dotSplit.length >= 2) {
      return { track: dotSplit[0].trim(), artist: dotSplit.slice(1).join(' ').trim() };
    }
    const dashSplit = cleaned.split(' - ');
    if (dashSplit.length >= 2) {
      return { track: dashSplit[1].trim(), artist: dashSplit[0].trim() };
    }
    return { track: cleaned, artist: '' };
  }

  /* ══════════════════════════════════════
     SPOTIFY TIME READING — multi-source with progress bar fill
     ══════════════════════════════════════ */
  function getSpotifyCurrentTimeFromDom() {
    // Source 1: data-testid time text
    const el = document.querySelector('[data-testid="playback-position"]');
    if (el) {
      const ms = parseTimeString(el.textContent);
      if (ms !== null) return ms;
    }

    // Source 2: input[type="range"] on progress bar
    const bar = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]') ||
                document.querySelector('.playback-bar input[type="range"]') ||
                document.querySelector('[data-testid="progress-bar"] input[type="range"]');
    if (bar) {
      const val = parseFloat(bar.value);
      const max = parseFloat(bar.max);
      if (Number.isFinite(val) && Number.isFinite(max) && max > 0) {
        return max > 600000 ? val : val * 1000;
      }
    }

    // Source 3: progress bar fill width ratio × duration
    const dur = getSpotifyDurationFromDom();
    if (dur !== null && dur > 0) {
      // Try the progress bar fill div
      const progressTrack = document.querySelector('[data-testid="playback-progressbar"]') ||
                             document.querySelector('[data-testid="progress-bar"]') ||
                             document.querySelector('.playback-bar');
      if (progressTrack) {
        const fill = progressTrack.querySelector('[style*="width"]') ||
                     progressTrack.querySelector('[data-testid="progress-bar-fill"]') ||
                     progressTrack.querySelector('div > div');
        if (fill) {
          const style = fill.getAttribute('style') || '';
          const widthMatch = style.match(/width:\s*([\d.]+)%/) ||
                             style.match(/transform:\s*translateX\(([-\d.]+)%\)/);
          if (widthMatch) {
            const pct = Math.abs(parseFloat(widthMatch[1])) / 100;
            if (pct >= 0 && pct <= 1) return Math.round(dur * pct);
          }
          // Try computed width ratio
          const trackRect = progressTrack.getBoundingClientRect();
          const fillRect = fill.getBoundingClientRect();
          if (trackRect.width > 0 && fillRect.width > 0) {
            const ratio = fillRect.width / trackRect.width;
            if (ratio >= 0 && ratio <= 1) return Math.round(dur * ratio);
          }
        }
      }
    }

    // Source 4: scan footer spans for time-like text
    const footerTimes = document.querySelectorAll('footer span, [data-testid="now-playing-bar"] span');
    for (const span of footerTimes) {
      const ms = parseTimeString(span.textContent);
      if (ms !== null) return ms;
    }
    return null;
  }

  function getSpotifyDurationFromDom() {
    const el = document.querySelector('[data-testid="playback-duration"]');
    if (el) return parseTimeString(el.textContent);
    // Fallback: input max on range
    const bar = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]') ||
                document.querySelector('.playback-bar input[type="range"]');
    if (bar) {
      const max = parseFloat(bar.max);
      if (Number.isFinite(max) && max > 0) return max > 600000 ? max : max * 1000;
    }
    // Fallback: second time string in footer
    const spans = document.querySelectorAll('footer span, [data-testid="now-playing-bar"] span');
    let found = 0;
    for (const span of spans) {
      const ms = parseTimeString(span.textContent);
      if (ms !== null) { found++; if (found === 2) return ms; }
    }
    return null;
  }

  /* ── Spotify Pause Detection ── */
  function isSpotifyPaused() {
    // ONLY check the main playback play/pause button — NOT any other "Play" button on the page
    // (Spotify has many buttons like "Shuffle Play", playlist "Play" etc.)
    const btn = document.querySelector('[data-testid="control-button-playpause"]');
    if (btn) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label === 'play' || label === 'play song') return true;
      if (label === 'pause' || label === 'pause song') return false;
      // Partial match but only exact play/pause context
      if (/^play$/i.test(label.trim())) return true;
      if (/^pause$/i.test(label.trim())) return false;
    }
    // Fallback: only trust stale-time detection (set by polling)
    return state.spotifyPauseDetected || false;
  }

  function parseTimeString(str) {
    if (!str) return null;
    const clean = str.trim();
    if (!/^\d+:\d{2}(:\d{2})?$/.test(clean)) return null;
    const parts = clean.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    return null;
  }

  function textFrom(selector) {
    try {
      const node = document.querySelector(selector);
      return node ? node.textContent.trim().replace(/\s+/g, ' ') : '';
    } catch (_) { return ''; }
  }

  function getMedia() {
    const candidates = [...document.querySelectorAll('video, audio')];
    return candidates.find((item) => Number.isFinite(item.currentTime) && item.duration) ||
      candidates.find((item) => Number.isFinite(item.currentTime)) ||
      null;
  }

  /* ══════════════════════════════════════
     SPOTIFY TIME POLLING — resilient, pause-aware
     ══════════════════════════════════════ */
  function startSpotifyPolling() {
    stopSpotifyPolling();
    if (!state.isSpotify) return;

    let staleCount = 0;
    state.spotifyNullCount = 0;

    state.spotifyPollInterval = setInterval(() => {
      const ms = getSpotifyCurrentTimeFromDom();

      // Handle null reads (DOM not ready or element disappeared)
      if (ms === null) {
        state.spotifyNullCount++;
        // After 10 null reads (2s), don't freeze — keep interpolating from last good value
        // After 50 null reads (10s), mark as stalled
        if (state.spotifyNullCount > 50 && !state.spotifyPauseDetected) {
          state.spotifyPauseDetected = true;
        }
        return;
      }

      // Got a valid read
      state.spotifyNullCount = 0;
      state.spotifyLastGoodWall = performance.now();

      if (ms !== state.spotifyCurrentTimeMs) {
        // Time value changed — music is playing, re-anchor interpolation
        state.spotifyCurrentTimeMs = ms;
        state.spotifyLastPollWall = performance.now();
        state.spotifyPauseDetected = false;
        staleCount = 0;
      } else {
        staleCount++;
        // Spotify text updates ~1x/sec, polling at 200ms = ~5 polls per text change
        // If stale for 30+ polls (~6 seconds), THEN check the pause button
        if (staleCount > 30) {
          const btnPaused = isSpotifyPaused();
          if (btnPaused) {
            state.spotifyPauseDetected = true;
            state.spotifyLastPollWall = performance.now();
          } else {
            state.spotifyPauseDetected = false;
          }
          staleCount = 20; // Reset slightly so we don't spam the button check
        }
      }
    }, 200);
  }

  function stopSpotifyPolling() {
    if (state.spotifyPollInterval) {
      clearInterval(state.spotifyPollInterval);
      state.spotifyPollInterval = 0;
    }
  }

  /* ══════════════════════════════════════
     UNIVERSAL TRACK CHANGE OBSERVER
     Works on Spotify, YouTube Music, SoundCloud, plain YouTube, etc.
     ══════════════════════════════════════ */
  function setupTrackChangeObserver() {
    let lastTrackKey = '';
    let debounceTimer = 0;
    let mediaHooked = null;

    /* Build a stable key for the currently playing track from page hints. */
    const currentTrackKey = () => {
      const h = getPageHints();
      const track = (h.track || h.pageTitle || '').trim();
      const artist = (h.artist || '').trim();
      return track ? `${track}|||${artist}` : '';
    };

    const checkTrackChange = () => {
      // React while playing OR while showing the error screen
      // (so a previously-unmatched song can recover on the next track).
      const listening = state.active || state.errorShown;
      if (!listening) {
        // Keep lastTrackKey current so the first real change isn't missed
        const k = currentTrackKey();
        if (k) lastTrackKey = k;
        return;
      }

      const key = currentTrackKey();
      if (!key) return;

      if (key !== lastTrackKey) {
        const prevKey = lastTrackKey;
        lastTrackKey = key;

        if (state.isSpotify) {
          // SPOTIFY: use the proven stop → delay → restart flow
          try {
            chrome.runtime?.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {});
            setTimeout(() => {
              try { chrome.runtime?.sendMessage({ type: 'LV_SPOTIFY_TRACK_CHANGED' }).catch(() => {}); } catch (_) {}
            }, 500);
          } catch (_) {}
        } else {
          // NON-SPOTIFY: send generic track-changed with prevKey for stale-data prevention
          try {
            chrome.runtime?.sendMessage({ type: 'LV_TRACK_CHANGED', prevKey: prevKey || '' }).catch(() => {});
          } catch (_) {}
        }
      }
    };

    // Platform-aware debounce: Spotify DOM mutates heavily during transitions,
    // so use 300ms (proven safe). Other platforms use 120ms for snappier reaction.
    const debounceMs = state.isSpotify ? 300 : 120;
    const debouncedCheck = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkTrackChange, debounceMs);
    };

    /* 1) Watch the DOM — covers SPAs (Spotify, YT Music) that swap the
          now-playing text without a full navigation. */
    const observer = new MutationObserver(debouncedCheck);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    /* 2) Watch the <title> — most music sites update it on track change. */
    const titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(debouncedCheck).observe(titleEl, { childList: true, characterData: true });
    }

    /* 3) Hook the <video>/<audio> element directly. The most reliable signal
          for a new track on YouTube / YouTube Music / SoundCloud is the
          media's loadedmetadata / play / durationchange event. */
    const hookMedia = () => {
      const media = getMedia();
      if (!media || media === mediaHooked) return;
      mediaHooked = media;
      ['loadedmetadata', 'durationchange', 'play'].forEach((evt) => {
        media.addEventListener(evt, debouncedCheck, { passive: true });
      });
    };
    hookMedia();
    // Re-hook periodically in case the site replaces the media element.
    setInterval(hookMedia, 3000);

    /* 4) Watch the URL — YouTube changes ?v= when you click a new video. */
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        debouncedCheck();
      }
    }, 1000);

    /* 5) Safety-net polling for sites that don't fire any of the above. */
    setInterval(checkTrackChange, 3000);
  }

  /* ══════════════════════════════════════
     TRACK START
     ══════════════════════════════════════ */
  function startTrack(payload) {
    clearRevealTimers();
    cancelLoop();
    stage.textContent = '';

    const track = payload.track || {};
    const lyrics = payload.lyrics || {};
    const synced = parseLrc(lyrics.synced || '');
    const plain = lyrics.plain
      ? lyrics.plain.split(/\n+/).map((line) => line.trim()).filter(Boolean)
      : [];

    const prepared = prepareLines(synced.length ? synced : fakeTimedLyrics(plain));
    const title = [track.artist, track.title].filter(Boolean).join(' — ') || 'Song found';

    state.active = true;
    state.errorShown = false;
    state.lines = prepared;
    state.currentIndex = -1;
    state.currentMoment = null;
    state.trackTitle = title;
    state.lyricSource = synced.length ? 'synced' : 'plain fallback';
    state.syncOffsetMs = computeAdaptiveSyncOffset(prepared);
    state.trackKey = trackStorageKey(track);
    state.trackDurationMs = Number(track.durationMs || 0) ||
      (payload.hints && payload.hints.duration ? payload.hints.duration * 1000 : 0);
    state.offsetWasRestored = false;
    preview.textContent = '';
    progressFill.style.width = '0%';

    // YOUTUBE MUSIC VIDEO SYNC COMPENSATOR
    // Auto-compensate for cinematic music video intros on YouTube
    if (location.hostname.includes('youtube.com') && payload.match && payload.match.duration && payload.hints && payload.hints.duration) {
      const actualMs = payload.hints.duration * 1000;
      const expectedMs = payload.match.duration * 1000;
      const diffMs = actualMs - expectedMs;
      
      // If the YouTube video is 4 to 60 seconds LONGER than the official track duration,
      // it's highly likely a music video intro. Shift the lyrics forward by that exact amount.
      if (diffMs > 4000 && diffMs < 60000 && synced.length) {
        state.syncOffsetMs += diffMs;
      }
    }

    // SPOTIFY SYNC COMPENSATION
    // Start with a moderate offset. The auto-calibration system (below) will
    // fine-tune this per-song after the first few lyric lines are rendered.
    if (state.isSpotify && synced.length) {
      state.syncOffsetMs -= 250;
    }

    state.baseOffsetMs = state.syncOffsetMs;
    state.timingErrors = [];
    state.autoCalibrated = false;
    state.spotifyAutoCalibSamples = [];
    state.mediaDriftSamples = [];
    state.playbackRate = 1;

    const media = getMedia();
    let mediaNow;
    if (state.isSpotify) {
      const spotMs = getSpotifyCurrentTimeFromDom();
      mediaNow = spotMs !== null ? spotMs : Number(track.playOffsetMs || 0);
      state.spotifyCurrentTimeMs = mediaNow;
      state.spotifyLastPollWall = performance.now();
      startSpotifyPolling();
    } else {
      mediaNow = media && Number.isFinite(media.currentTime)
        ? media.currentTime * 1000
        : Number(track.playOffsetMs || 0);
    }

    state.fallbackMediaStartMs = mediaNow;
    state.fallbackStartMs = performance.now();
    state.lastMediaTime = mediaNow;
    state.lastWallTime = performance.now();

    if (!state.lines.length) {
      setHud('Song found, but no lyrics were returned.', true, true);
      return;
    }

    show();
    root.classList.add('lvx-active');
    setHud(`${title} · ${state.lyricSource} · offset ${formatOffset(state.syncOffsetMs)}`);
    startLoop();

    /* PER-SONG OFFSET MEMORY: if the user manually nudged sync for this song
       before, restore their preferred offset (overrides the adaptive guess). */
    if (state.trackKey) {
      try {
        chrome.storage.local.get(`lvxOffset:${state.trackKey}`, (result) => {
          const saved = result && result[`lvxOffset:${state.trackKey}`];
          if (Number.isFinite(saved) && state.active && state.trackKey) {
            state.syncOffsetMs = saved;
            state.baseOffsetMs = saved;
            state.autoCalibrated = true; // trust the user's saved offset
            state.offsetWasRestored = true;
            setHud(`${title} · saved sync restored (${formatOffset(saved)})`);
          }
        });
      } catch (_) {}
    }

    // SAFETY NET: if no lyric line renders within 12 seconds, show error
    // This catches cases where DOM time reading fails silently (blank screen bug)
    if (state.isSpotify) {
      setTimeout(() => {
        if (state.active && state.currentIndex < 0) {
          // No line rendered yet — time source is probably broken
          stage.innerHTML = '';
          const errorDiv = document.createElement('div');
          errorDiv.className = 'lvx-not-available';
          errorDiv.textContent = 'Lyrics found but sync failed. Try skipping forward/back.';
          stage.appendChild(errorDiv);
          setHud('Sync failed — try restarting the song', true, true);
        }
      }, 12000);
    }
  }

  /* ══════════════════════════════════════
     LRC PARSER
     ══════════════════════════════════════ */
  function parseLrc(raw) {
    const lines = [];
    String(raw || '').split(/\n+/).forEach((line) => {
      const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
      if (!matches.length) return;

      const text = line.replace(/\[[^\]]+\]/g, '').trim();
      if (!text) return;

      matches.forEach((match) => {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        const fraction = match[3] ? Number(match[3].padEnd(3, '0').slice(0, 3)) : 0;
        lines.push({
          time: minutes * 60000 + seconds * 1000 + fraction,
          text
        });
      });
    });
    return lines.sort((a, b) => a.time - b.time);
  }

  function computeAdaptiveSyncOffset(lines) {
    if (lines.length < 2) return DEFAULT_SYNC_OFFSET_MS;

    const gaps = [];
    let totalWords = 0;

    for (let i = 0; i < lines.length - 1; i++) {
      const g = lines[i + 1].time - lines[i].time;
      if (g > 150 && g < 10000) gaps.push(g);
      totalWords += (lines[i].text || '').split(/\s+/).filter(Boolean).length;
    }
    totalWords += (lines[lines.length - 1].text || '').split(/\s+/).filter(Boolean).length;

    if (!gaps.length) return DEFAULT_SYNC_OFFSET_MS;

    // Use MEDIAN gap (not mean) — immune to long instrumental breaks skewing the result
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)];
    const avgWordsPerLine = totalWords / lines.length;

    // Detect genre/tempo from lyric patterns
    // LRCLIB timestamps are already well-placed — we just need small lead for rendering
    let offset;

    if (medianGap < 900) {
      // Rapid-fire rap / drill: needs visible lead
      offset = -160;
    } else if (medianGap < 1600) {
      // Fast pop / hip-hop
      offset = -120;
    } else if (medianGap < 2600) {
      // Normal pop / rock
      offset = -90;
    } else if (medianGap < 4000) {
      // Slow song
      offset = -65;
    } else {
      // Very slow ballad: barely any lead — LRC timestamps are usually right on time
      offset = -45;
    }

    // Dense lines (many words) need a touch more lead to read ahead
    if (avgWordsPerLine > 9) offset -= 15;
    else if (avgWordsPerLine < 3) offset += 10; // short phrases can arrive a bit later

    // Hard clamp — never more than -180ms early, never positive
    return Math.max(-180, Math.min(-30, offset));
  }

  function fakeTimedLyrics(lines) {
    return lines.map((text, index) => {
      const wc = text.split(/\s+/).filter(Boolean).length;
      const interval = Math.max(2200, Math.min(wc * 420, 4200));
      const startTime = index === 0 ? 0
        : lines.slice(0, index).reduce((acc, t) => {
            const w = t.split(/\s+/).filter(Boolean).length;
            return acc + Math.max(2200, Math.min(w * 420, 4200));
          }, 0);
      return { time: startTime, text };
    });
  }

  /* ══════════════════════════════════════
     LINE PREPARATION
     ══════════════════════════════════════ */
  function prepareLines(rawLines) {
    const clean = rawLines
      .map((line) => ({
        time: Number(line.time || 0),
        text: cleanText(line.text || '')
      }))
      .filter((line) => line.text)
      .sort((a, b) => a.time - b.time);

    const counts = new Map();
    clean.forEach((line) => {
      const key = normalize(line.text);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });

    return clean.map((line, index) => {
      const next = clean[index + 1];
      const duration = next ? Math.max(420, next.time - line.time) : 4500;
      const repeated = (counts.get(normalize(line.text)) || 0) > 1;
      const role = classifyLine(line.text, duration, repeated);
      return {
        ...line,
        index,
        nextTime: next ? next.time : line.time + 4500,
        duration,
        repeated,
        role,
        composition: composeMoment(line.text, role, index, repeated),
        animation: pickAnimation(index)
      };
    });
  }

  function pickAnimation(index) {
    const h = ((index + 1) * 2654435761) >>> 0;
    return ANIMATIONS[h % ANIMATIONS.length];
  }

  function classifyLine(text, duration, repeated) {
    const list = words(text);
    const wc = list.length;
    const lower = normalize(text);
    const first = lower.split(' ')[0] || '';
    const tagLike = TAG_OPENERS.has(first) && wc <= 5;

    if (tagLike) return 'tag';
    if (repeated && wc <= 9) return 'punch';
    if (wc <= 3 || text.length <= 14) return 'punch';
    if (duration <= 1250 && wc <= 6) return 'punch';
    if (/!$/.test(text.trim()) && wc <= 7) return 'punch';
    if (wc >= 8 || /[,;:?]/.test(text) || (SETUP_OPENERS.has(first) && wc >= 5)) return 'mixed';
    return 'main';
  }

  function composeMoment(text, role, index, repeated) {
    const list = words(text);
    const wc = list.length;
    const normalized = cleanText(text);

    if (role === 'tag') {
      return {
        layout: layoutFor(index, 'tag'),
        layers: [{ kind: 'tag', text: normalized }]
      };
    }

    if (role === 'punch' || role === 'main' || wc <= 5) {
      return {
        layout: layoutFor(index, role),
        layers: [{ kind: role === 'punch' || repeated ? 'punch' : 'main', text: normalized }]
      };
    }

    const split = splitForKineticMoment(normalized);
    if (split.support && split.main) {
      const layers = [
        { kind: 'support', text: split.support },
        { kind: repeated ? 'punch' : 'main', text: split.main }
      ];
      if (split.tag) layers.push({ kind: 'tag', text: split.tag });
      return {
        layout: layoutFor(index, 'mixed'),
        layers
      };
    }

    return {
      layout: layoutFor(index, 'main'),
      layers: [{ kind: 'main', text: normalized }]
    };
  }

  function splitForKineticMoment(text) {
    const cleaned = cleanText(text);
    const hardSplit = cleaned.match(/^(.+?)([,;:]|\s+-\s+|\s+but\s+|\s+and\s+)(.+)$/i);
    if (hardSplit) {
      const head = cleanText(`${hardSplit[1]}${hardSplit[2].trim().match(/but|and/i) ? ` ${hardSplit[2].trim()}` : hardSplit[2]}`);
      const tail = cleanText(hardSplit[3]);
      if (words(tail).length >= 2 && words(tail).length <= 7) {
        return { support: trimWords(head, 9), main: tail, tag: '' };
      }
      if (words(tail).length > 7) {
        return { support: trimWords(head, 8), main: tailWords(tail, 5), tag: '' };
      }
    }

    const list = words(cleaned);
    if (list.length >= 8) {
      const mainCount = list.length >= 12 ? 5 : 4;
      const support = list.slice(0, Math.max(3, list.length - mainCount)).join(' ');
      const main = list.slice(-mainCount).join(' ');
      return { support: trimWords(support, 8), main, tag: '' };
    }

    return { support: '', main: cleaned, tag: '' };
  }

  /* ══════════════════════════════════════
     LAYOUT SELECTOR (expanded with new layouts)
     ══════════════════════════════════════ */
  function layoutFor(index, role) {
    const h = ((index + 1) * 2654435761) >>> 0;

    const mixedLayouts = [
      'lvx-layout-ref-a',     'lvx-layout-ref-b',     'lvx-layout-ref-c',
      'lvx-layout-diag-a',    'lvx-layout-diag-b',    'lvx-layout-split-v',
      'lvx-layout-asymm-l',   'lvx-layout-asymm-r',   'lvx-layout-cinema',
      'lvx-layout-stack',     'lvx-layout-typewriter', 'lvx-layout-widescreen',
      'lvx-layout-drift',     'lvx-layout-scatter',    'lvx-layout-cascade',
    ];
    const mainLayouts = [
      'lvx-layout-center',      'lvx-layout-left',       'lvx-layout-low',
      'lvx-layout-corner-tl',   'lvx-layout-corner-br',  'lvx-layout-edge-r',
      'lvx-layout-high',        'lvx-layout-edge-l',     'lvx-layout-typewriter',
      'lvx-layout-spotlight',   'lvx-layout-widescreen', 'lvx-layout-whisper',
      'lvx-layout-drift',       'lvx-layout-cascade',
    ];
    const punchLayouts = [
      'lvx-layout-center',     'lvx-layout-wide',       'lvx-layout-hero',
      'lvx-layout-corner-tl',  'lvx-layout-left',       'lvx-layout-corner-br',
      'lvx-layout-stadium',    'lvx-layout-cinema',     'lvx-layout-spotlight',
      'lvx-layout-scatter',    'lvx-layout-drift',
    ];

    if (role === 'mixed') return mixedLayouts[h % mixedLayouts.length];
    if (role === 'tag')   return 'lvx-layout-tag';
    if (role === 'punch') return punchLayouts[h % punchLayouts.length];
    return mainLayouts[h % mainLayouts.length];
  }

  /* ══════════════════════════════════════
     MAIN PLAYBACK LOOP (improved sync)
     ══════════════════════════════════════ */
  function startLoop() {
    cancelLoop();

    function tick() {
      if (!state.active) return;

      const mediaMs = getMediaTimeMs();
      updateDriftTracking(mediaMs);
      const lyricClockMs = mediaMs - state.syncOffsetMs;
      const nextIndex = findActiveIndex(lyricClockMs);

      // Update song progress bar
      if (state.trackDurationMs > 0) {
        const pct = clamp((mediaMs / state.trackDurationMs) * 100, 0, 100);
        progressFill.style.width = `${pct.toFixed(2)}%`;
      }

      if (nextIndex !== state.currentIndex) {
        // SPOTIFY AUTO-CALIBRATION: observe timing errors on the first 12 line transitions
        // and adjust offset so lyrics land closer to the beat
        if (state.isSpotify && nextIndex >= 0 && nextIndex < state.lines.length && !state.autoCalibrated && !state.offsetWasRestored) {
          const expectedMs = state.lines[nextIndex].time;
          const errorMs = lyricClockMs - expectedMs; // positive = we're late
          if (Math.abs(errorMs) < 3000) { // ignore wild outliers
            if (!state.spotifyAutoCalibSamples) state.spotifyAutoCalibSamples = [];
            state.spotifyAutoCalibSamples.push(errorMs);
            // After 8 samples, compute median error and adjust offset
            if (state.spotifyAutoCalibSamples.length >= 8) {
              const sorted = [...state.spotifyAutoCalibSamples].sort((a, b) => a - b);
              const median = sorted[Math.floor(sorted.length / 2)];
              // Only adjust if median error > 100ms (meaningful)
              if (Math.abs(median) > 100) {
                state.syncOffsetMs += Math.round(median * 0.6); // partial correction
              }
              state.autoCalibrated = true;
            }
          }
        }
        renderIndex(nextIndex, lyricClockMs);
      } else if (nextIndex >= 0) {
        const line = state.lines[nextIndex];
        if (state.currentMoment && shouldClearLine(line, lyricClockMs)) {
          clearMoment();
        } else if (!state.currentMoment && !shouldClearLine(line, lyricClockMs)) {
          renderIndex(nextIndex, lyricClockMs);
        }
      }

      state.rafId = requestAnimationFrame(tick);
    }

    state.rafId = requestAnimationFrame(tick);
  }

  function cancelLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  /* ══════════════════════════════════════
     MEDIA TIME (supports Spotify DOM polling + standard)
     ══════════════════════════════════════ */
  function getMediaTimeMs() {
    // ─── SPOTIFY: ALWAYS use DOM polling, NEVER trust <video>/<audio> elements ───
    // Spotify has hidden media elements (Canvas loops, DRM playback via EME)
    // whose currentTime is WRONG — it loops, freezes, or reports DRM stream time.
    // This was the root cause of blank screens, 2-line loops, and freeze bugs.
    if (state.isSpotify) {
      if (state.spotifyLastPollWall > 0) {
        if (state.spotifyPauseDetected) {
          return state.spotifyCurrentTimeMs;
        }
        const now = performance.now();
        const wallElapsed = now - state.spotifyLastPollWall;
        // Safety cap: if no fresh poll in 5 seconds, don't keep advancing
        if (wallElapsed > 5000) {
          return state.spotifyCurrentTimeMs + 5000;
        }
        return state.spotifyCurrentTimeMs + wallElapsed;
      }
      // Spotify polling hasn't started yet — use fallback
      return state.fallbackMediaStartMs + (performance.now() - state.fallbackStartMs);
    }

    // ─── NON-SPOTIFY: use standard <video>/<audio> element ───
    const media = getMedia();
    if (media && Number.isFinite(media.currentTime) && media.duration > 0) {
      state.playbackRate = media.playbackRate || 1;
      return media.currentTime * 1000;
    }

    // Pure fallback (no media element found)
    return state.fallbackMediaStartMs + (performance.now() - state.fallbackStartMs);
  }

  /* ── Drift tracking: only correct for playback rate deviation, not base offset ── */
  function updateDriftTracking(mediaMs) {
    const now = performance.now();
    if (state.lastWallTime > 0) {
      const wallDelta = now - state.lastWallTime;
      const mediaDelta = mediaMs - state.lastMediaTime;

      // Only track when both are moving forward in a normal range
      if (wallDelta > 50 && wallDelta < 1500 && mediaDelta > 0 && mediaDelta < 1500) {
        const rate = mediaDelta / wallDelta; // actual playback rate
        if (rate > 0.5 && rate < 2.0) {
          state.mediaDriftSamples.push(rate);
          if (state.mediaDriftSamples.length > 20) state.mediaDriftSamples.shift();

          if (state.mediaDriftSamples.length >= 8) {
            const avgRate = state.mediaDriftSamples.reduce((a, b) => a + b, 0) / state.mediaDriftSamples.length;
            // Only adjust if rate is meaningfully different from 1x (>2% deviation)
            if (Math.abs(avgRate - 1.0) > 0.02) {
              state.playbackRate = avgRate;
            }
          }
        }
      }
    }
    state.lastMediaTime = mediaMs;
    state.lastWallTime = now;
  }

  function findActiveIndex(clockMs) {
    const lines = state.lines;
    if (!lines.length || clockMs < lines[0].time - 500) return -1;

    let low = 0;
    let high = lines.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lines[mid].time <= clockMs) low = mid + 1;
      else high = mid - 1;
    }

    return Math.max(0, high);
  }

  function shouldClearLine(line, clockMs) {
    if (!line) return true;
    // Hold until 92% of the line duration or at least 900ms
    const hold = Math.max(Math.round(line.duration * 0.92), 900);
    return clockMs > line.time + hold && line.nextTime - line.time > hold + 200;
  }

  /* ══════════════════════════════════════
     RENDERING
     ══════════════════════════════════════ */
  function renderIndex(index, clockMs) {
    const prevIndex = state.currentIndex; // capture BEFORE overwriting (calibration needs it)
    clearMoment();
    state.currentIndex = index;
    updatePreview(index);

    if (index < 0) return;
    const line = state.lines[index];
    if (!line || shouldClearLine(line, clockMs)) return;

    /* ── Real-time auto-calibration ──
       Measure how far ahead/behind we are vs the LRC timestamp each time a line renders.
       If we're consistently early or late, gently shift syncOffsetMs to correct it.
       Target: mediaMs should be within ±60ms of line.time when line renders.
       Skips the first line (often instrumental intro) and lines that are re-renders. */
    if (index > 0 && index !== prevIndex && !state.offsetWasRestored) {
      const currentMediaMs = getMediaTimeMs();
      const timingError = currentMediaMs - line.time;
      // timingError < 0 means we're showing line before LRC time (too early)
      // timingError > 0 means we're showing line after LRC time (too late)
      // Ideal range: [-60, +60]ms — if outside this, collect for correction

      state.timingErrors.push(timingError);
      if (state.timingErrors.length > 6) state.timingErrors.shift();

      if (state.timingErrors.length >= 4) {
        const avg = state.timingErrors.reduce((a, b) => a + b, 0) / state.timingErrors.length;
        // Only auto-correct if consistent error > 80ms
        if (Math.abs(avg) > 80) {
          // Shift syncOffsetMs to correct:
          // syncOffsetMs is subtracted from mediaMs to get lyricClockMs
          // lyricClockMs must reach line.time to trigger render
          // If avg timingError < 0 (too early): mediaMs < line.time at render
          //   → need lyricClockMs to be higher → decrease syncOffsetMs (more negative) — wait
          //   Actually: lyricClockMs = mediaMs - syncOffsetMs
          //   Line renders when lyricClockMs >= line.time → mediaMs - syncOffsetMs >= line.time
          //   → mediaMs >= line.time + syncOffsetMs
          //   If avg < 0: mediaMs at render < line.time, meaning syncOffsetMs is too negative
          //   → increase syncOffsetMs (toward 0) to require higher mediaMs before rendering
          const correction = avg * 0.35; // 35% of error, gentle
          const newOffset = clamp(state.syncOffsetMs + correction, -280, 150);
          state.syncOffsetMs = newOffset;
          state.timingErrors = [];
        }
      }
    }

    const moment = document.createElement('div');
    const animClass = line.animation === 'slam' ? '' : `lvx-anim-${line.animation}`;
    moment.className = `lvx-moment lvx-role-${line.role} ${line.composition.layout} ${animClass}`.trim();

    const revealQueue = [];
    line.composition.layers.forEach((layer) => {
      revealQueue.push(...addTextLayer(moment, layer.text, layer.kind));
    });

    stage.appendChild(moment);
    fitMoment(moment);
    state.currentMoment = moment;
    revealWords(revealQueue, line);
  }

  function addTextLayer(moment, text, kind) {
    const layer = document.createElement('div');
    layer.className = `lvx-text lvx-${kind}`;
    layer.style.fontSize = `${estimateFontSize(text, kind)}px`;

    const spans = [];
    splitRows(text, kind).forEach((row) => {
      const rowEl = document.createElement('span');
      rowEl.className = 'lvx-word-row';
      row.forEach((word) => {
        const span = document.createElement('span');
        span.className = 'lvx-word';
        span.textContent = word.toUpperCase();
        spans.push(span);
        rowEl.appendChild(span);
      });
      layer.appendChild(rowEl);
    });

    moment.appendChild(layer);
    return spans;
  }

  function revealWords(spans, line) {
    const total = spans.length;
    if (!total) return;

    const wordCount = total;
    const duration = line.duration || 3000;
    const wordsPerSec = wordCount / (duration / 1000);

    let step;

    if (wordCount <= 2) {
      step = 55;
    } else if (wordsPerSec > 4) {
      // Rap / fast: tight stagger but all words visible before line ends
      step = clamp(duration * 0.45 / (wordCount - 1), 25, 70);
    } else if (wordsPerSec > 2) {
      // Normal pop/rock
      step = clamp(duration * 0.50 / (wordCount - 1), 55, 160);
    } else {
      // Slow ballad: spacious but still spread within the line
      step = clamp(duration * 0.55 / (wordCount - 1), 90, 260);
    }

    // First word at 0ms — appears exactly when line triggers (at LRC timestamp)
    // Subsequent words cascade from there
    spans.forEach((span, index) => {
      state.revealTimers.push(setTimeout(() => span.classList.add('lvx-in'), index * step));
    });
  }

  /* ── Next-line preview: faint upcoming lyric at the bottom of the screen ── */
  function updatePreview(index) {
    const next = index >= 0 ? state.lines[index + 1] : state.lines[0];
    preview.textContent = next ? next.text : '';
  }

  function clearMoment() {
    clearRevealTimers();
    if (!state.currentMoment) return;

    const old = state.currentMoment;
    state.currentMoment = null;
    old.classList.add('lvx-out');
    setTimeout(() => old.remove(), 160);
  }

  function clearRevealTimers() {
    state.revealTimers.forEach(clearTimeout);
    state.revealTimers = [];
  }

  /* ══════════════════════════════════════
     TEXT SIZING & LAYOUT
     ══════════════════════════════════════ */
  function splitRows(text, kind) {
    const list = words(text);
    if (list.length <= 1) return list.length ? [list] : [];

    const joined = list.join(' ');
    let rowCount = 1;
    if (kind === 'support') {
      rowCount = joined.length > 34 || list.length > 6 ? 2 : 1;
    } else if (kind === 'tag') {
      rowCount = joined.length > 18 || list.length > 4 ? 2 : 1;
    } else if (joined.length > 42 || list.length > 8) {
      rowCount = 3;
    } else if (joined.length > 17 || list.length > 4) {
      rowCount = 2;
    }

    rowCount = clamp(rowCount, 1, Math.min(3, list.length));
    const rows = [];
    let index = 0;
    for (let row = 0; row < rowCount; row++) {
      const remainingRows = rowCount - row;
      const remainingWords = list.length - index;
      const take = Math.ceil(remainingWords / remainingRows);
      rows.push(list.slice(index, index + take));
      index += take;
    }
    return rows;
  }

  function estimateFontSize(text, kind) {
    const length = String(text || '').length;
    const wc = words(text).length;
    let size;

    if (kind === 'support') {
      size = length <= 18 ? 62 : length <= 36 ? 54 : 46;
    } else if (kind === 'tag') {
      size = length <= 16 ? 72 : 60;
    } else if (kind === 'punch') {
      if (wc <= 2 || length <= 10) size = 166;
      else if (length <= 22) size = 148;
      else if (length <= 40) size = 118;
      else size = 94;
    } else {
      if (length <= 12) size = 150;
      else if (length <= 24) size = 126;
      else if (length <= 42) size = 100;
      else size = 82;
    }

    return Math.round(size * state.fontScale);
  }

  function fitMoment(moment) {
    [...moment.querySelectorAll('.lvx-text')].forEach((layer) => fitLayer(layer));
  }

  function fitLayer(layer) {
    let size = parseFloat(layer.style.fontSize) || 82;
    const minSize = layer.classList.contains('lvx-support') ? 26 : 36;
    const maxHeight = parseFloat(getComputedStyle(layer).maxHeight) || window.innerHeight * 0.42;

    for (let i = 0; i < 36; i++) {
      const box = layer.getBoundingClientRect();
      const parentWidth = layer.clientWidth || box.width;
      if (layer.scrollWidth <= parentWidth + 2 && layer.scrollHeight <= maxHeight + 2) break;
      size -= 3;
      if (size <= minSize) {
        size = minSize;
        break;
      }
      layer.style.fontSize = `${size}px`;
    }
  }

  /* ══════════════════════════════════════
     KEYBOARD CONTROLS
     ══════════════════════════════════════ */
  function handleKeys(event) {
    const target = event.target;
    const tagName = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (tagName === 'input' || tagName === 'textarea' || (target && target.isContentEditable)) return;

    /* Esc always closes the overlay — even on the error screen (state.active=false) */
    if (event.key === 'Escape' && root.isConnected && root.classList.contains('lvx-active')) {
      event.preventDefault();
      try { chrome.runtime?.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {}); } catch (_) {}
      teardown();
      return;
    }

    if (!state.active) return;

    if (event.key === 't' || event.key === 'T') {
      event.preventDefault();
      cycleTheme(event.shiftKey ? -1 : 1);
    }

    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      nudgeSync(event.key === '[' ? -SYNC_NUDGE_MS : SYNC_NUDGE_MS);
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setFontScale(state.fontScale + 0.1);
    }

    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      setFontScale(state.fontScale - 0.1);
    }

    if (event.key === 'b' || event.key === 'B') {
      event.preventDefault();
      toggleLiteMode();
    }
  }

  function setFontScale(scale) {
    state.fontScale = clamp(Math.round(scale * 10) / 10, 0.6, 1.6);
    try { chrome.storage.local.set({ lvxFontScale: state.fontScale }); } catch (_) {}
    setHud(`Text size ${Math.round(state.fontScale * 100)}%  (+ / - to adjust)`);
    // Re-render the current line at the new size
    state.currentIndex = -999;
  }

  function toggleLiteMode() {
    state.liteMode = !state.liteMode;
    root.classList.toggle('lvx-lite', state.liteMode);
    try { chrome.storage.local.set({ lvxLiteMode: state.liteMode }); } catch (_) {}
    setHud(state.liteMode
      ? 'See-through mode ON — video visible behind lyrics (B)'
      : 'See-through mode OFF (B)');
  }

  function nudgeSync(deltaMs) {
    state.syncOffsetMs += deltaMs;
    state.baseOffsetMs = state.syncOffsetMs; // anchor to manual nudge
    state.timingErrors = [];                 // clear calibration history
    state.autoCalibrated = true;             // stop auto-calibration fighting the user
    state.offsetWasRestored = true;
    setHud(`Sync offset ${formatOffset(state.syncOffsetMs)}  ([ earlier / ] later) · saved for this song`);
    state.currentIndex = -999;

    // Remember this song's offset so it's perfect next time
    if (state.trackKey) {
      try {
        chrome.storage.local.set({ [`lvxOffset:${state.trackKey}`]: state.syncOffsetMs });
      } catch (_) {}
    }
  }

  function trackStorageKey(track) {
    const t = String(track.title || '').toLowerCase().trim();
    const a = String(track.artist || '').toLowerCase().trim();
    return t ? `${a}|${t}` : '';
  }

  function pulse() {
    // Subtle smooth glow — no red flash
    stage.classList.remove('lvx-hit');
    void stage.offsetWidth;
    stage.classList.add('lvx-hit');
    setTimeout(() => stage.classList.remove('lvx-hit'), 300);
  }

  /* ══════════════════════════════════════
     THEME MANAGEMENT
     ══════════════════════════════════════ */
  function applyTheme(name) {
    state.theme = name;
    if (name === 'samay') {
      root.removeAttribute('data-lvx-theme');
    } else {
      root.setAttribute('data-lvx-theme', name);
    }
    themeButton.textContent = THEME_LABELS[name] || name.toUpperCase();
    try {
      chrome.storage.local.set({ lvxTheme: name });
    } catch (_) {}
  }

  function cycleTheme(direction = 1) {
    const idx = THEMES.indexOf(state.theme);
    const next = THEMES[(idx + direction + THEMES.length) % THEMES.length];
    applyTheme(next);
    setHud(`Theme: ${THEME_LABELS[next]}  (T next · Shift+T back)`, false, false);
  }

  /* ══════════════════════════════════════
     TEARDOWN / SHOW
     ══════════════════════════════════════ */
  function teardown() {
    clearRevealTimers();
    cancelLoop();
    stopSpotifyPolling();
    state.active = false;
    state.errorShown = false;
    state.currentIndex = -1;
    state.currentMoment = null;
    state.timingErrors = [];
    state.autoCalibrated = false;
    state.spotifyPauseDetected = false;
    state.spotifyNullCount = 0;
    state.spotifyLastGoodWall = 0;
    state.spotifyAutoCalibSamples = [];
    root.classList.remove('lvx-active');
    stage.textContent = '';
    preview.textContent = '';
    progressFill.style.width = '0%';
    root.remove();
  }

  function show() {
    if (!root.isConnected) {
      root.append(stage, preview, progress, hud);
      document.documentElement.appendChild(root);
    }
  }

  function setHud(text, isError = false, sticky = false) {
    show();
    hud.classList.toggle('lvx-error', isError);
    hud.classList.remove('lvx-dim');
    hudLabel.textContent = isError ? 'LYRICVIBE ERROR' : 'LYRICVIBE';
    hudText.textContent = text;
    clearTimeout(state.hudTimer);
    if (!sticky) {
      state.hudTimer = setTimeout(() => hud.classList.add('lvx-dim'), 3400);
    }
  }

  /* ══════════════════════════════════════
     UTILITY HELPERS
     ══════════════════════════════════════ */
  function trimWords(text, maxWords) {
    const list = words(text);
    if (list.length <= maxWords) return cleanText(text);
    return list.slice(0, maxWords).join(' ');
  }

  function tailWords(text, count) {
    return words(text).slice(-count).join(' ');
  }

  function formatOffset(ms) {
    return `${ms > 0 ? '+' : ''}${Math.round(ms)}ms`;
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\u200b/g, '')
      .trim();
  }

  function normalize(text) {
    return cleanText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function words(text) {
    return cleanText(text).split(/\s+/).filter(Boolean);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
