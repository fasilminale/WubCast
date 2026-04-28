# AGENTS.md

Guidance for AI coding agents working on **WubCast** — an open-source Chrome extension that records the screen and adds automatic cinematic zoom/pan effects based on cursor activity.

## Project Overview

- **Type:** Chrome Extension (Manifest V3)
- **Language:** Vanilla JavaScript (ES6+), HTML, CSS — no framework, no TypeScript
- **Build system:** None. Files are loaded directly by Chrome as an unpacked extension.
- **Runtime:** Chrome / Chromium (minimum version 102)
- **Privacy posture:** Fully offline. Never add analytics, telemetry, external fetch calls, or remote script loading.

## Repository Layout

Everything lives at the repo root (no `src/`, no bundler).

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest — permissions, service worker, web-accessible resources |
| `background.js` | Service worker — recording lifecycle, tab/window management, message router |
| `content.js` | Injected into recorded pages — tracks cursor position, clicks, keystrokes |
| `popup.html` / `popup.js` / `popup.css` | Toolbar popup — Loom-style setup surface (source, camera, mic, system audio, quality, fps, countdown, cursor) |
| `prefs.js` | Shared preferences helper (single `chrome.storage.local` namespace) used by popup, record, background, HUD |
| `record.html` / `record.js` | Recording setup page — runs `getDisplayMedia` picker and owns the `MediaRecorder` |
| `recording-hud.js` | Content script — floating in-page Stop/Pause/Mic HUD injected into the recorded tab |
| `offscreen.html` / `offscreen.js` | Offscreen document (currently dormant; reserved for future `DISPLAY_MEDIA` delegation) |
| `editor.html` / `editor.js` | Post-recording editor — preview, trim, background, export |
| `video-processor.js` | Canvas-based export pipeline — zoom, click FX, backgrounds |
| `zoom-analyzer.js` | Generates zoom segments from cursor/click data with easing |
| `processor.html` / `processor-ui.js` | Export/processing UI |
| `icons/` | Extension icons |

## Running & Testing

There is no test suite, no linter, and no CI. Manual QA only.

**Load the extension:**
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select this repo root
4. Click the reload icon on the extension card after any code change

**Debugging:**
- Service worker logs: `chrome://extensions/` → WubCast → **service worker** link
- Popup logs: right-click the popup → **Inspect**
- Page-level (`content.js`, `record.js`, `editor.js`): use DevTools on that page
- Offscreen document: `chrome://extensions/` → inspect views → `offscreen.html`

**Smoke test flow after any change:**
1. Click the toolbar icon → record page opens
2. Start a recording (tab/window/screen)
3. Move the cursor, click a few times, stop
4. Editor opens — verify zoom preview, trim, export all work
5. Check service worker console for errors

## Coding Conventions

- **Plain ES6+**, no transpilation. Do not introduce `import`/`export` syntax unless you also configure modules in `manifest.json` — prefer globals and message passing, which is what the current code uses.
- **No new dependencies.** This project has zero npm deps; keep it that way. Do not add a `package.json`, bundler, or build step unless explicitly requested.
- **Do not add network requests.** Preserve the "100% offline" guarantee — no fetch/XHR/WebSocket to third parties, no remote fonts/scripts/CDNs.
- **Respect Manifest V3 constraints:** service worker has no DOM, no persistent globals across suspension — use `chrome.storage` for state that must survive worker restart.
- **Message passing:** communication between `background.js`, `content.js`, `popup.js`, `record.js`, `editor.js`, and `offscreen.js` uses `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`. Match the existing message `action` / `type` naming when adding new handlers.
- **Indentation:** 2 spaces. Use single quotes for strings (match surrounding code).
- **Comments:** Each top-level file starts with the MIT copyright banner. Preserve it. Do not add narration comments for obvious code.
- **Permissions:** Do not broaden `permissions` or `host_permissions` in `manifest.json` without a concrete justification.

## Common Pitfalls

- Editing a file does **not** hot-reload — you must hit reload on the extension card. For `content.js` changes you also need to reload the target page.
- The service worker (`background.js`) can be terminated at any time. Don't rely on in-memory state for anything that must persist — use `chrome.storage.local` or IndexedDB.
- Large recordings are stored in IndexedDB; don't switch to `chrome.storage.local` (10 MB quota) for video data.
- `content.js` cannot run on `chrome://`, `chrome-extension://`, the Chrome Web Store, or `edge://` pages. See `isUnsupportedWebsite()` in `background.js`.
- When adding a new page/script, remember to list it under `web_accessible_resources` in `manifest.json` if it will be loaded from a web page.

## Release Notes

- See `CHROME_STORE_UPLOAD.md` for Chrome Web Store submission details.
- Bump `version` in `manifest.json` for any user-facing change before packaging.

## Out of Scope for Agents

Unless the user explicitly asks, do not:
- Migrate to TypeScript, React, or any build tool
- Add telemetry, crash reporting, or remote config
- Add authentication, accounts, or any server component
- Reformat whole files (stick to minimal diffs)
