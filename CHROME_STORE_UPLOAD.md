# Chrome Web Store Upload Checklist

## Store Listing Information

- **Name** (62 chars, limit 75):
  `WubCast - Open Source Screen Recorder with Auto Zoom`

- **Short Description** (132 char limit):
  `Free & open-source screen recorder. Create beautiful recordings with automatic cinematic zoom & pan — 100% offline, no sign-up.`

- **Full Description** (suggested):

```
WubCast is a free, open-source screen recorder Chrome extension with automatic cinematic zoom and pan effects.

FEATURES:
• Automatic zoom & pan that follows your cursor clicks — no manual keyframing
• Built-in editor: trim, adjust zoom depth, custom backgrounds, click effects
• Export up to 4K / 1440p / 1080p at 60 FPS
• Optional camera overlay (picture-in-picture) with microphone mixing
• Beautiful gradient or custom image backgrounds
• Click orb effects with customizable color and intensity

PRIVACY FIRST:
• 100% offline — nothing is uploaded, no servers involved
• No account, no sign-up, no analytics, no telemetry
• All processing happens locally in your browser
• Fully open source — audit every line of code on GitHub

OPEN SOURCE:
This extension is MIT-licensed and open source. View the full source code, report issues, and contribute at:
https://github.com/fasilminale/WubCast

Perfect for developers, designers, educators, and content creators who want polished screen recordings without privacy trade-offs.
```

- **Category**: Productivity (or Developer Tools)
- **Language**: English

## Permissions Justification

| Permission | Reason |
|---|---|
| `desktopCapture` | Required to capture the user's screen |
| `activeTab` | Access the active tab when the extension icon is clicked |
| `storage` | Save user preferences and temporary recording data locally |
| `tabs` | Manage tab navigation during recording (switch between record/editor pages) |
| `scripting` | Inject cursor-tracking content script into the recorded tab |
| `host_permissions: <all_urls>` | Track cursor movements on any website the user records |

## Required Assets

- **Screenshots** (1280x800 or 640x400): at least 1, up to 5
  - Recording page with source picker
  - Editor with zoom preview and timeline
  - Export settings / final output
  - Camera overlay in action

- **Promotional Images** (optional but recommended):
  - Small tile: 440x280
  - Large tile: 920x680
  - Marquee tile: 1400x560

- **Privacy Policy URL** — required because of `desktopCapture` + `host_permissions`
  - Must explain: no data collected, all local, no external requests

## ZIP Package

Exclude from the upload ZIP:
- `.git/`
- `node_modules/`
- `.cursor/`
- `.DS_Store`
- `CHROME_STORE_UPLOAD.md`
- `package-lock.json`
- `screen-recorder-extension.zip`

Build command:
```bash
zip -r wubcast.zip . -x "*.git*" -x "*node_modules*" -x "*.cursor*" -x "*.DS_Store" -x "*CHROME_STORE_UPLOAD.md" -x "*package-lock.json" -x "*screen-recorder-extension.zip"
```

## Upload Process

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Click **New Item** (or update existing)
3. Upload the ZIP
4. Fill in store listing (name, descriptions, category)
5. Upload screenshots
6. Add privacy policy URL
7. Submit for review (typically 1–3 business days)
