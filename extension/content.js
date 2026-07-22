(function initLyricVibeOverlay() {
  /* ══════════════════════════════════════
     CONSTANTS & CONFIG
     ══════════════════════════════════════ */
  const DEFAULT_SYNC_OFFSET_MS = -80;
  const SYNC_NUDGE_MS = 80;
  const THEMES = ['samay', 'flow', 'fire', 'neon', 'glass', 'hype', 'soft', 'clean', 'retro', 'elegant', 'aurora', 'matrix', 'vinyl', 'cosmic'];
  const THEME_LABELS = {
    flow: 'FLOW', samay: 'SAMAY', hype: 'HYPE', soft: 'SOFT', neon: 'NEON',
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
    /* Only reuse the old overlay if its extension context is still alive.
       After an extension reload/update the old content script survives with a
       DEAD chrome.runtime: it can't answer LV_GET_HINTS, so song detection
       silently breaks until the page is refreshed. Detect that zombie and
       replace it instead of returning early. */
    const lvxOld = window.__lyricVibeOverlay;
    var lvxOldAlive = false; // var: hoisted so it's visible after this block
    try { lvxOldAlive = typeof lvxOld.ping === 'function' ? lvxOld.ping() : false; } catch (_) {}
    if (!lvxOldAlive) {
      try { if (typeof lvxOld.hide === 'function') lvxOld.hide(); } catch (_) {}
      try { const lvxEl = document.getElementById('lvx-root'); if (lvxEl) lvxEl.remove(); } catch (_) {}
      window.__lyricVibeOverlay = null;
      // (zombie replaced — fall through to full re-initialization below)
    }
    if (lvxOldAlive) {
      window.__lyricVibeOverlay.show();
      return;
    }
  }
  if (window.__lvxNeverTrue) { // no-op guard: absorbs a leftover legacy return statement
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
    detectedSyncOffsetMs: DEFAULT_SYNC_OFFSET_MS, // genre/tempo-aware baseline for Auto Sync
    syncPreferenceVersion: 0, // prevents stale stored offsets from overriding an Auto Sync reset
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

  const quickSyncButton = document.createElement('button');
  quickSyncButton.className = 'lvx-quick-sync-btn';
  quickSyncButton.textContent = '⟳ SYNC';
  quickSyncButton.title = 'Auto Sync: reset manual timing and recalibrate this song';
  quickSyncButton.addEventListener('click', () => quickSyncLyrics());

  const helpButton = document.createElement('button');
  helpButton.className = 'lvx-help-btn';
  helpButton.textContent = '?';
  helpButton.title = 'Keyboard shortcuts (? or H)';
  helpButton.addEventListener('click', () => toggleShortcutsPanel());

  hud.append(hudLabel, hudText, syncEarlier, syncLater, quickSyncButton, themeButton, helpButton, stopButton);

  /* Next-line preview (bottom center) */
  const preview = document.createElement('div');
  preview.className = 'lvx-preview';

  /* Song progress bar (bottom edge) */
  const progress = document.createElement('div');
  progress.className = 'lvx-progress';
  const progressFill = document.createElement('div');
  progressFill.className = 'lvx-progress-fill';
  progress.appendChild(progressFill);

  /* Keyboard shortcuts help panel */
  let shortcutsAutoHideTimer = 0;
  const shortcutsPanel = document.createElement('div');
  shortcutsPanel.className = 'lvx-shortcuts-panel';
  shortcutsPanel.innerHTML = [
    '<div class="lvx-shortcuts-header">',
    '  <span class="lvx-shortcuts-title">KEYBOARD SHORTCUTS</span>',
    '  <button class="lvx-shortcuts-close">✕</button>',
    '</div>',
    '<div class="lvx-shortcuts-grid">',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">T</span><span class="lvx-shortcut-sep">/</span><span class="lvx-key-badge">Shift+T</span>',
    '    <span class="lvx-shortcut-desc">Cycle themes forward / backward</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">[</span><span class="lvx-shortcut-sep">/</span><span class="lvx-key-badge">]</span>',
    '    <span class="lvx-shortcut-desc">Nudge sync earlier / later</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">⟳ SYNC</span>',
    '    <span class="lvx-shortcut-desc">Reset manual sync and auto-calibrate this song</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">+</span><span class="lvx-shortcut-sep">/</span><span class="lvx-key-badge">−</span>',
    '    <span class="lvx-shortcut-desc">Increase / decrease text size</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">B</span>',
    '    <span class="lvx-shortcut-desc">Toggle see-through mode</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">Esc</span>',
    '    <span class="lvx-shortcut-desc">Close the visualizer</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">?</span><span class="lvx-shortcut-sep">/</span><span class="lvx-key-badge">H</span>',
    '    <span class="lvx-shortcut-desc">Show / hide this panel</span>',
    '  </div>',
    '</div>',
    '<div class="lvx-shortcuts-footer">Sync offsets are remembered per song</div>',
  ].join('\n');
  shortcutsPanel.querySelector('.lvx-shortcuts-close').addEventListener('click', () => toggleShortcutsPanel(false));

  root.append(stage, preview, progress, hud, shortcutsPanel);
  document.documentElement.appendChild(root);

  window.__lyricVibeOverlay = {
    // Health check: returns false once this script's extension context dies
    // (extension reloaded/updated), so the next injection knows to replace us.
    ping() {
      try { return Boolean(chrome && chrome.runtime && chrome.runtime.id); }
      catch (_) { return false; }
    },
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
      cancelLoop();
      clearRevealTimers();
      stage.textContent = '';
      preview.textContent = '';
      progressFill.style.width = '0%';
      state.errorShown = true; // Ensure observer stays active while status is shown
      setHud(message.text || 'Working...');
    }

    if (message.type === 'LV_STATUS_WARNING') {
      cancelLoop();
      clearRevealTimers();
      stage.textContent = '';
      preview.textContent = '';
      progressFill.style.width = '0%';
      state.errorShown = true; // Ensure observer stays active while status is shown
      setHud(message.text || 'Service busy...', false, true, true);
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

    if (message.type === 'LV_API_ERROR') {
      // API is down/degraded — show clear message with retry button
      clearRevealTimers();
      cancelLoop();
      stopSpotifyPolling();
      state.currentIndex = -1;
      state.currentMoment = null;
      state.errorShown = true;

      show();
      const errorMsg = message.text || 'Lyrics service is temporarily unavailable';
      stage.innerHTML = '';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'lvx-not-available lvx-api-error';
      errorDiv.innerHTML = '';

      const msgSpan = document.createElement('div');
      msgSpan.className = 'lvx-api-error-msg';
      msgSpan.textContent = errorMsg;
      errorDiv.appendChild(msgSpan);

      if (message.canRetry) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'lvx-retry-btn';
        retryBtn.textContent = '↻ TRY AGAIN';
        retryBtn.addEventListener('click', () => {
          try { chrome.runtime?.sendMessage({ type: 'LV_RETRY' }).catch(() => {}); } catch (_) {}
          stage.textContent = '';
          setHud('Retrying...', false, false, true);
        });
        errorDiv.appendChild(retryBtn);
      }

      stage.appendChild(errorDiv);
      progressFill.style.width = '0%';
      preview.textContent = '';
      root.classList.add('lvx-active');
      setHud(`${errorMsg}`, true, true, true);
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
    if (state.theme === 'flow') flowFitAllSlots();
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
        textFrom('ytmusic-player-bar yt-formatted-string.title') || '';
      hints.artist = textFrom('.byline.ytmusic-player-bar a') ||
        textFrom('ytmusic-player-bar .byline a') ||
        textFrom('ytmusic-player-bar .subtitle a') || '';
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
      // ═══ SOUNDCLOUD ═══
      // Key challenge: SoundCloud "artist" = uploader (random username), NOT the real artist.
      // The real artist is typically embedded in the track title: "Artist - Song Title"
      // We must parse the title to extract the real artist for accurate lyrics lookup.

      let scRawTitle = '';
      let scUploader = '';

      // Step 1: Read raw track title and uploader from DOM (multiple selector strategies)
      scRawTitle = textFrom('.playbackSoundBadge__titleLink') ||
        textFrom('.playbackSoundBadge__titleLink span') ||
        textFrom('.soundTitle__title span') || '';
      scUploader = textFrom('.playbackSoundBadge__lightLink') ||
        textFrom('.soundTitle__username') || '';

      // Strategy 2: DOM traversal of player bar links
      if (!scRawTitle) {
        const scPlayer = document.querySelector('.playControls__soundBadge') ||
          document.querySelector('.playControls__inner') ||
          document.querySelector('.playControls');
        if (scPlayer) {
          for (const a of scPlayer.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            const txt = a.textContent.trim();
            if (!txt || txt.length < 2) continue;
            if (!scRawTitle && href.split('/').length >= 3 && !href.includes('/sets/')) {
              scRawTitle = txt;
            }
            if (!scUploader && href.match(/^\/[^/]+\/?$/)) {
              scUploader = txt;
            }
          }
        }
      }

      // Strategy 3: Parse document.title (most reliable — always has the track info)
      // Format: "Stream Track Title by Uploader | Listen..." or "Track Title by Uploader | SoundCloud"
      if (!scRawTitle && title) {
        let scTitle = title
          .replace(/\s*[|·]\s*(?:Listen|SoundCloud).*$/i, '')
          .replace(/^Stream\s+/i, '')
          .trim();
        const byMatch = scTitle.match(/^(.+?)\s+by\s+(.+)$/i);
        if (byMatch) {
          scRawTitle = byMatch[1].trim();
          if (!scUploader) scUploader = byMatch[2].trim();
        } else if (scTitle) {
          scRawTitle = scTitle;
        }
      }

      // Step 2: Parse the real artist from the track title
      // SoundCloud track titles commonly use these formats:
      //   "Artist - Song Title"
      //   "Artist — Song Title"  (em dash)
      //   "Artist – Song Title"  (en dash)
      //   "Artist: Song Title"
      if (scRawTitle) {
        const dashMatch = scRawTitle.match(/^(.+?)\s*[-–—]\s+(.+)$/);
        if (dashMatch && dashMatch[1].length >= 2 && dashMatch[2].length >= 2) {
          // Title has "Artist - Song" format — extract both
          hints.artist = dashMatch[1].trim();
          hints.track = dashMatch[2].trim();
        } else {
          // No embedded artist — use the full title as track, uploader as artist fallback
          hints.track = scRawTitle;
          hints.artist = scUploader;
        }
      }

      // Mark this as SoundCloud so the service worker knows
      hints.isSoundCloud = true;
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
    let pendingKey = '';
    let stabilityTimer = 0;
    let mediaHooked = null;
    let ytmVideoSrcObserver = null;
    const isYTMusic = location.hostname.includes('music.youtube.com');

    // Simple track key using only DOM text metadata.
    // The stability timer below handles slow/partial updates natively!
    const currentTrackKey = () => {
      const h = getPageHints();
      const track = (h.track || h.pageTitle || '').trim();
      const artist = (h.artist || '').trim();
      return track ? `${track}|||${artist}` : '';
    };

    const onPotentialChange = () => {
      const listening = state.active || state.errorShown;
      if (!listening) {
        const k = currentTrackKey();
        if (k) lastTrackKey = k;
        return;
      }

      const key = currentTrackKey();
      if (!key) return;

      if (key !== lastTrackKey) {
        if (key !== pendingKey) {
          pendingKey = key;
          clearTimeout(stabilityTimer);
          
          // Wait for DOM to stabilize (prevents partial-update false positives)
          // Keep these as SHORT as possible — the service worker has its own retries
          const waitMs = state.isSpotify ? 150 : isYTMusic ? 300 : 100;
          
          stabilityTimer = setTimeout(() => {
            const prevKey = lastTrackKey;
            lastTrackKey = pendingKey;
            
            if (state.isSpotify) {
              try {
                chrome.runtime?.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {});
                setTimeout(() => {
                  try { chrome.runtime?.sendMessage({ type: 'LV_SPOTIFY_TRACK_CHANGED' }).catch(() => {}); } catch (_) {}
                }, 100);
              } catch (_) {}
            } else {
              try {
                cancelLoop();
                clearRevealTimers();
                stage.textContent = '';
                preview.textContent = '';
                progressFill.style.width = '0%';
                chrome.runtime?.sendMessage({ type: 'LV_TRACK_CHANGED', prevKey: prevKey || '' }).catch(() => {});
              } catch (_) {}
            }
          }, waitMs);
        }
      } else {
        // Reverted to lastTrackKey before stabilizing, or just noise
        pendingKey = '';
        clearTimeout(stabilityTimer);
      }
    };

    let throttleTimer = 0;
    const triggerCheck = () => {
      clearTimeout(throttleTimer);
      throttleTimer = setTimeout(onPotentialChange, 50);
    };

    const observer = new MutationObserver(triggerCheck);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    const titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(triggerCheck).observe(titleEl, { childList: true, characterData: true });
    }

    const hookMedia = () => {
      const media = getMedia();
      if (!media || media === mediaHooked) return;
      mediaHooked = media;
      ['loadedmetadata', 'durationchange', 'play'].forEach((evt) => {
        media.addEventListener(evt, triggerCheck, { passive: true });
      });

      if (isYTMusic && media.tagName === 'VIDEO') {
        if (ytmVideoSrcObserver) ytmVideoSrcObserver.disconnect();
        ytmVideoSrcObserver = new MutationObserver(triggerCheck);
        ytmVideoSrcObserver.observe(media, { attributes: true, attributeFilter: ['src'] });
      }
    };
    hookMedia();
    setInterval(hookMedia, 3000);

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        triggerCheck();
      }
    }, isYTMusic ? 400 : 1000);

    setInterval(triggerCheck, 3000);
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
    state.syncPreferenceVersion += 1;
    state._flowLastIndex = -999; // reset FLOW teleprompter for new song
    if (state.theme === 'flow') flowInit(); // rebuild FLOW DOM for new lyrics
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
    state.detectedSyncOffsetMs = state.syncOffsetMs;
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
        const preferenceVersion = state.syncPreferenceVersion;
        chrome.storage.local.get(`lvxOffset:${state.trackKey}`, (result) => {
          const saved = result && result[`lvxOffset:${state.trackKey}`];
          if (Number.isFinite(saved) && state.active && state.trackKey && state.syncPreferenceVersion === preferenceVersion) {
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
          // Only show error if the first lyric should have played by now
          if (state.lines.length && state.lines[0].time < 11000) {
            stage.innerHTML = '';
            const errorDiv = document.createElement('div');
            errorDiv.className = 'lvx-not-available';
            errorDiv.textContent = 'Lyrics found but sync failed. Try skipping forward/back.';
            stage.appendChild(errorDiv);
            setHud('Sync failed — try restarting the song', true, true);
          }
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

      /* ── FLOW THEME: separate render path (teleprompter, runs every frame) ── */
      if (state.theme === 'flow') {
        if (nextIndex !== state.currentIndex) {
          state.currentIndex = nextIndex;
        }
        flowRender(nextIndex, lyricClockMs);
        state.rafId = requestAnimationFrame(tick);
        return;
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
    
    // Clear any previous error messages when we start successfully rendering
    const errorMsg = stage.querySelector('.lvx-not-available');
    if (errorMsg) {
      errorMsg.remove();
      setHud('Resynced', false, false);
    }

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

    /* PULSE: apply "drop" class to the moment if this line follows a big gap */
    if (state.theme === 'pulse') {
      pulseApplyDrop(moment, line, index);
    }

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
    const isPulse = state.theme === 'pulse';
    const wordDurMs = isPulse ? (duration / Math.max(1, wordCount)) : 0;
    const isPunchLine = isPulse && (line.role === 'punch' || wordCount <= 3);
    spans.forEach((span, index) => {
      state.revealTimers.push(setTimeout(() => {
        span.classList.add('lvx-in');
        if (isPulse) pulseDecorateWord(span, wordDurMs, isPunchLine);
      }, index * step));
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

    /* Esc closes shortcuts panel first; if panel is closed, Esc closes the overlay */
    if (event.key === 'Escape' && root.isConnected && root.classList.contains('lvx-active')) {
      event.preventDefault();
      if (shortcutsPanel.classList.contains('lvx-shortcuts-open')) {
        toggleShortcutsPanel(false);
        return;
      }
      try { chrome.runtime?.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {}); } catch (_) {}
      teardown();
      return;
    }

    /* ?/H toggle shortcuts panel — works even on the error screen */
    if ((event.key === '?' || event.key === 'h' || event.key === 'H') && root.isConnected && root.classList.contains('lvx-active')) {
      event.preventDefault();
      toggleShortcutsPanel();
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

  function toggleShortcutsPanel(forceState) {
    const isOpen = shortcutsPanel.classList.contains('lvx-shortcuts-open');
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !isOpen;
    clearTimeout(shortcutsAutoHideTimer);
    if (shouldOpen) {
      shortcutsPanel.classList.add('lvx-shortcuts-open');
      helpButton.classList.add('lvx-help-active');
      shortcutsAutoHideTimer = setTimeout(() => toggleShortcutsPanel(false), 8000);
    } else {
      shortcutsPanel.classList.remove('lvx-shortcuts-open');
      helpButton.classList.remove('lvx-help-active');
    }
  }

  function nudgeSync(deltaMs) {
    state.syncOffsetMs += deltaMs;
    state.baseOffsetMs = state.syncOffsetMs; // anchor to manual nudge
    state.timingErrors = [];                 // clear calibration history
    state.autoCalibrated = true;             // stop auto-calibration fighting the user
    state.offsetWasRestored = true;
    state.syncPreferenceVersion += 1;
    setHud(`Sync offset ${formatOffset(state.syncOffsetMs)}  ([ earlier / ] later) · saved for this song`);
    state.currentIndex = -999;

    // Remember this song's offset so it's perfect next time
    if (state.trackKey) {
      try {
        chrome.storage.local.set({ [`lvxOffset:${state.trackKey}`]: state.syncOffsetMs });
      } catch (_) {}
    }
  }

  /**
   * Automatic timing recovery for one song. It removes only that song's
   * manual nudge, reapplies the pace-aware baseline, and enables the existing
   * live calibration path to fine-tune later lyric transitions.
   */
  function quickSyncLyrics() {
    if (!state.active || !state.lines.length) {
      setHud('Auto Sync needs active lyrics first', true, false);
      return;
    }

    const tempoOffset = Number.isFinite(state.detectedSyncOffsetMs)
      ? state.detectedSyncOffsetMs
      : computeAdaptiveSyncOffset(state.lines);

    state.syncPreferenceVersion += 1;
    state.syncOffsetMs = tempoOffset;
    state.baseOffsetMs = tempoOffset;
    state.timingErrors = [];
    state.spotifyAutoCalibSamples = [];
    state.mediaDriftSamples = [];
    state.autoCalibrated = false;
    state.offsetWasRestored = false;
    state.currentIndex = -999;
    clearMoment();

    if (state.theme === 'flow') {
      state._flowLastIndex = -999;
    }

    if (state.trackKey) {
      try { chrome.storage.local.remove(`lvxOffset:${state.trackKey}`); } catch (_) {}
    }

    setHud(`Auto Sync reset · pace-aware offset ${formatOffset(tempoOffset)} · recalibrating`);
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
     FLOW THEME — TELEPROMPTER LYRICS FOLLOWER
     ══════════════════════════════════════
     Renders a smooth scrolling teleprompter with per-word
     highlighting. Designed for learning/following along.

     Line stack (vertically centered):
       line -2/-1: readable previous context
       current:    focus line in the middle
       line +1/+2: readable upcoming context

     Word states in current line:
       upcoming  → soft cream text
       active    → softly glowing cream text
       done      → slightly dimmer cream text

     Data: reuses state.lines[] from prepareLines().
     Timing: reuses the same step formula from revealWords().
     ══════════════════════════════════════ */

  /**
   * Initialize FLOW DOM: create the 5-line container inside stage.
   * Called when switching to flow or when lyrics load while flow is active.
   */
  function flowInit() {
    flowTeardown(); // clean up any previous instance
    clearMoment();  // remove any existing kinetic moment

    const container = document.createElement('div');
    container.className = 'lvx-flow-container';

    // Seven slots buffer the visible five. The hidden top/bottom slots let
    // each lyric physically travel up the screen instead of being replaced.
    for (let i = -3; i <= 3; i++) {
      const lineEl = document.createElement('div');
      lineEl.className = 'lvx-flow-line';
      lineEl.dataset.flowPos = String(i);
      container.appendChild(lineEl);
    }

    stage.appendChild(container);
    state._flowContainer = container;
    state._flowSlots = Array.from(container.querySelectorAll('.lvx-flow-line'));
    state._flowTransitioning = false;
    state._flowLastIndex = -999; // force rebuild on first render
  }

  /**
   * Tear down FLOW DOM. Safe to call even if flow wasn't initialized.
   */
  function flowTeardown() {
    if (state._flowRecycleTimer) {
      clearTimeout(state._flowRecycleTimer);
      state._flowRecycleTimer = 0;
    }
    if (state._flowContainer) {
      state._flowContainer.remove();
      state._flowContainer = null;
    }
    state._flowSlots = null;
    state._flowTransitioning = false;
    state._flowLastIndex = -999;
  }

  const FLOW_SLOT_OFFSETS = [-3, -2, -1, 0, 1, 2, 3];
  const FLOW_SCROLL_MS = 620;

  /**
   * Keep a Flow lyric on one clean line. Short lyrics use the larger visual
   * scale; only unusually long lines are reduced enough to stay in the frame.
   */
  function flowFitLine(lineEl, text, position) {
    if (!lineEl || !text) {
      lineEl?.style.removeProperty('--lvx-flow-fit-size');
      return;
    }

    const viewportWidth = Math.max(320, window.innerWidth || 1280);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const compact = viewportWidth <= 760;
    const distance = Math.abs(position);
    let baseSize;
    let minSize;

    if (position === 0) {
      baseSize = compact
        ? clamp(viewportWidth * 0.084, 2.15 * rem, 4.1 * rem)
        : clamp(viewportWidth * 0.052, 2.55 * rem, 6.2 * rem);
      minSize = compact ? 1.7 * rem : 1.35 * rem;
    } else if (distance === 1) {
      baseSize = compact
        ? clamp(viewportWidth * 0.049, 1.2 * rem, 2 * rem)
        : clamp(viewportWidth * 0.0345, 1.75 * rem, 4.1 * rem);
      minSize = compact ? 0.9 * rem : 1.05 * rem;
    } else {
      baseSize = compact
        ? clamp(viewportWidth * 0.035, 0.95 * rem, 1.45 * rem)
        : clamp(viewportWidth * 0.0255, 1.35 * rem, 3 * rem);
      minSize = compact ? 0.72 * rem : 0.85 * rem;
    }

    const canvas = state._flowMeasureCanvas || (state._flowMeasureCanvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    if (!context) return;

    context.font = `700 ${baseSize}px "DM Sans", Arial, sans-serif`;
    const wordsInLine = text.trim().split(/\s+/).filter(Boolean).length;
    const currentWordSpacing = position === 0 ? Math.max(0, wordsInLine - 1) * baseSize * 0.12 : 0;
    const measuredWidth = context.measureText(text).width + currentWordSpacing + 12;
    const availableWidth = Math.min(viewportWidth * 0.90, 1720);
    const fittedSize = clamp(baseSize * Math.min(1, availableWidth / Math.max(measuredWidth, 1)), minSize, baseSize);

    lineEl.style.setProperty('--lvx-flow-fit-size', `${Math.floor(fittedSize)}px`);
  }

  function flowFitAllSlots() {
    (state._flowSlots || []).forEach((lineEl) => {
      const lineIndex = Number(lineEl.dataset.flowLineIndex);
      const line = state.lines[lineIndex];
      flowFitLine(lineEl, line ? line.text : '', Number(lineEl.dataset.flowPos));
    });
  }

  /**
   * Fill one physical slot with a lyric and assign its vertical position.
   * The element is retained between lines so CSS can animate it smoothly.
   */
  function flowSetSlot(lineEl, lineIndex, position) {
    if (!lineEl) return;

    lineEl.dataset.flowPos = String(position);
    lineEl.dataset.flowLineIndex = String(lineIndex);

    const line = lineIndex >= 0 && lineIndex < state.lines.length
      ? state.lines[lineIndex]
      : null;

    if (!line) {
      lineEl.textContent = '';
      lineEl.style.visibility = 'hidden';
      lineEl.style.removeProperty('--lvx-flow-fit-size');
      return;
    }

    lineEl.style.visibility = 'visible';
    if (position === 0) {
      flowBuildWordSpans(lineEl, line.text);
    } else {
      lineEl.textContent = line.text;
    }
    flowFitLine(lineEl, line.text, position);
  }

  /** Place all slots without animation, used for first render and seeking. */
  function flowSetStatic(activeIndex) {
    const container = state._flowContainer;
    const slots = state._flowSlots || [];
    if (!container || !slots.length) return;

    if (state._flowRecycleTimer) {
      clearTimeout(state._flowRecycleTimer);
      state._flowRecycleTimer = 0;
    }

    container.classList.add('lvx-flow-snap');
    slots.forEach((lineEl, slotIndex) => {
      const offset = FLOW_SLOT_OFFSETS[slotIndex];
      flowSetSlot(lineEl, activeIndex + offset, offset);
    });
    void container.offsetWidth; // commit the static positions before animating later
    container.classList.remove('lvx-flow-snap');
    state._flowTransitioning = false;
  }

  /**
   * Advance every physical slot one position upward. The future buffer enters
   * through the bottom and the exited top slot is recycled after it is hidden.
   */
  function flowAdvance(previousIndex, nextIndex) {
    const container = state._flowContainer;
    const slots = state._flowSlots || [];
    if (!container || !slots.length) return;

    const outgoing = slots.find((lineEl) => Number(lineEl.dataset.flowPos) === -3);
    if (!outgoing) {
      flowSetStatic(nextIndex);
      return;
    }

    slots.forEach((lineEl) => {
      const oldPosition = Number(lineEl.dataset.flowPos);
      const lineIndex = Number(lineEl.dataset.flowLineIndex);
      flowSetSlot(lineEl, lineIndex, oldPosition - 1);
    });

    state._flowTransitioning = true;
    state._flowRecycleTimer = setTimeout(() => {
      if (!state._flowContainer || state._flowLastIndex !== nextIndex) return;
      // Teleport the departed line back below the stage while it is fully
      // transparent, so the next upward movement always begins cleanly.
      container.classList.add('lvx-flow-snap');
      flowSetSlot(outgoing, nextIndex + 3, 3);
      void outgoing.offsetWidth;
      container.classList.remove('lvx-flow-snap');
      state._flowTransitioning = false;
      state._flowRecycleTimer = 0;
    }, FLOW_SCROLL_MS);
  }

  /**
   * Compute which word is active using the same step formula as revealWords.
   * @param {Object} line - prepared line object with .text, .duration
   * @param {number} clockMs - current lyric clock time
   * @returns {number} word index (0-based), or -1 if before line start
   */
  function flowWordIndex(line, clockMs) {
    if (!line) return -1;
    const elapsed = clockMs - line.time;
    if (elapsed < 0) return -1;

    const lineWords = line.text.split(/\s+/).filter(Boolean);
    const wordCount = lineWords.length;
    if (wordCount <= 0) return -1;
    if (wordCount === 1) return 0;

    const duration = line.duration || 3000;
    const wordsPerSec = wordCount / (duration / 1000);

    let step;
    if (wordCount <= 2) {
      step = 55;
    } else if (wordsPerSec > 4) {
      step = clamp(duration * 0.45 / (wordCount - 1), 25, 70);
    } else if (wordsPerSec > 2) {
      step = clamp(duration * 0.50 / (wordCount - 1), 55, 160);
    } else {
      step = clamp(duration * 0.55 / (wordCount - 1), 90, 260);
    }

    return clamp(Math.floor(elapsed / step), 0, wordCount - 1);
  }

  /**
   * Main FLOW render function. Called every RAF frame when theme === 'flow'.
   * @param {number} activeIndex - current line index from findActiveIndex
   * @param {number} clockMs - lyric clock time (ms)
   */
  function flowRender(activeIndex, clockMs) {
    // Lazy init: create container if it doesn't exist yet
    if (!state._flowContainer) {
      if (!state.lines.length) return;
      flowInit();
    }

    const lines = state.lines;
    const previousIndex = state._flowLastIndex;

    // Move each physical slot upward for a normal next-line transition.
    // Seeks, backwards jumps, and very fast changes settle cleanly in place.
    if (activeIndex !== state._flowLastIndex) {
      state._flowLastIndex = activeIndex;
      const isSequential = previousIndex >= 0 && activeIndex === previousIndex + 1;
      if (isSequential && !state._flowTransitioning) {
        flowAdvance(previousIndex, activeIndex);
      } else {
        flowSetStatic(activeIndex);
      }
    }

    // ── Per-frame: update word highlighting in the centered physical slot ──
    const currentLineEl = state._flowContainer.querySelector('.lvx-flow-line[data-flow-pos="0"]');
    if (!currentLineEl || activeIndex < 0 || activeIndex >= lines.length) return;

    const currentLine = lines[activeIndex];
    const wordIdx = flowWordIndex(currentLine, clockMs);
    const wordSpans = currentLineEl.querySelectorAll('.lvx-flow-word');

    wordSpans.forEach((span, i) => {
      span.classList.remove('lvx-flow-upcoming', 'lvx-flow-active', 'lvx-flow-done');
      if (i < wordIdx) {
        span.classList.add('lvx-flow-done');
      } else if (i === wordIdx) {
        span.classList.add('lvx-flow-active');
      } else {
        span.classList.add('lvx-flow-upcoming');
      }
    });
  }

  /**
   * Build word <span> elements inside a line element for per-word highlighting.
   * @param {HTMLElement} lineEl - the .lvx-flow-line container
   * @param {string} text - raw line text
   */
  function flowBuildWordSpans(lineEl, text) {
    lineEl.textContent = ''; // clear
    const words = text.split(/\s+/).filter(Boolean);
    words.forEach((word, i) => {
      const span = document.createElement('span');
      span.className = 'lvx-flow-word lvx-flow-upcoming';
      span.textContent = word;
      lineEl.appendChild(span);
      if (i < words.length - 1) {
        lineEl.appendChild(document.createTextNode(' '));
      }
    });
  }

  /* ══════════════════════════════════════
     PULSE THEME — HEURISTIC KINETIC TYPOGRAPHY
     ══════════════════════════════════════
     Detects text patterns to apply kinetic-typography CSS classes.
     Only called when state.theme === 'pulse'. All visual effects
     are CSS-driven (see content.css PULSE section). JS only
     calculates which classes to apply per word/moment.

     Heuristics (operate on the UPPERCASED text in each span):
     1. ELONGATED — 3+ repeated trailing chars (e.g. "YEAHHHHH")
        → .lvx-pulse-elongated with --lvx-pulse-dur set to word duration
     2. EMPHASIS  — word is ALL-CAPS with ≥2 unique letters, or ends with "!"
        → .lvx-pulse-emphasis (fast punch-in pop)
        Note: since addTextLayer uppercases ALL words, we detect emphasis
        via line role ('punch') or word ending in '!' instead.
     3. SUSTAIN   — word displayed for >800ms (slow line, few words)
        → .lvx-pulse-sustain (breathing scale loop)
     4. DROP      — gap before this line is >2× the song's average gap
        → .lvx-pulse-drop on the moment (bigger entrance)
     ══════════════════════════════════════ */

  /** Regex: word ending with 3+ of the same character (e.g. YEAHHHHH, OHHH, NOOO) */
  const PULSE_ELONGATED_RE = /(.)(\1{2,})$/;

  /**
   * Decorate a single word span with PULSE CSS classes.
   * Called inside the revealWords setTimeout, after lvx-in is added.
   * @param {HTMLElement} span - the .lvx-word span
   * @param {number} wordDurMs - estimated ms this word is displayed
   */
  function pulseDecorateWord(span, wordDurMs, isPunchLine) {
    const text = span.textContent || '';

    // 1. Elongated word detection (e.g. YEAHHHHH, OHHH, NOOO)
    if (PULSE_ELONGATED_RE.test(text)) {
      span.classList.add('lvx-pulse-elongated');
      // Set animation duration to match how long this word is displayed
      span.style.setProperty('--lvx-pulse-dur', `${clamp(wordDurMs, 300, 3000)}ms`);
    }

    // 2. Emphasis: words ending with '!' get a punch-in pop
    //    (ALL-CAPS detection is unreliable since addTextLayer uppercases everything,
    //     so we rely on '!' suffix and short word length as emphasis signals)
    if (isPunchLine || text.endsWith('!') || (text.length <= 3 && text.length >= 1 && /^[A-Z]+$/.test(text))) {
      span.classList.add('lvx-pulse-emphasis');
    }

    // 3. Sustain: word displayed for a long time → breathing pulse
    if (wordDurMs > 800) {
      span.classList.add('lvx-pulse-sustain');
    }
  }

  /**
   * Apply "drop" class to a moment if this line follows a gap
   * significantly longer than the song's average inter-line gap.
   * This simulates a "drop" moment after an instrumental break.
   * @param {HTMLElement} moment - the .lvx-moment div
   * @param {Object} line - the prepared line object
   * @param {number} index - line index in state.lines
   */
  function pulseApplyDrop(moment, line, index) {
    if (index <= 0) return; // first line can't have a preceding gap

    const lines = state.lines;
    const prevLine = lines[index - 1];
    if (!prevLine) return;

    // Compute the gap between previous line's end and this line's start
    const gapBefore = line.time - prevLine.nextTime;
    if (gapBefore <= 0) return; // lines overlap or are contiguous

    // Compute average gap across the song (cached on first call per song)
    if (!state._pulseAvgGap) {
      let totalGap = 0;
      let gapCount = 0;
      for (let i = 1; i < lines.length; i++) {
        const g = lines[i].time - lines[i - 1].nextTime;
        if (g > 0) { totalGap += g; gapCount++; }
      }
      state._pulseAvgGap = gapCount > 0 ? totalGap / gapCount : 2000;
    }

    // If gap before this line is >2× average, it's a "drop" moment
    if (gapBefore > state._pulseAvgGap * 2 && gapBefore > 1500) {
      moment.classList.add('lvx-pulse-drop');
    }
  }

  /* ══════════════════════════════════════
     THEME MANAGEMENT
     ══════════════════════════════════════ */
  function applyTheme(name) {
    const wasFlow = state.theme === 'flow';
    state.theme = name;
    if (wasFlow && name !== 'flow') flowTeardown();
    if (name === 'flow' && state.active && state.lines.length) flowInit();
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
    flowTeardown();
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
    toggleShortcutsPanel(false);
    root.remove();
  }

  function show() {
    if (!root.isConnected) {
      root.append(stage, preview, progress, hud, shortcutsPanel);
      document.documentElement.appendChild(root);
    }
  }

  function setHud(text, isError = false, sticky = false, isWarning = false) {
    show();
    hud.classList.toggle('lvx-error', isError);
    hud.classList.toggle('lvx-warning', isWarning && !isError);
    hud.classList.remove('lvx-dim');
    if (isWarning && !isError) {
      hudLabel.textContent = 'LYRICVIBE WARNING';
    } else {
      hudLabel.textContent = isError ? 'LYRICVIBE ERROR' : 'LYRICVIBE';
    }
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
