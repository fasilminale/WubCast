/**
 * WubCast Screen Recorder
 * Licensed under the MIT License.
 *
 * Loom-style setup popup. The popup is the single setup surface: it shows the
 * current recording state, lets the user pick source / camera / mic / system
 * audio / quality / fps / cursor-tracking / countdown, persists those choices
 * via prefs.js, and hands off to record.html (which owns getDisplayMedia and
 * MediaRecorder) to actually start the capture.
 *
 * Key behaviors:
 * - All toggles are off by default and remembered across sessions.
 * - Camera preview + mic level meter are only requested AFTER the user turns
 *   them on, so the popup never asks for permissions the user didn't opt into.
 * - When a recording is already active, the popup turns into a Stop surface.
 */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const app = $('#app');
  const statusLabel = $('#statusLabel');
  const statusTimer = $('#statusTimer');
  const primaryBtn = $('#primaryBtn');
  const primaryLabel = $('#primaryLabel');
  const shortcutKeys = $('#shortcutKeys');
  const openShortcuts = $('#openShortcuts');

  const sourceTiles = $$('.source-tile');
  const toggleCamera = $('#toggleCamera');
  const toggleMic = $('#toggleMic');
  const toggleSystemAudio = $('#toggleSystemAudio');

  const cameraPreview = $('#cameraPreview');
  const cameraPreviewImg = $('#cameraPreviewImg');
  const micMeter = $('#micMeter');
  const micMeterFill = $('#micMeterFill');

  const qualitySelect = $('#quality');
  const fpsSelect = $('#fps');
  const countdownSelect = $('#countdown');
  const trackCursorBox = $('#trackCursor');

  const IS_MAC = /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '');
  shortcutKeys.textContent = IS_MAC ? '\u2318\u21E7E' : 'Ctrl+Shift+E';

  let state = { isRecording: false, isPaused: false };
  let startedAt = 0;
  let tickInterval = null;
  // Preview is sourced from the offscreen document now: no direct MediaStreams
  // in the popup. These flags just track whether we've asked offscreen to
  // start a preview so we can clean up on close.
  let previewCameraActive = false;
  let previewMicActive = false;

  init();

  async function init() {
    const prefs = await WubcastPrefs.get();
    applyPrefsToUI(prefs);
    await refreshRecordingState();
    wireEvents();
  }

  function applyPrefsToUI(prefs) {
    sourceTiles.forEach((t) => {
      const match = t.dataset.source === prefs.sourceHint;
      t.setAttribute('aria-checked', match ? 'true' : 'false');
    });
    toggleCamera.setAttribute('aria-pressed', prefs.cameraEnabled ? 'true' : 'false');
    toggleMic.setAttribute('aria-pressed', prefs.micEnabled ? 'true' : 'false');
    toggleSystemAudio.setAttribute('aria-pressed', prefs.systemAudioEnabled ? 'true' : 'false');
    qualitySelect.value = prefs.quality;
    fpsSelect.value = prefs.fps;
    countdownSelect.value = String(prefs.countdownSeconds);
    trackCursorBox.checked = !!prefs.trackCursor;

    if (prefs.cameraEnabled) startCameraPreview();
    if (prefs.micEnabled) startMicMeter();
  }

  function wireEvents() {
    sourceTiles.forEach((tile) => {
      tile.addEventListener('click', async () => {
        sourceTiles.forEach((t) => t.setAttribute('aria-checked', 'false'));
        tile.setAttribute('aria-checked', 'true');
        await WubcastPrefs.set({ sourceHint: tile.dataset.source });
      });
    });

    toggleCamera.addEventListener('click', async () => {
      const next = toggleCamera.getAttribute('aria-pressed') !== 'true';
      toggleCamera.setAttribute('aria-pressed', next ? 'true' : 'false');
      await WubcastPrefs.set({ cameraEnabled: next });
      if (next) startCameraPreview();
      else stopCameraPreview();
    });

    toggleMic.addEventListener('click', async () => {
      const next = toggleMic.getAttribute('aria-pressed') !== 'true';
      toggleMic.setAttribute('aria-pressed', next ? 'true' : 'false');
      await WubcastPrefs.set({ micEnabled: next });
      if (next) startMicMeter();
      else stopMicMeter();
    });

    toggleSystemAudio.addEventListener('click', async () => {
      const next = toggleSystemAudio.getAttribute('aria-pressed') !== 'true';
      toggleSystemAudio.setAttribute('aria-pressed', next ? 'true' : 'false');
      await WubcastPrefs.set({ systemAudioEnabled: next });
    });

    qualitySelect.addEventListener('change', () => WubcastPrefs.set({ quality: qualitySelect.value }));
    fpsSelect.addEventListener('change', () => WubcastPrefs.set({ fps: fpsSelect.value }));
    countdownSelect.addEventListener('change', () => WubcastPrefs.set({ countdownSeconds: parseInt(countdownSelect.value, 10) || 0 }));
    trackCursorBox.addEventListener('change', () => WubcastPrefs.set({ trackCursor: trackCursorBox.checked }));

    primaryBtn.addEventListener('click', onPrimaryClicked);

    openShortcuts.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  // Flipped to true the instant the user clicks Start Recording, so the
  // popup's pagehide handler knows NOT to tear down the preview streams —
  // offscreen is about to reuse them for the actual capture and the
  // stopPreview* messages would race into startCapture and stop the freshly
  // acquired mic/camera tracks, producing silent recordings.
  let captureHandoffInProgress = false;

  async function onPrimaryClicked() {
    if (state.isRecording) {
      primaryBtn.disabled = true;
      primaryLabel.textContent = 'Stopping...';
      try {
        await chrome.runtime.sendMessage({ action: 'stopRecording' });
      } catch (e) { /* record/offscreen will handle it */ }
      setTimeout(() => window.close(), 250);
      return;
    }

    primaryBtn.disabled = true;
    primaryLabel.textContent = 'Starting...';
    captureHandoffInProgress = true;

    // We specifically do NOT stop the preview before startCapture: the
    // offscreen doc will hold the camera/mic streams open across the popup's
    // close, avoiding the "re-prompt after Start" jank.

    let targetTabId = null;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) targetTabId = activeTab.id;
    } catch (e) { /* noop */ }

    const prefs = await WubcastPrefs.get();

    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'startCaptureViaOffscreen',
        tabId: targetTabId,
        prefs
      });
      if (!resp || !resp.success) {
        // Fall back to the legacy record.html flow so the user isn't stranded.
        console.warn('[Popup] startCaptureViaOffscreen failed, falling back to record.html:', resp && resp.error);
        await chrome.runtime.sendMessage({ action: 'openRecordSetup', tabId: targetTabId, autoStart: true });
      }
    } catch (e) {
      console.warn('[Popup] Could not send startCaptureViaOffscreen:', e);
      const url = chrome.runtime.getURL(`record.html?autoStart=1&legacy=1&tabId=${targetTabId || ''}`);
      chrome.tabs.create({ url, pinned: true });
    }
    setTimeout(() => window.close(), 120);
  }

  async function refreshRecordingState() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getRecordingStatus' });
      state.isRecording = !!(res && res.isRecording);
      state.isPaused = !!(res && res.isPaused);
    } catch (e) {
      state.isRecording = false;
      state.isPaused = false;
    }
    renderState();
  }

  function renderState() {
    if (state.isRecording && state.isPaused) {
      app.dataset.state = 'paused';
      statusLabel.textContent = 'Paused';
      statusTimer.hidden = false;
      primaryLabel.textContent = 'Stop';
    } else if (state.isRecording) {
      app.dataset.state = 'recording';
      statusLabel.textContent = 'Recording';
      statusTimer.hidden = false;
      primaryLabel.textContent = 'Stop';
    } else {
      app.dataset.state = 'idle';
      statusLabel.textContent = 'Ready';
      statusTimer.hidden = true;
      primaryLabel.textContent = 'Start recording';
    }

    if (state.isRecording && !tickInterval) {
      startedAt = Date.now();
      tickInterval = setInterval(() => {
        if (state.isPaused) return;
        const ms = Date.now() - startedAt;
        statusTimer.textContent = formatTime(ms);
      }, 250);
    }
    if (!state.isRecording && tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  // ---------------------------------------------------------------------------
  // Camera preview — sourced from the offscreen document. Offscreen owns
  // getUserMedia so the permission prompt doesn't dismiss the popup.
  // ---------------------------------------------------------------------------
  async function startCameraPreview() {
    if (previewCameraActive) return;
    previewCameraActive = true;
    cameraPreview.hidden = false;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'startPreviewCamera' });
      if (!resp || !resp.success) {
        handlePreviewCameraFailure(resp && resp.error);
      }
    } catch (e) {
      handlePreviewCameraFailure(e && e.message);
    }
  }
  function stopCameraPreview() {
    previewCameraActive = false;
    // Remove the src attribute entirely so the CSS :not([src]) rule hides the
    // broken-image icon Chrome draws for <img> elements with empty src.
    cameraPreviewImg.removeAttribute('src');
    cameraPreview.hidden = true;
    chrome.runtime.sendMessage({ action: 'stopPreviewCamera' }, () => void chrome.runtime.lastError);
  }
  async function handlePreviewCameraFailure(error) {
    console.warn('[Popup] Camera preview failed:', error);
    previewCameraActive = false;
    cameraPreview.hidden = true;
    // Only force the toggle off for genuine permission denials. "No offscreen
    // document" or "API unavailable" shouldn't disable the user's saved
    // choice — the legacy record.html fallback will still work.
    if (isPermissionDenialError(error)) {
      toggleCamera.setAttribute('aria-pressed', 'false');
      await WubcastPrefs.set({ cameraEnabled: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Mic meter — peaks streamed from the offscreen analyser.
  // ---------------------------------------------------------------------------
  async function startMicMeter() {
    if (previewMicActive) return;
    previewMicActive = true;
    micMeter.hidden = false;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'startPreviewMic' });
      if (!resp || !resp.success) {
        handlePreviewMicFailure(resp && resp.error);
      }
    } catch (e) {
      handlePreviewMicFailure(e && e.message);
    }
  }
  function stopMicMeter() {
    previewMicActive = false;
    micMeterFill.style.width = '0%';
    micMeter.hidden = true;
    chrome.runtime.sendMessage({ action: 'stopPreviewMic' }, () => void chrome.runtime.lastError);
  }
  async function handlePreviewMicFailure(error) {
    console.warn('[Popup] Mic meter failed:', error);
    previewMicActive = false;
    micMeter.hidden = true;
    if (isPermissionDenialError(error)) {
      toggleMic.setAttribute('aria-pressed', 'false');
      await WubcastPrefs.set({ micEnabled: false });
    }
  }

  // True only for user-facing permission denials — distinguishes "the user
  // clicked block" from "the browser doesn't support offscreen" so we don't
  // wipe saved prefs on unsupported Chromium forks.
  function isPermissionDenialError(error) {
    if (!error) return false;
    const msg = String(error);
    return /NotAllowed|Permission|dismissed|denied/i.test(msg);
  }

  // Incoming frames/levels from offscreen, broadcast via runtime messages.
  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return false;
    if (message.action === 'previewCameraFrame' && previewCameraActive && message.data) {
      cameraPreviewImg.src = message.data;
    } else if (message.action === 'micLevel' && previewMicActive) {
      const pct = Math.min(100, (Number(message.peak) || 0) * 140);
      micMeterFill.style.width = pct + '%';
    } else if (message.action === 'previewCameraError') {
      handlePreviewCameraFailure(message.error);
    } else if (message.action === 'previewMicError') {
      handlePreviewMicFailure(message.error);
    }
    return false;
  });

  // When the popup closes, tell offscreen to release any preview streams that
  // aren't backing an active capture. If the user just clicked Start, DO NOT
  // send these — the offscreen doc is mid-startCapture and its `captureActive`
  // flag is still false (it only flips true after MediaRecorder.start()), so a
  // stopPreviewMic/stopPreviewCamera here would race in and call
  // releaseMicStream()/releaseCameraStream(), stopping the very tracks that
  // were just added to the recording MediaStream. Net result used to be
  // silent recordings when the user had camera + mic both enabled.
  window.addEventListener('pagehide', () => {
    if (captureHandoffInProgress) return;
    if (previewCameraActive) chrome.runtime.sendMessage({ action: 'stopPreviewCamera' }, () => void chrome.runtime.lastError);
    if (previewMicActive)    chrome.runtime.sendMessage({ action: 'stopPreviewMic' },    () => void chrome.runtime.lastError);
  });

  // Live-refresh state if storage changes underneath us (e.g. recording started
  // from keyboard shortcut while popup is visible).
  WubcastPrefs.subscribe(() => { /* prefs changes don't affect current state */ });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.isRecording || changes.isPaused) {
      refreshRecordingState();
    }
  });
})();
