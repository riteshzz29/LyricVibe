# LyricVibe 🎵

I was listening to music one day, reading along to lyrics on my phone, and it just felt... flat. Then I watched a Samay Raina YouTube special that had this really clean animated caption style at the end credits and thought — why don't lyrics ever feel like that? So I built this.

LyricVibe is a Chrome extension that overlays perfectly synced, word-by-word animated lyrics directly on your YouTube Music, Spotify, and SoundCloud tabs. No setup. Just play a song and hit `Ctrl+Shift+L`.

https://github.com/user-attachments/assets/dbc143e8-2381-4ff2-99a5-8f47dbd6085d

---

## What it does

- Detects whatever song is playing and fetches synced lyrics automatically
- Animates them word-by-word, locked to the beat
- Works on **YouTube Music**, **Spotify Web Player**, and **SoundCloud**
- 13 visual themes — press `T` to switch between them while listening
- Remembers your sync preference per song so you only have to nudge it once
- See-through mode (`B`) so the music video stays visible behind the lyrics
- Adjust text size with `+` / `-`
- 100% free, no account, no tracking, no backend server

---

## Install (30 seconds)

Not on the Chrome Web Store yet — manual install for now:

1. Download the ZIP from the green **Code** button → **Download ZIP**
2. Extract it somewhere on your computer
3. Go to `chrome://extensions/` (or `edge://extensions/` / `brave://extensions/`)
4. Turn on **Developer mode** (top right toggle)
5. Click **Load unpacked** → select the `extension` folder
6. Pin it, open YouTube Music or Spotify, play a song, press `Ctrl+Shift+L`

---

## Keyboard shortcuts

| Key | What it does |
|-----|-------------|
| `Ctrl+Shift+L` | Toggle LyricVibe on/off |
| `T` / `Shift+T` | Cycle themes forward / backward |
| `[` / `]` | Nudge sync earlier or later (saved per song) |
| `+` / `-` | Make text bigger or smaller |
| `B` | See-through mode |
| `Esc` | Close it |

---

## Themes

13 themes: SAMAY (default), HYPE, SOFT, NEON, CLEAN, RETRO, GLASS, FIRE, ELEGANT, AURORA, MATRIX, VINYL, COSMIC

---

## How it works

Fully client-side — no server, no backend. The extension reads the song title and artist from the page, looks up synced lyrics from [LRCLIB](https://lrclib.net), and renders them directly in the tab. The only thing that ever leaves your browser is the song title and artist name (to fetch lyrics). No audio is recorded, no browsing history is collected.

Permissions used: `activeTab`, `scripting`, `storage` — nothing else.

---

## Works best on

YouTube Music > SoundCloud > Spotify (Spotify doesn't expose a proper audio element so timing is slightly trickier, but it works well)

---

MIT licensed · Lyrics from [LRCLIB](https://lrclib.net)
