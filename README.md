# WubCast — Open Source Screen Recorder with Auto Zoom

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A free, open-source Chrome extension that records your screen and automatically adds cinematic zoom & pan effects based on your cursor activity. **100% offline — no server, no sign-up, no data leaves your device.**

![WubCast Demo](https://img.shields.io/badge/status-stable-brightgreen)

## Features

- **Automatic Zoom & Pan** — Click-aware cinematic zoom that follows your cursor, with smooth easing
- **High-Quality Export** — Up to 4K / 1440p / 1080p output at 60 FPS with configurable bitrate
- **Built-in Editor** — Trim, adjust zoom depth, pick backgrounds, toggle browser frame, click effects
- **Camera Overlay** — Optional picture-in-picture webcam with mic mixing
- **Click Effects** — Customizable orbs (color, intensity) on clicks
- **Custom Backgrounds** — Gradient presets or upload your own image
- **100% Local** — All recording and processing happens in your browser. Nothing uploaded anywhere.
- **No Account Required** — Install and go

## Install

### Chrome Web Store (recommended)

_Coming soon to the Chrome Web Store._

### From Source (developers)

```bash
git clone https://github.com/fasilminale/screen-recorder-extension.git
cd screen-recorder-extension
```

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the cloned folder
4. The WubCast icon appears in your toolbar

## How It Works

1. **Click the extension icon** → opens the recording page
2. **Pick your source** — entire screen, window, or tab
3. **(Optional)** Enable camera overlay and/or microphone
4. **Record** — cursor movements and clicks are tracked automatically
5. **Stop** → the editor opens with your recording
6. **Preview** zoom effects, adjust trim, pick a background
7. **Export** — download a polished video file

## Architecture

| File | Role |
|------|------|
| `manifest.json` | Chrome extension manifest (Manifest V3) |
| `background.js` | Service worker — recording lifecycle, tab management, camera relay |
| `content.js` | Injected into pages — tracks cursor, clicks, keystrokes |
| `record.js` / `record.html` | Recording page UI — source picker, camera/mic setup |
| `recorder.js` | Injected into the recorded tab — runs `MediaRecorder` |
| `editor.js` / `editor.html` | Post-recording editor — zoom preview, trim, export |
| `video-processor.js` | Canvas-based export pipeline — zoom, click effects, backgrounds |
| `zoom-analyzer.js` | Click-aware zoom segment generation with easing curves |
| `popup.js` / `popup.html` / `popup.css` | Toolbar popup — quick start/stop |
| `offscreen.js` / `offscreen.html` | Offscreen document for `MediaRecorder` fallback |

## Privacy

- No analytics, telemetry, or tracking of any kind
- No external network requests (after install)
- No account or sign-up
- All video data stays in your browser's IndexedDB / memory
- Source code is fully auditable right here

## Contributing

Contributions are welcome! Here's how:

1. **Fork** the repo
2. **Create a branch** (`git checkout -b feature/my-change`)
3. **Make your changes** and test locally via `chrome://extensions/` → Load unpacked
4. **Commit** (`git commit -m "Add my feature"`)
5. **Push** and open a **Pull Request**

### Reporting Bugs

Open an [issue](https://github.com/fasilminale/screen-recorder-extension/issues) with:
- Chrome version
- OS
- Steps to reproduce
- Screenshots / console errors if possible

## License

[MIT](LICENSE) — Copyright (c) 2026 Fasil Minale ([@fasilminale](https://github.com/fasilminale))

---

**Made with care for privacy-conscious screen recording.**
