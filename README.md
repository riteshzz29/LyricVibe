# LyricVibe 🎵 - Chrome Extension

A sleek, full-screen kinetic typography lyric visualizer that automatically overlays perfectly synced lyrics directly onto your active music tabs.

https://github.com/user-attachments/assets/42663764-0fbd-4b10-9bba-2b1bfbadbe85

Built for modern music listeners who want an immersive, "Spotify Canvas"-style experience right in their browser.

## ✨ Features

- **Zero Configuration:** Just play a song. The extension automatically detects the playing track, fetches the lyrics via LRCLIB, and handles the sync.
- **Universal Support:** Works seamlessly on **YouTube Music**( WORKS BEST ), **Spotify Web Player**, and **SoundCloud**.
- **Smart Audio Sync:** Analyzes word density and genre tempo to automatically adjust the reveal timing so the text feels perfectly locked to the beat.
- **13 Stunning Themes:** Press `T` to cycle through beautifully crafted visual themes including Aurora, Matrix, Vinyl, Cosmic, Neon, and more.
- **Dynamic Layouts:** Lyrics automatically arrange into different visual layouts (Drift, Scatter, Cascade) to keep the screen feeling alive.
- **Word-by-Word Cascade:** Smooth, snappy transitions that reveal words exactly as they are sung.

## 🚀 How to Install

Since this extension is in beta and not yet on the Chrome Web Store, you can install it manually in 30 seconds:

1. Download this repository by clicking the green **Code** button -> **Download ZIP**.
2. Extract the downloaded ZIP file to a folder on your computer.
3. Open your browser and go to the extensions page:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
   - Brave: `brave://extensions/`
4. Turn on **Developer mode** (toggle in the top right corner).
5. Click the **Load unpacked** button.
6. Select the `extension` folder from the ZIP you extracted.
7. Done! Pin the extension, open YouTube Music or Spotify, and click the LyricVibe icon to start.

## ⌨️ Keyboard Shortcuts

- `T` — Cycle through 13 visual themes
- `[` / `]` — Manually nudge sync timing earlier/later if the auto-sync is slightly off
- `ESC` — Close the visualizer

## 🎨 Themes Showcase

LyricVibe includes 13 unique themes. Here are a few examples:

### HYPE (Bold & Punchy)
<img width="1920" height="1080" alt="Screenshot 2026-04-24 000422" src="https://github.com/user-attachments/assets/2420a4b7-c3df-435d-ace1-56909ed4e74c" />

### SOFT (Pastel & Smooth)
<img width="1920" height="1080" alt="Screenshot 2026-04-24 000439" src="https://github.com/user-attachments/assets/e87340ce-db0c-4b91-b6b6-57dad21d9c56" />

### NEON (Bright & Futuristic)
<img width="1920" height="1080" alt="Screenshot 2026-04-24 000225" src="https://github.com/user-attachments/assets/e367e141-90e4-4987-a4ff-81ea151a5408" />

### ELEGANT (Classic Serif)
<img width="1920" height="1080" alt="Screenshot 2026-04-24 000313" src="https://github.com/user-attachments/assets/a75ceacc-1262-44a5-9a30-888af227e9c3" />

## 🛠️ Tech Stack

- **Extension:** Vanilla JavaScript, CSS3 — no frameworks, maximum performance.
- **Architecture:** 100% client-side, no backend required.
- **Lyrics Provider:** LRCLIB API (called directly from the extension).
