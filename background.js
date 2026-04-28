/**
 * WubCast Screen Recorder
 * Copyright (c) 2026 Fasil Minale
 * GitHub: https://github.com/fasilminale
 *
 * Licensed under the MIT License.
 */

// Load shared preferences helper first (defines globalThis.WubcastPrefs).
try {
  importScripts('prefs.js');
} catch (e) {
  console.warn('[Background] Could not load prefs.js:', e);
}

// Background Service Worker
let isRecording = false;
let isPaused = false;
let cursorData = [];
let recordingStartTime = 0;
let recordingTabId = null;
let storedVideoData = null;
let videoStoredInIndexedDB = false;
let recordedVideoWidth = 0;
let recordedVideoHeight = 0;
let videoDataReady = false;
let cursorDataReady = false;
let cameraOverlayEnabled = false;
let cameraFrameData = null; // Latest camera frame — source is offscreen now, record.html as fallback
let previousRecordingTabId = null; // Track previous tab to remove overlay when switching

// True while capture is running inside the offscreen document. When false and
// recording is active, the legacy record.html path is driving MediaRecorder.
let offscreenCaptureActive = false;
// Gate the editor handoff on both the video blob and cursor data being ready.
// The legacy record.js flow opened the editor itself; in the offscreen flow
// background has to do it.
let editorOpenedForThisClip = false;

// Utility function to detect unsupported websites
function isUnsupportedWebsite(url) {
  if (!url) return false;
  
  // Chrome internal pages
  if (url.startsWith('chrome://')) return true;
  if (url.startsWith('chrome-extension://')) return true;
  if (url.startsWith('edge://')) return true;
  if (url.startsWith('about:')) return true;
  
  // Chrome Web Store
  if (url.includes('chrome.google.com/webstore')) return true;
  
  // Edge Web Store
  if (url.includes('microsoftedge.microsoft.com/addons')) return true;
  
  // Settings pages
  if (url.includes('chrome://settings')) return true;
  if (url.includes('edge://settings')) return true;
  
  return false;
}

// Detect the platform so the tooltip shows the right shortcut keys.
// Service workers expose navigator.userAgent; navigator.platform is deprecated but still present.
const IS_MAC = (typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || ''));
const SHORTCUT_STOP = IS_MAC ? '\u2318\u21E7E' : 'Ctrl+Shift+E'; // Cmd+Shift+E vs Ctrl+Shift+E
const SHORTCUT_PAUSE = IS_MAC ? '\u2318\u21E7P' : 'Ctrl+Shift+P';

// Update extension icon to show recording state.
// Tooltip explicitly mentions the keyboard shortcut so users who can't find the
// HUD or the record tab know how to stop the recording.
async function updateRecordingIcon(recording, paused = false) {
  try {
    if (recording) {
      if (paused) {
        await chrome.action.setBadgeText({ text: 'II' });
        await chrome.action.setBadgeBackgroundColor({ color: '#ffa500' });
        await chrome.action.setTitle({
          title: `WubCast - Paused. Click to stop \u00B7 Resume: ${SHORTCUT_PAUSE} \u00B7 Stop: ${SHORTCUT_STOP}`
        });
      } else {
        await chrome.action.setBadgeText({ text: 'REC' });
        await chrome.action.setBadgeBackgroundColor({ color: '#dc3545' });
        await chrome.action.setTitle({
          title: `WubCast - Recording. Click to stop \u00B7 Pause: ${SHORTCUT_PAUSE} \u00B7 Stop: ${SHORTCUT_STOP}`
        });
      }
    } else {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({
        title: `WubCast - Screen Recorder with Auto Pan Zoom \u00B7 Start/Stop: ${SHORTCUT_STOP}`
      });
    }
  } catch (error) {
    console.warn('[Background] Could not update icon:', error);
  }
}

// ---------------------------------------------------------------------------
// Offscreen lifecycle. MV3 lets each extension own a single offscreen document;
// we use it to host every MediaStream + MediaRecorder so the popup doesn't
// have to (which would kill any getUserMedia prompt on focus loss).
// ---------------------------------------------------------------------------
const OFFSCREEN_URL = 'offscreen.html';

function offscreenApiAvailable() {
  return !!(chrome.offscreen && typeof chrome.offscreen.createDocument === 'function');
}

async function hasOffscreenDocument() {
  if (!offscreenApiAvailable()) return false;
  try {
    if (typeof chrome.offscreen.hasDocument === 'function') {
      return await chrome.offscreen.hasDocument();
    }
    // Older Chrome exposes getContexts on chrome.runtime.
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return contexts && contexts.length > 0;
    }
  } catch (e) {
    console.warn('[Background] hasOffscreenDocument probe failed:', e.message);
  }
  return false;
}

// In-flight ensureOffscreen promise. Serialises concurrent callers so two
// parallel calls (e.g. camera preview + mic preview when the popup opens with
// both toggles already on) don't both race past hasOffscreenDocument() and
// then fight over createDocument() — the second one used to throw
// "Only a single offscreen document may be created" and the caller would
// treat that as a permission failure.
let offscreenEnsurePromise = null;

async function ensureOffscreen(reasons = ['DISPLAY_MEDIA', 'USER_MEDIA']) {
  if (!offscreenApiAvailable()) {
    throw new Error('chrome.offscreen API not available (pre-Chrome 109)');
  }
  if (offscreenEnsurePromise) return offscreenEnsurePromise;
  offscreenEnsurePromise = (async () => {
    if (await hasOffscreenDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons,
        justification: 'Screen and camera capture for recording'
      });
    } catch (e) {
      // Swallow the variations of "doc already exists" that Chrome / Chromium
      // forks throw when a concurrent createDocument call wins the race:
      //   - "Only a single offscreen document may be created."
      //   - "An offscreen document has already been created."
      //   - "Document already exists."
      if (/already|single|exists/i.test(e.message || '')) return;
      console.warn('[Background] Offscreen createDocument failed:', e.message, '— will fall back to record.html?legacy=1');
      throw e;
    }
  })();
  try {
    await offscreenEnsurePromise;
  } finally {
    offscreenEnsurePromise = null;
  }
}

async function closeOffscreen() {
  if (!offscreenApiAvailable()) return;
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch (e) {
    console.warn('[Background] closeOffscreen failed:', e.message);
  }
}

// Send a message *into* the offscreen document. Uses an explicit target so the
// offscreen listener can ignore cross-context chatter aimed at the popup/SW.
async function sendToOffscreen(payload) {
  if (!(await hasOffscreenDocument())) return { success: false, error: 'No offscreen document' };
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ target: 'offscreen', ...payload }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve(response || { success: true });
        }
      });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages targeted at offscreen are for the offscreen doc only. We still
  // see them in this listener because chrome.runtime.sendMessage is broadcast
  // to every extension context — just ignore them here.
  if (message && message.target === 'offscreen') return false;
  
  // Handle camera frame updates from record.html
  if (message.action === 'updateCameraFrame') {
    // Store the latest camera frame from record.html
    cameraFrameData = message.frameData;
    // Broadcast to recording tab only if recording is active and tab ID is set
    if (isRecording && cameraOverlayEnabled && recordingTabId && cameraFrameData) {
      chrome.tabs.sendMessage(recordingTabId, {
        action: 'updateCameraFrame',
        frameData: cameraFrameData
      }).then(() => {
      }).catch((error) => {
        // Only log errors if recording is still active (avoid spam when recording stops)
        if (isRecording && cameraOverlayEnabled) {
        }
      });
    }
    sendResponse({ success: true });
    return true;
  }
  
  // Handle requests for camera frame
  if (message.action === 'getCameraFrame') {
    sendResponse({ frameData: cameraFrameData });
    return true;
  }
  
  // New flow: Record page handles the stream, just need to track state
  if (message.action === 'startRecordingWithMediaStream') {
    console.log('[Background] startRecordingWithMediaStream called');
    console.log('[Background] tabId:', message.tabId);
    
    // Update state
    isRecording = true;
    isPaused = false;
    pausedAt = 0;
    pausedAccumulatedMs = 0;
    cursorData = [];
    recordingStartTime = Date.now();
    videoDataReady = false;
    cursorDataReady = false;
    storedVideoData = null;
    videoStoredInIndexedDB = false;
    cameraOverlayEnabled = message.cameraOverlayEnabled || false;
    previousRecordingTabId = recordingTabId; // Store previous tab before updating
    recordingTabId = message.tabId;
    
    
    chrome.storage.local.set({ isRecording: true, isPaused: false, cameraOverlayEnabled: cameraOverlayEnabled });
    
    // Update icon to show recording state
    updateRecordingIcon(true, false);
    
    // Inject the floating recording HUD into the recording tab (always, independent
    // of camera). This gives the user a Stop/Pause/Mute control right where they are.
    injectRecordingHudToTab(recordingTabId);

    // Inject the cursor tracker immediately so clicks on the initial page are
    // captured. Otherwise content.js only loads on the next tab navigation.
    reinjectContentScript(recordingTabId).catch(() => {});

    // Inject camera overlay into the recording tab only if camera is enabled
    // Note: Camera/microphone permissions are handled by getUserMedia() in the injected script
    // We don't need to check extension permissions - the browser handles it per-tab
    if (cameraOverlayEnabled) {
      // Remove overlay from previous tab if it exists
      if (previousRecordingTabId && previousRecordingTabId !== recordingTabId) {
        removeCameraOverlayFromTab(previousRecordingTabId);
      }
      
      
      // Inject immediately (no delay)
      injectCameraOverlayToRecordingTab(recordingTabId);
      
      // Send the latest frame immediately and repeatedly until confirmed (in case frames were sent before recordingTabId was set)
      if (cameraFrameData) {
        let attempts = 0;
        const maxAttempts = 10;
        const sendLatestFrame = () => {
          if (attempts < maxAttempts && isRecording && cameraOverlayEnabled && recordingTabId) {
            chrome.tabs.sendMessage(recordingTabId, {
              action: 'updateCameraFrame',
              frameData: cameraFrameData
            }).then(() => {
              // Success - frame sent
            }).catch(() => {
              // Tab might not be ready yet, retry
              attempts++;
              setTimeout(sendLatestFrame, 200);
            });
          }
        };
        // Start sending after a short delay to ensure overlay is injected
        setTimeout(sendLatestFrame, 300);
      }
    } else {
    }
    
    sendResponse({ success: true });
    return true;
  }
  
  // Update recording start time to sync with MediaRecorder start
  if (message.action === 'syncRecordingStartTime') {
    console.log('[Background] Syncing recording start time');
    // Clear any cursor data collected before MediaRecorder started
    // This ensures cursor timestamps align with video timestamps
    const oldCursorData = cursorData.length;
    cursorData = [];
    recordingStartTime = Date.now();
    pausedAt = 0;
    pausedAccumulatedMs = 0;
    // Persist so a re-injected HUD (after navigation) can compute elapsed
    // time from storage without round-tripping through the service worker.
    chrome.storage.local.set({
      recordingStartTime,
      pausedAt: 0,
      pausedAccumulatedMs: 0
    });
    console.log('[Background] Recording start time synced, cleared', oldCursorData, 'early cursor data points');
    sendResponse({ success: true, newStartTime: recordingStartTime });
    return true;
  }
  
  if (message.action === 'stopRecording') {
    stopRecording()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'pauseRecording') {
    pauseRecording()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'resumeRecording') {
    resumeRecording()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'cursorMove') {
    if (!isRecording) {
      console.log('[Background] Ignoring cursor move - not recording');
      sendResponse({ success: false, error: 'Not recording' });
      return true;
    }
    
    if (isPaused) {
      sendResponse({ success: false, error: 'Recording paused' });
      return true;
    }
    
    // Store cursor position data with normalized coordinates
    const data = {
      x: message.x,
      y: message.y,
      normalizedX: message.normalizedX,
      normalizedY: message.normalizedY,
      viewportWidth: message.viewportWidth,
      viewportHeight: message.viewportHeight,
      timestamp: Date.now() - recordingStartTime,
      type: message.type,
      key: message.key,
      elementInfo: message.elementInfo
    };
    
    cursorData.push(data);
    
    if (message.type === 'click' || message.type === 'doubleclick') {
      console.log('[Background] 🖱️ Click #' + cursorData.filter(d => d.type === 'click').length + ' stored:', 
                  'x:', data.x, 'y:', data.y,
                  'normalized:', data.normalizedX?.toFixed(3), data.normalizedY?.toFixed(3),
                  'timestamp:', data.timestamp);
    }
    
    sendResponse({ success: true, cursorDataLength: cursorData.length });
    return true;
  }
  
  // Cancel/discard path from the HUD: tear down recording state *without*
  // saving cursor data, keeping the editor from opening.
  if (message.action === 'discardRecording') {
    console.log('[Background] Recording discarded by user');

    isRecording = false;
    isPaused = false;
    const tabToCleanup = recordingTabId;
    const previousTabToCleanup = previousRecordingTabId;
    recordingTabId = null;
    previousRecordingTabId = null;

    // Drop any in-flight video/cursor data so nothing accidentally surfaces.
    videoDataReady = false;
    cursorDataReady = false;
    cursorData = [];

    chrome.storage.local.set({
      isRecording: false,
      isPaused: false,
      cameraOverlayEnabled: false,
      videoData: null,
      recordedVideoData: null,
      cursorData: null
    });

    Promise.all([
      removeCameraOverlayFromAllTabs(),
      removeRecordingHudFromAllTabs(),
      tabToCleanup ? removeCameraOverlayFromTab(tabToCleanup) : Promise.resolve(),
      previousTabToCleanup ? removeCameraOverlayFromTab(previousTabToCleanup) : Promise.resolve()
    ]).catch((error) => {
      console.warn('[Background] Error during discard cleanup:', error);
    });

    updateRecordingIcon(false);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'recordingStopped') {
    console.log('[Background] Recording stopped, cursor data length:', cursorData.length);

    const wasOffscreen = offscreenCaptureActive;
    isRecording = false;
    isPaused = false;
    offscreenCaptureActive = false;
    const tabToCleanup = recordingTabId;
    const previousTabToCleanup = previousRecordingTabId;
    recordingTabId = null;
    previousRecordingTabId = null;

    chrome.storage.local.set({ isRecording: false, isPaused: false, cameraOverlayEnabled: false });

    Promise.all([
      removeCameraOverlayFromAllTabs(),
      removeRecordingHudFromAllTabs(),
      tabToCleanup ? removeCameraOverlayFromTab(tabToCleanup) : Promise.resolve(),
      previousTabToCleanup ? removeCameraOverlayFromTab(previousTabToCleanup) : Promise.resolve()
    ]).catch((error) => {
      console.warn('[Background] Error during overlay cleanup:', error);
    });

    updateRecordingIcon(false);

    saveCursorData();
    cursorDataReady = true;

    console.log('[Background] ✅ Recording stopped. Video ready:', videoDataReady, 'Cursor ready:', cursorDataReady);

    // In the offscreen flow nobody else opens the editor — we do.
    if (wasOffscreen) {
      maybeOpenEditor();
    }

    sendResponse({ success: true });
    return true;
  }
  
  if (message.action === 'storeVideoBlob') {
    console.log('[Background] Storing video blob, size:', message.size);
    console.log('[Background] Video dimensions:', message.width, 'x', message.height);
    
    if (message.useIndexedDB && message.videoId) {
      // Large video stored in IndexedDB - store reference
      storedVideoData = message.videoId; // Store ID as reference
      videoStoredInIndexedDB = true;
      console.log('[Background] Video stored in IndexedDB with ID:', message.videoId);
    } else {
      // Small video - store data directly
      storedVideoData = message.videoData;
      videoStoredInIndexedDB = false;
    }
    
    recordedVideoWidth = message.width || 1280;
    recordedVideoHeight = message.height || 720;
    cameraOverlayEnabled = message.cameraOverlayEnabled || false;
    videoDataReady = true;
    console.log('[Background] ✅ Video data stored!');
    console.log('[Background] Camera overlay enabled:', cameraOverlayEnabled);

    // If we're running the offscreen flow, background owns the editor hand-off.
    // Trigger it if cursor data is already done; otherwise recordingStopped
    // will run maybeOpenEditor after saveCursorData.
    if (cursorDataReady) maybeOpenEditor();

    sendResponse({ success: true });
    return true;
  }
  
  if (message.action === 'getRecordingData') {
    const clicks = cursorData.filter(d => d.type === 'click' || d.type === 'doubleclick');
    console.log('[Background] getRecordingData called');
    console.log('[Background] - Video ready:', videoDataReady);
    console.log('[Background] - Cursor data points:', cursorData.length);
    console.log('[Background] - Click events:', clicks.length);
    
    
    if (clicks.length > 0) {
      console.log('[Background] - First click:', clicks[0]);
      console.log('[Background] - Last click:', clicks[clicks.length - 1]);
    }
    
    sendResponse({
      success: true,
      cursorData: cursorData,
      videoData: storedVideoData,
      videoWidth: recordedVideoWidth,
      videoHeight: recordedVideoHeight,
      videoDataReady: videoDataReady,
      cursorDataReady: cursorDataReady,
      cameraOverlayEnabled: cameraOverlayEnabled,
      videoStoredInIndexedDB: videoStoredInIndexedDB // Flag to indicate IndexedDB storage
    });
    
    return true;
  }
  
  if (message.action === 'getRecordingStatus') {
    sendResponse({
      isRecording: isRecording,
      isPaused: isPaused,
      // Authoritative wall-clock start time so any newly-injected HUD (for
      // example after a tab navigation) can recover the true elapsed time
      // instead of restarting from zero.
      recordingStartTime: recordingStartTime,
      pausedAccumulatedMs: pausedAccumulatedMs,
      pausedAt: pausedAt
    });
    return true;
  }
  
  // Handle navigation notification from content script
  if (message.action === 'pageNavigated' && isRecording && sender.tab?.id === recordingTabId) {
    console.log('[Background] Page navigation detected from content script');
    // The tab.onUpdated listener will handle re-injection, but we can also do it here
    reinjectContentScript(sender.tab.id).catch(() => {});
    sendResponse({ success: true });
    return true;
  }
  
  // Handle ping from content script
  if (message.action === 'ping') {
    sendResponse({ success: true });
    return true;
  }

  // Pre-record 3-2-1 countdown overlay injected into the tab being recorded.
  if (message.action === 'showCountdown') {
    showCountdownOnTab(message.tabId, message.seconds)
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e && e.message }));
    return true;
  }

  // Popup asks us to open the record page (honoring target tab + auto-start flag).
  if (message.action === 'openRecordSetup') {
    (async () => {
      let tab = null;
      if (message.tabId) {
        tab = await chrome.tabs.get(message.tabId).catch(() => null);
      }
      await openRecordingSetup(tab, { autoStart: !!message.autoStart });
      sendResponse({ success: true });
    })().catch((e) => sendResponse({ success: false, error: e && e.message }));
    return true;
  }

  // Controls from the in-page floating HUD (recording-hud.js).
  if (message.action === 'hudStop') {
    stopRecordingFromAnywhere()
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e && e.message }));
    return true;
  }

  if (message.action === 'hudTogglePause') {
    (async () => {
      try {
        if (offscreenCaptureActive) {
          await sendToOffscreen({ type: isPaused ? 'resumeCapture' : 'pauseCapture' });
        } else {
          await forwardToRecordPage(isPaused ? 'resumeRecordingFromShortcut' : 'pauseRecordingFromShortcut');
        }
        sendResponse({ success: true });
      } catch (e) { sendResponse({ success: false, error: e && e.message }); }
    })();
    return true;
  }

  if (message.action === 'hudToggleMicMute') {
    (async () => {
      try {
        if (offscreenCaptureActive) {
          await sendToOffscreen({ type: 'setMicMuted', muted: !!message.muted });
        } else {
          await forwardToRecordPage('toggleMicMuteFromHud', { muted: !!message.muted });
        }
        sendResponse({ success: true });
      } catch (e) { sendResponse({ success: false, error: e && e.message }); }
    })();
    return true;
  }

  // Discard (cancel) the current recording without saving or opening the editor.
  if (message.action === 'hudCancel') {
    cancelRecordingFromAnywhere()
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e && e.message }));
    return true;
  }

  // -------------------------------------------------------------------------
  // Offscreen-era capture control (popup -> background -> offscreen).
  // Each of these proxies to the offscreen doc so the popup never has to call
  // getUserMedia/getDisplayMedia directly (which would race with the popup
  // closing on focus loss).
  // -------------------------------------------------------------------------
  if (message.action === 'startPreviewCamera') {
    (async () => {
      try {
        // Request both reasons up front so the same offscreen doc can later
        // host getDisplayMedia without needing to be closed and recreated.
        await ensureOffscreen(['DISPLAY_MEDIA', 'USER_MEDIA']);
        const resp = await sendToOffscreen({ type: 'startPreviewCamera' });
        sendResponse(resp);
      } catch (e) { sendResponse({ success: false, error: e.message }); }
    })();
    return true;
  }
  if (message.action === 'stopPreviewCamera') {
    (async () => {
      const resp = await sendToOffscreen({ type: 'stopPreviewCamera' });
      await maybeCloseOffscreen();
      sendResponse(resp);
    })();
    return true;
  }
  if (message.action === 'startPreviewMic') {
    (async () => {
      try {
        await ensureOffscreen(['DISPLAY_MEDIA', 'USER_MEDIA']);
        const resp = await sendToOffscreen({ type: 'startPreviewMic' });
        sendResponse(resp);
      } catch (e) { sendResponse({ success: false, error: e.message }); }
    })();
    return true;
  }
  if (message.action === 'stopPreviewMic') {
    (async () => {
      const resp = await sendToOffscreen({ type: 'stopPreviewMic' });
      await maybeCloseOffscreen();
      sendResponse(resp);
    })();
    return true;
  }

  // Popup's Start button: set up offscreen capture for the current tab.
  if (message.action === 'startCaptureViaOffscreen') {
    (async () => {
      try {
        const result = await startCaptureViaOffscreen(message.tabId || null, message.prefs || null);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  // Offscreen has finished acquiring streams and started MediaRecorder.
  // This is the "recording really started" signal — mirror the state that
  // `startRecordingWithMediaStream` used to set.
  if (message.action === 'captureStarted') {
    onCaptureStarted(message).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === 'captureStopped') {
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'captureError' || message.action === 'captureCancelled') {
    (async () => {
      console.warn('[Background] Capture error/cancel:', message.action, message.error);
      await resetRecordingStateAfterFailure();
      sendResponse({ success: true });
    })();
    return true;
  }

  // Proxy from offscreen (or anywhere): "I tried to call getUserMedia but
  // the permission state is still 'prompt'; please open the visible tab that
  // lets Chrome show the permission dialog and report back."
  if (message.action === 'requestMediaPermissionTab') {
    requestMediaPermissionTab(message.kind).then((resp) => sendResponse(resp));
    return true;
  }

  // Result posted by permission.js once the user has answered the prompt.
  // We handle it in requestMediaPermissionTab via a transient listener, so
  // nothing to do here — just ack so sendMessage doesn't complain.
  if (message.action === 'mediaPermissionResult') {
    sendResponse({ success: true });
    return false;
  }
});

// Opens permission.html in a real tab so Chrome can surface its native
// camera/mic permission prompt (offscreen documents can't host that UI).
// Resolves with { success, state } once the user answers or the tab closes.
async function requestMediaPermissionTab(kind) {
  const normalized = ['camera', 'microphone', 'both'].includes(kind) ? kind : 'both';
  const url = chrome.runtime.getURL(`permission.html?kind=${encodeURIComponent(normalized)}`);

  return new Promise((resolve) => {
    let tabId = null;
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) { /* noop */ }
      try { chrome.tabs.onRemoved.removeListener(onTabRemoved); } catch (e) { /* noop */ }
      if (tabId != null) {
        chrome.tabs.remove(tabId).catch(() => { /* tab may have closed itself */ });
      }
      resolve(payload);
    };

    const onMessage = (msg, sender) => {
      if (!msg || msg.action !== 'mediaPermissionResult') return;
      if (!sender || !sender.tab || sender.tab.id !== tabId) return;
      settle({ success: !!msg.granted, state: msg.state || (msg.granted ? 'granted' : 'denied') });
    };
    const onTabRemoved = (closedId) => {
      if (closedId === tabId) settle({ success: false, state: 'dismissed' });
    };

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.tabs.onRemoved.addListener(onTabRemoved);

    chrome.tabs.create({ url, active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        settle({ success: false, state: 'tab_error', error: chrome.runtime.lastError && chrome.runtime.lastError.message });
        return;
      }
      tabId = tab.id;
    });

    // Safety: don't hang forever if permission.js never reports back.
    setTimeout(() => settle({ success: false, state: 'timeout' }), 90_000);
  });
}

// Close the offscreen document if nothing is keeping it busy — preview
// toggles are on/off, capture is inactive, no save is pending.
async function maybeCloseOffscreen() {
  if (offscreenCaptureActive) return; // capture still running
  if (videoDataReady && !editorOpenedForThisClip) return; // awaiting editor handoff
  // Ask offscreen if it's idle; if the message fails the doc is already gone.
  const resp = await sendToOffscreen({ type: 'ping' }).catch(() => ({ success: false }));
  if (!resp || !resp.success) return;
  // If previews are still on, offscreen will report captureActive=false but
  // streams are live — just let it sit; the next stopPreview call will close it.
  await closeOffscreen();
}

// Best-effort forward of a control message to any open record.html tabs.
// Returns true if at least one record page acknowledged the message.
async function forwardToRecordPage(action, extra = {}) {
  const recordPageUrl = chrome.runtime.getURL('record.html');
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const recordTabs = tabs.filter((t) => t.url && t.url.startsWith(recordPageUrl));
  let delivered = false;
  for (const rt of recordTabs) {
    try {
      await chrome.tabs.sendMessage(rt.id, { action, ...extra });
      delivered = true;
    } catch (e) {
      // Tab may have been closed; ignore.
    }
  }
  return delivered;
}

// Stop the active recording. In the new flow the record page owns
// MediaRecorder, so we just ask it to stop and save; if no record page is
// around (rare) we fall back to clearing state locally.
async function stopRecording() {
  try {
    console.log('[Background] Stopping recording...');

    if (!isRecording) {
      return { success: false, error: 'No active recording' };
    }

    // Ask any open record.html tabs to stop-and-save. They'll send us
    // `recordingStopped` when done, which finalizes state.
    const forwarded = await forwardToRecordPage('recordingStopped');
    if (!forwarded) {
      await handleRecordingStoppedLocally();
    }

    return { success: true };
  } catch (error) {
    console.error('[Background] Error stopping recording:', error);
    await handleRecordingStoppedLocally();
    return { success: true };
  }
}

async function handleRecordingStoppedLocally() {
  console.log('[Background] Handling recording stop locally');
  
  if (cursorData.length > 0) {
    await saveCursorData();
  }
  
  isRecording = false;
  isPaused = false;
  const tabToCleanup = recordingTabId; // Store before clearing
  const previousTabToCleanup = previousRecordingTabId; // Store previous tab too
  recordingTabId = null;
  previousRecordingTabId = null;
  
  await chrome.storage.local.set({ isRecording: false, isPaused: false, cameraOverlayEnabled: false });
  
  // Remove camera overlay + floating HUD from all tabs
  await Promise.all([
    removeCameraOverlayFromAllTabs(),
    removeRecordingHudFromAllTabs(),
    tabToCleanup ? removeCameraOverlayFromTab(tabToCleanup) : Promise.resolve(),
    previousTabToCleanup ? removeCameraOverlayFromTab(previousTabToCleanup) : Promise.resolve()
  ]).catch((error) => {
    console.warn('[Background] Error during overlay cleanup:', error);
  });
  
  
  // Update icon to clear recording state
  updateRecordingIcon(false);
}

// State-sync helpers: record.html pauses/resumes its own MediaRecorder and
// then sends us `{action:'pauseRecording'|'resumeRecording'}` so the badge,
// storage flag and HUD stay in sync.
// Pause/resume bookkeeping so the HUD timer stays accurate across re-injects.
// When paused we remember the wall-clock moment (`pausedAt`) and, when
// resuming, we accumulate the elapsed pause into `pausedAccumulatedMs`. The
// displayed elapsed time is always
//     (isPaused ? pausedAt : Date.now()) - recordingStartTime - pausedAccumulatedMs
let pausedAt = 0;
let pausedAccumulatedMs = 0;

async function pauseRecording() {
  if (!isRecording || isPaused) return;
  isPaused = true;
  pausedAt = Date.now();
  await chrome.storage.local.set({ isPaused: true, pausedAt, pausedAccumulatedMs });
  updateRecordingIcon(true, true);
  broadcastHudSync({ paused: true });
}

async function resumeRecording() {
  if (!isRecording || !isPaused) return;
  isPaused = false;
  if (pausedAt) pausedAccumulatedMs += Date.now() - pausedAt;
  pausedAt = 0;
  await chrome.storage.local.set({ isPaused: false, pausedAt: 0, pausedAccumulatedMs });
  updateRecordingIcon(true, false);
  broadcastHudSync({ paused: false });
}

// Notify the in-page HUD of externally-triggered state changes (e.g. pause via
// keyboard shortcut) so its icons stay correct without round-tripping back to
// background.
function broadcastHudSync(state) {
  if (!recordingTabId) return;
  try {
    chrome.tabs.sendMessage(recordingTabId, { action: 'hudSync', ...state }, () => void chrome.runtime.lastError);
  } catch (e) { /* noop */ }
}

async function saveCursorData() {
  console.log('[Background] Cursor data ready for editor, length:', cursorData.length);
}

// Open editor.html once both the video blob and the cursor data are ready.
// Legacy record.js used to do this itself; in the offscreen flow that
// responsibility lives here. We gate on `editorOpenedForThisClip` so a double
// signal (e.g. storeVideoBlob + recordingStopped both firing in close order)
// doesn't open two editor tabs. Also closes the offscreen document once the
// editor tab is up, so no MediaStreams linger.
async function maybeOpenEditor() {
  if (editorOpenedForThisClip) return;
  if (!videoDataReady || !cursorDataReady) return;
  editorOpenedForThisClip = true;
  try {
    const editorUrl = chrome.runtime.getURL('editor.html');
    await chrome.tabs.create({ url: editorUrl, active: true });
    console.log('[Background] Editor tab opened');
  } catch (e) {
    console.warn('[Background] Could not open editor tab:', e.message);
  }
  // Offscreen's work is done — free the streams + doc.
  try { await closeOffscreen(); } catch (e) { /* noop */ }
}

// Inject camera overlay into the recording tab only
async function injectCameraOverlayToRecordingTab(tabId) {
  try {
    
    if (!tabId) {
      console.log('[Background] Invalid tab ID:', tabId);
      return;
    }
    
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      console.log('[Background] Recording tab not found:', tabId);
      return;
    }
    
    
    // Skip chrome:// and extension pages
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://'))) {
      console.log('[Background] Cannot inject camera overlay into restricted page:', tab.url);
      return;
    }
    
    // Retry injection with minimal delays to ensure page is ready
    let injected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Minimal wait - only on retries
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        // Check if tab is still valid
        const currentTab = await chrome.tabs.get(tabId).catch(() => null);
        if (!currentTab) {
          console.log('[Background] Tab no longer exists:', tabId);
          return;
        }
        
        
        // Inject content script to show camera overlay
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: injectCameraOverlayScript,
          args: []
        });
        
        console.log('[Background] Camera overlay injected into recording tab:', tabId, '(attempt', attempt + 1 + ')');
        injected = true;
        
        
        break;
      } catch (error) {
        console.warn('[Background] Camera overlay injection attempt', attempt + 1, 'failed:', error.message);
        if (attempt === 2) {
        }
      }
    }
    
    if (injected) {
      // Listen for tab updates (navigation) to re-inject overlay (only add once)
      if (!chrome.tabs.onUpdated.hasListener(handleRecordingTabUpdateForCameraOverlay)) {
        chrome.tabs.onUpdated.addListener(handleRecordingTabUpdateForCameraOverlay);
      }
    }
  } catch (error) {
    console.error('[Background] Error injecting camera overlay:', error);
  }
}

// Handle recording tab updates (navigation) for camera overlay
async function handleRecordingTabUpdateForCameraOverlay(tabId, changeInfo, tab) {
  
  if (!isRecording || !cameraOverlayEnabled || tabId !== recordingTabId) {
    return;
  }
  if (changeInfo.status !== 'complete') return;
  
  // Skip chrome:// and extension pages
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://'))) {
    return;
  }
  
  try {
    // Check if overlay already exists
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => !!document.getElementById('wubcast-camera-overlay')
    });
    
    if (!results[0]?.result) {
      // Inject immediately (no delay)
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: injectCameraOverlayScript,
        args: []
      });
      console.log('[Background] Camera overlay re-injected after navigation in recording tab:', tabId);
      
      // Send latest frame immediately after re-injection
      if (cameraFrameData) {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, {
            action: 'updateCameraFrame',
            frameData: cameraFrameData
          }).catch(() => {
            // Tab might not be ready yet, that's okay - periodic requests will handle it
          });
        }, 300);
      }
    }
  } catch (error) {
    console.log('[Background] Could not re-inject camera overlay after navigation:', error.message);
  }
}

// Function to inject camera overlay (runs in page context)
function injectCameraOverlayScript() {
  try {
    
    // Check if overlay already exists
    if (document.getElementById('wubcast-camera-overlay')) {
      console.log('[CameraOverlay] Overlay already exists');
      return;
    }
    
    // Wait for body to be ready
    if (!document.body) {
      console.warn('[CameraOverlay] Document body not ready, waiting...');
      setTimeout(injectCameraOverlayScript, 100);
      return;
    }
    
    // Create overlay container
    const overlay = document.createElement('div');
    overlay.id = 'wubcast-camera-overlay';
    overlay.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 160px;
      height: 160px;
      border-radius: 50%;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      border: 3px solid rgba(255, 255, 255, 0.4);
      z-index: 2147483647;
      background: #000;
      pointer-events: none;
      transition: opacity 0.2s ease-in-out;
      opacity: 1;
    `;
    
    // Use an img element instead of video - we'll update it with frames from record.html
    const img = document.createElement('img');
    img.id = 'wubcast-camera-image';
    img.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1);
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
    `;
    
    // Handle image load errors
    img.onerror = () => {
      console.warn('[CameraOverlay] Image load error, will retry on next frame');
    };
    
    overlay.appendChild(img);
    document.body.appendChild(overlay);
    
    // Track last frame to avoid unnecessary updates and ensure fresh frames
    let lastFrameData = null;
    
    
    console.log('[CameraOverlay] Overlay created and appended to body');
    
    // Listen for camera frame updates from background script
    // Store listener reference for cleanup (prevent duplicate listeners)
    if (window.__cameraOverlayMessageListener) {
      chrome.runtime.onMessage.removeListener(window.__cameraOverlayMessageListener);
    }
    
    
    const messageListener = (message, sender, sendResponse) => {
      
      if (message.action === 'updateCameraFrame' && message.frameData) {
        // Only update if frame data has changed (avoid unnecessary updates)
        if (lastFrameData !== message.frameData) {
          lastFrameData = message.frameData;
          
          // Force image reload by clearing src first, then setting new src
          // This ensures the browser always loads the new frame
          img.src = '';
          
          // Use requestAnimationFrame to ensure DOM update happens before setting new src
          requestAnimationFrame(() => {
            img.src = message.frameData;
          });
          
          console.log('[CameraOverlay] Frame updated');
        }
      }
      return true;
    };
    
    window.__cameraOverlayMessageListener = messageListener;
    chrome.runtime.onMessage.addListener(messageListener);
    
    // Request initial frame from background script and set up periodic frame requests
    const requestFrame = () => {
      chrome.runtime.sendMessage({ action: 'getCameraFrame' }, (response) => {
        // Check for errors
        if (chrome.runtime.lastError) {
          // Silently fail - frames will come via message listener
          return;
        }
        
        if (response && response.frameData) {
          // Always update if we have frame data (periodic requests ensure fresh frames)
          // Don't check lastFrameData here - let the message listener handle deduplication
          // This ensures frames are always fresh even if message listener fails
          img.src = '';
          requestAnimationFrame(() => {
            img.src = response.frameData;
            lastFrameData = response.frameData; // Update tracking
            console.log('[CameraOverlay] Frame updated from periodic request');
          });
        }
      });
    };
    
    // Request initial frame immediately
    requestFrame();
    
    // Also set up periodic requests as fallback (every 100ms) in case message listener fails
    // This ensures frames are always updated even if message listener has issues
    const frameRequestInterval = setInterval(() => {
      const overlay = document.getElementById('wubcast-camera-overlay');
      if (overlay) {
        requestFrame();
      } else {
        clearInterval(frameRequestInterval);
        window.__cameraOverlayFrameRequestInterval = null;
      }
    }, 100); // Increased frequency for smoother updates
    
    // Store interval for cleanup
    window.__cameraOverlayFrameRequestInterval = frameRequestInterval;
  } catch (error) {
    console.error('[CameraOverlay] Error in injection script:', error);
  }
}


// Remove camera overlay from a specific tab
async function removeCameraOverlayFromTab(tabId) {
  if (!tabId) return;
  
  try {
    
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        // Remove message listener to prevent memory leaks
        if (window.__cameraOverlayMessageListener) {
          try {
            chrome.runtime.onMessage.removeListener(window.__cameraOverlayMessageListener);
          } catch (e) {
            // Ignore errors
          }
          window.__cameraOverlayMessageListener = null;
        }
        
        // Clear frame request interval
        if (window.__cameraOverlayFrameRequestInterval) {
          clearInterval(window.__cameraOverlayFrameRequestInterval);
          window.__cameraOverlayFrameRequestInterval = null;
        }
        
        // Remove overlay immediately (no fade-out delay to ensure cleanup)
        const overlay = document.getElementById('wubcast-camera-overlay');
        if (overlay) {
          const img = document.getElementById('wubcast-camera-image');
          if (img) {
            img.src = '';
            img.onerror = null; // Remove error handler
          }
          overlay.remove();
          console.log('[CameraOverlay] Overlay removed from tab');
        }
        
        // Also clear any stored frame data
        if (window.__lastFrameData) {
          window.__lastFrameData = null;
        }
      }
    });
  } catch (error) {
    // Tab may not be scriptable or may have been closed
    console.log('[Background] Could not remove camera overlay from tab', tabId, ':', error.message);
  }
}

// Remove camera overlay from all tabs
async function removeCameraOverlayFromAllTabs() {
  try {
    
    const tabs = await chrome.tabs.query({});
    console.log('[Background] Removing camera overlay from', tabs.length, 'tabs');
    
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Remove message listener
            if (window.__cameraOverlayMessageListener) {
              try {
                chrome.runtime.onMessage.removeListener(window.__cameraOverlayMessageListener);
              } catch (e) {
                // Ignore errors
              }
              window.__cameraOverlayMessageListener = null;
            }
            
            // Clear frame request interval
            if (window.__cameraOverlayFrameRequestInterval) {
              clearInterval(window.__cameraOverlayFrameRequestInterval);
              window.__cameraOverlayFrameRequestInterval = null;
            }
            
            // Remove overlay immediately
            const overlay = document.getElementById('wubcast-camera-overlay');
            if (overlay) {
              const img = document.getElementById('wubcast-camera-image');
              if (img) {
                img.src = '';
                img.onerror = null;
              }
              overlay.remove();
              console.log('[CameraOverlay] Overlay removed from tab', tab.id);
            }
            
            // Clear stored frame data
            if (window.__lastFrameData) {
              window.__lastFrameData = null;
            }
          }
        });
      } catch (error) {
        // Some tabs may not be scriptable
        console.log('[Background] Could not remove camera overlay from tab', tab.id, ':', error.message);
      }
    }
    
    // Remove listener
    if (chrome.tabs.onUpdated.hasListener(handleRecordingTabUpdateForCameraOverlay)) {
      chrome.tabs.onUpdated.removeListener(handleRecordingTabUpdateForCameraOverlay);
    }
    
    // Reset state
    previousRecordingTabId = null;
  } catch (error) {
    console.error('[Background] Error removing camera overlay:', error);
  }
}

// Stop the active recording from anywhere (icon, shortcut, native "Stop sharing"
// bar, HUD, popup). Prefers the offscreen doc; falls back to record.html tabs.
async function stopRecordingFromAnywhere() {
  console.log('[Background] stopRecordingFromAnywhere invoked');
  if (offscreenCaptureActive) {
    const resp = await sendToOffscreen({ type: 'stopCapture' });
    if (resp && resp.success) return;
    console.warn('[Background] stopCapture via offscreen failed; falling back:', resp && resp.error);
  }
  const delivered = await forwardToRecordPage('recordingStopped');
  if (!delivered) {
    await handleRecordingStoppedLocally();
  }
}

// Discard the current recording from the HUD (no editor, no saved clip).
async function cancelRecordingFromAnywhere() {
  console.log('[Background] cancelRecordingFromAnywhere invoked');
  if (offscreenCaptureActive) {
    const resp = await sendToOffscreen({ type: 'cancelCapture' });
    if (resp && resp.success) return;
    console.warn('[Background] cancelCapture via offscreen failed; falling back:', resp && resp.error);
  }
  const delivered = await forwardToRecordPage('cancelRecordingFromHud');
  if (!delivered) {
    await handleRecordingStoppedLocally();
  }
}

// Open the setup surface to begin a new recording. In the offscreen era this
// skips opening record.html entirely — the popup/startCaptureViaOffscreen
// pair handles capture. Falls back to record.html?legacy=1 if offscreen isn't
// available (old Chromium forks).
async function openRecordingSetup(currentTab, options = {}) {
  let targetTabId = currentTab?.id;
  let currentUrl = currentTab?.url;

  if (!currentTab) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        targetTabId = activeTab.id;
        currentUrl = activeTab.url;
      }
    } catch (e) {
      console.warn('[Background] Could not query active tab:', e.message);
    }
  }

  if (currentUrl && isUnsupportedWebsite(currentUrl)) {
    console.warn('[Background] Current tab is restricted:', currentUrl);
    const newTab = await chrome.tabs.create({ url: 'https://www.google.com', active: true });
    targetTabId = newTab.id;
    await new Promise(resolve => {
      const listener = (tabId, info) => {
        if (tabId === newTab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 5000);
    });
    console.log('[Background] New tab ready:', targetTabId);
  }

  // Preferred path: offscreen.
  if (offscreenApiAvailable()) {
    try {
      await startCaptureViaOffscreen(targetTabId, null);
      return;
    } catch (e) {
      console.warn('[Background] Offscreen capture failed, falling back to record.html legacy:', e.message);
    }
  }

  // Fallback path: legacy record.html (pinned tab) — gated on ?legacy=1 so the
  // setup UI shows itself.
  const params = new URLSearchParams();
  if (targetTabId) params.set('tabId', String(targetTabId));
  if (options.autoStart) params.set('autoStart', '1');
  params.set('legacy', '1');
  const recordUrl = chrome.runtime.getURL(`record.html?${params.toString()}`);
  await chrome.tabs.create({ url: recordUrl, pinned: true });
}

// Actually kick off an offscreen-hosted capture. Rejects on unrecoverable
// failure (permission denied, picker cancelled) so callers can fall back.
async function startCaptureViaOffscreen(tabId, prefsOverride) {
  if (!offscreenApiAvailable()) throw new Error('chrome.offscreen API not available');
  const prefs = prefsOverride || (globalThis.WubcastPrefs ? await globalThis.WubcastPrefs.get() : {});
  if (!tabId) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) tabId = activeTab.id;
    } catch (e) { /* noop */ }
  }
  await ensureOffscreen(['DISPLAY_MEDIA', 'USER_MEDIA']);
  const resp = await sendToOffscreen({ type: 'startCapture', prefs, tabId });
  if (!resp || !resp.success) {
    const err = (resp && resp.error) || 'startCapture failed';
    throw new Error(err);
  }
  return resp;
}

// Mirrors the historical `startRecordingWithMediaStream` handler: once the
// offscreen doc tells us MediaRecorder is actually recording, flip state,
// inject HUD + camera overlay and reset the editor handoff gate.
async function onCaptureStarted(message) {
  console.log('[Background] onCaptureStarted tab=', message.tabId, 'camera=', message.cameraOverlayEnabled);
  isRecording = true;
  isPaused = false;
  pausedAt = 0;
  pausedAccumulatedMs = 0;
  offscreenCaptureActive = true;
  cursorData = [];
  recordingStartTime = Date.now();
  videoDataReady = false;
  cursorDataReady = false;
  storedVideoData = null;
  videoStoredInIndexedDB = false;
  editorOpenedForThisClip = false;
  cameraOverlayEnabled = !!message.cameraOverlayEnabled;
  previousRecordingTabId = recordingTabId;
  recordingTabId = message.tabId || recordingTabId;

  await chrome.storage.local.set({
    isRecording: true,
    isPaused: false,
    cameraOverlayEnabled,
    recordingStartTime,
    pausedAt: 0,
    pausedAccumulatedMs: 0
  });
  updateRecordingIcon(true, false);

  if (recordingTabId) {
    injectRecordingHudToTab(recordingTabId);
    // Inject the cursor tracker as soon as recording starts. Without this,
    // content.js only loads on the next tab navigation/switch, so any clicks
    // the user makes on the initial page are silently dropped and the editor
    // gets no data to build zoom segments from.
    reinjectContentScript(recordingTabId).catch(() => {});
    if (cameraOverlayEnabled) {
      if (previousRecordingTabId && previousRecordingTabId !== recordingTabId) {
        removeCameraOverlayFromTab(previousRecordingTabId);
      }
      injectCameraOverlayToRecordingTab(recordingTabId);
    }
  }
}

// Called when offscreen reports capture couldn't start (picker cancelled,
// permission denied). Leaves `isRecording` untouched if we never set it true.
async function resetRecordingStateAfterFailure() {
  offscreenCaptureActive = false;
  // If somehow isRecording flipped true (shouldn't happen before captureStarted),
  // reset it fully.
  if (isRecording) {
    await handleRecordingStoppedLocally();
  }
  // Close offscreen to release any half-acquired streams.
  await closeOffscreen();
}

// Inject a 3-2-1-style countdown overlay into the tab being recorded. Resolves
// after the countdown completes (the overlay removes itself). Silently skips on
// restricted pages — the recording simply starts without a countdown there.
async function showCountdownOnTab(tabId, seconds) {
  if (!tabId || !seconds || seconds < 1) return;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || isUnsupportedWebsite(tab.url)) return;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (count) => new Promise((resolve) => {
        const HOST_ID = 'wubcast-countdown';
        const prev = document.getElementById(HOST_ID);
        if (prev) prev.remove();

        const host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = [
          'position: fixed',
          'inset: 0',
          'display: flex',
          'align-items: center',
          'justify-content: center',
          'z-index: 2147483646',
          'background: rgba(17, 24, 39, 0.35)',
          'pointer-events: none',
          'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          'backdrop-filter: blur(2px)',
          '-webkit-backdrop-filter: blur(2px)'
        ].join(';') + ';';

        const number = document.createElement('div');
        number.textContent = String(count);
        number.style.cssText = [
          'color: #fff',
          'font-size: 200px',
          'font-weight: 800',
          'letter-spacing: -0.03em',
          'text-shadow: 0 10px 40px rgba(0,0,0,0.5), 0 0 80px rgba(129, 140, 248, 0.35)',
          'will-change: transform, opacity'
        ].join(';') + ';';

        host.appendChild(number);
        (document.body || document.documentElement).appendChild(host);

        let current = count;
        // Each number plays in three phases:
        //   0 –  150ms: snap from scale(0.6)/opacity 0 → scale(1)/opacity 1
        //  150 – 700ms: held visible
        //  700 – 1000ms: fade scale(1) → scale(1.3) with opacity → 0
        // Then the next number starts. The previous buggy version set
        // opacity:1 and opacity:0 synchronously within one rAF, so the
        // browser coalesced the paint and the "visible" state never
        // actually rendered — resulting in a brief flash that only ever
        // showed the first digit.
        const showOne = (n, isLast) => {
          number.textContent = String(n);
          number.style.transition = 'none';
          number.style.transform = 'scale(0.6)';
          number.style.opacity = '0';
          // Force a reflow so the initial state is committed before
          // we re-enable the transition below. Without this, the browser
          // collapses both style mutations into the final keyframe and
          // skips the animation entirely.
          void number.offsetHeight;

          number.style.transition = 'transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.18s ease-out';
          number.style.transform = 'scale(1)';
          number.style.opacity = '1';

          setTimeout(() => {
            // For the final "1" we skip the lingering scale-up + fade-out
            // animation entirely and tear the overlay down right now.
            // Otherwise the overlay is still mid-fade when the promise
            // resolves and MediaRecorder.start() fires, so the very first
            // captured frame ends up showing a ghost "1".
            if (isLast) {
              host.remove();
              // Wait for two repaints in the captured tab before resolving so
              // the displayMedia stream definitely has a frame without the
              // overlay before MediaRecorder.start() runs upstream.
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              return;
            }
            number.style.transition = 'transform 0.3s ease-in, opacity 0.3s ease-in';
            number.style.transform = 'scale(1.3)';
            number.style.opacity = '0';
          }, 700);
        };

        const step = () => {
          const isLast = current <= 1;
          showOne(current, isLast);
          current -= 1;
          if (current >= 1) setTimeout(step, 1000);
        };
        step();
      }),
      args: [seconds],
      world: 'ISOLATED'
    });

    // executeScript with a Promise-returning func resolves when the promise settles.
    return results;
  } catch (e) {
    console.warn('[Background] showCountdownOnTab failed:', e.message);
  }
}

// -----------------------------------------------------------------------------
// Recording HUD (floating in-page Stop / Pause / Mute widget)
// -----------------------------------------------------------------------------

// Inject the floating HUD into a tab. Skips restricted URLs. Idempotent — if the
// HUD is already present on the page the content-script guards against double
// injection.
async function injectRecordingHudToTab(tabId) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (isUnsupportedWebsite(tab.url)) {
      console.log('[Background] Skipping HUD injection into unsupported tab:', tab.url);
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['recording-hud.js']
    });
    console.log('[Background] HUD injected into tab', tabId);
  } catch (e) {
    console.warn('[Background] HUD injection failed:', e.message);
  }
}

// Remove the HUD from a specific tab.
async function removeRecordingHudFromTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.getElementById('wubcast-recording-hud');
        if (el && el.parentNode) el.parentNode.removeChild(el);
        if (window.__wubcastHudTickInterval) {
          clearInterval(window.__wubcastHudTickInterval);
          window.__wubcastHudTickInterval = null;
        }
        if (window.__wubcastHudMessageListener) {
          try { chrome.runtime.onMessage.removeListener(window.__wubcastHudMessageListener); } catch (e) { /* noop */ }
          window.__wubcastHudMessageListener = null;
        }
      }
    });
  } catch (e) {
    // Tab may be gone or restricted; safe to ignore.
  }
}

// Remove the HUD from every tab (used on stop).
async function removeRecordingHudFromAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => removeRecordingHudFromTab(t.id)));
  } catch (e) {
    console.warn('[Background] HUD cleanup failed:', e.message);
  }
}

// Handle extension icon click. Note: once a default_popup is wired (Phase 2) this
// listener will no longer fire for the icon; keyboard shortcuts remain authoritative.
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[Background] Extension icon clicked');
  console.log('[Background] Current tab:', tab.id, tab.url);

  if (isRecording) {
    console.log('[Background] Recording in progress, stopping...');
    await stopRecordingFromAnywhere();
    return;
  }

  await openRecordingSetup(tab);
});

// Global keyboard shortcuts. Registered in manifest.json -> commands.
chrome.commands.onCommand.addListener(async (command) => {
  console.log('[Background] Command received:', command);

  if (command === 'toggle-recording') {
    if (isRecording) {
      await stopRecordingFromAnywhere();
    } else {
      await openRecordingSetup(undefined, { autoStart: true });
    }
    return;
  }

  if (command === 'toggle-pause') {
    if (!isRecording) {
      console.log('[Background] Ignoring toggle-pause: not recording');
      return;
    }
    if (offscreenCaptureActive) {
      await sendToOffscreen({ type: isPaused ? 'resumeCapture' : 'pauseCapture' });
      return;
    }
    // Legacy path: ask the record page (owns the MediaRecorder in the old flow).
    const recordPageUrl = chrome.runtime.getURL('record.html');
    let forwarded = false;
    try {
      const allTabs = await chrome.tabs.query({});
      const recordTabs = allTabs.filter(t => t.url && t.url.startsWith(recordPageUrl));
      for (const recordTab of recordTabs) {
        try {
          await chrome.tabs.sendMessage(recordTab.id, {
            action: isPaused ? 'resumeRecordingFromShortcut' : 'pauseRecordingFromShortcut'
          });
          forwarded = true;
        } catch (e) {
          // Record page may be gone; fall through to legacy path below.
        }
      }
    } catch (e) {
      console.warn('[Background] toggle-pause: could not query tabs:', e.message);
    }
    if (!forwarded) {
      if (isPaused) {
        await resumeRecording();
      } else {
        await pauseRecording();
      }
    }
  }
});

// Function to re-inject content script into a tab
async function reinjectContentScript(tabId) {
  if (!isRecording || !tabId) {
    return;
  }
  
  try {
    const tab = await chrome.tabs.get(tabId);
    
    // Skip if it's an unsupported website
    if (isUnsupportedWebsite(tab.url)) {
      console.log('[Background] Skipping re-injection for unsupported website:', tab.url);
      return;
    }
    
    // Check if content script is already injected (by checking if we can send a message)
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      // If ping succeeds, script is already there, just start tracking
      console.log('[Background] Content script already present, starting tracking');
      await chrome.tabs.sendMessage(tabId, { action: 'startTracking' });
      return;
    } catch (e) {
      // Script not present, need to inject
      console.log('[Background] Content script not present, injecting...');
    }
    
    // Inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    
    // Wait for script to load
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Start tracking
    await chrome.tabs.sendMessage(tabId, { action: 'startTracking' });
    console.log('[Background] ✅ Content script re-injected and tracking started on tab:', tabId);
  } catch (error) {
    console.warn('[Background] Failed to re-inject content script:', error.message);
  }
}

// Listen for tab updates (navigation, page loads)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only handle if we're recording and this is the recording tab
  if (!isRecording || tabId !== recordingTabId) {
    return;
  }

  // As soon as Chrome signals the new document is 'loading', try to drop the
  // HUD in. Chrome rejects injection until the new document has a
  // contentscript context so this may no-op and the 'complete' branch below
  // will retry — but when it works it eliminates a several-hundred-ms gap
  // where the HUD is missing between the old page tearing down and the new
  // one finishing load.
  if (changeInfo.status === 'loading' && tab.url) {
    injectRecordingHudToTab(tabId).catch(() => {});
  }

  // When a page finishes loading (status === 'complete'), re-inject content script and overlays
  if (changeInfo.status === 'complete' && tab.url) {
    console.log('[Background] Tab navigation detected, re-injecting content script:', tab.url);
    await reinjectContentScript(tabId);

    // Re-inject floating HUD after navigation.
    injectRecordingHudToTab(tabId);

    // Re-inject camera overlay if enabled (immediately, no delay)
    if (cameraOverlayEnabled) {
      handleRecordingTabUpdateForCameraOverlay(tabId, changeInfo, tab);
    }
  }
});

// Listen for tab activation (tab switches)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Only handle if we're recording
  if (!isRecording) {
    return;
  }
  
  const activeTabId = activeInfo.tabId;
  
  
  // If the active tab is the recording tab, ensure content script is injected
  if (activeTabId === recordingTabId) {
    console.log('[Background] Recording tab activated, ensuring content script is present');
    await reinjectContentScript(activeTabId);

    // Make sure the floating HUD is on this tab.
    injectRecordingHudToTab(activeTabId);

      // Re-inject camera overlay if enabled (immediately, no delay)
      if (cameraOverlayEnabled) {
        injectCameraOverlayToRecordingTab(activeTabId);
        
        // Send latest frame immediately after injection
        if (cameraFrameData) {
          setTimeout(() => {
            chrome.tabs.sendMessage(activeTabId, {
              action: 'updateCameraFrame',
              frameData: cameraFrameData
            }).catch(() => {
              // Tab might not be ready yet, that's okay - periodic requests will handle it
            });
          }, 300);
        }
      }
  } else {
    // User switched to a different tab during recording
    // Remove overlay from previous recording tab FIRST (for smooth transition)
    if (recordingTabId && recordingTabId !== activeTabId) {
      await removeCameraOverlayFromTab(recordingTabId);
    }
    
    // Update recordingTabId to continue tracking in the new tab
    console.log('[Background] Tab switched during recording, updating tracking to new tab:', activeTabId);
    previousRecordingTabId = recordingTabId;
    recordingTabId = activeTabId;
    await reinjectContentScript(activeTabId);

    // Follow the user into the new tab with the floating HUD too.
    if (previousRecordingTabId) {
      removeRecordingHudFromTab(previousRecordingTabId);
    }
    injectRecordingHudToTab(activeTabId);

      // Re-inject camera overlay if enabled (immediately, no delay)
      if (cameraOverlayEnabled) {
        injectCameraOverlayToRecordingTab(activeTabId);
        
        // Send latest frame immediately after injection
        if (cameraFrameData) {
          setTimeout(() => {
            chrome.tabs.sendMessage(activeTabId, {
              action: 'updateCameraFrame',
              frameData: cameraFrameData
            }).catch(() => {
              // Tab might not be ready yet, that's okay - periodic requests will handle it
            });
          }, 300);
        }
      }
  }
});

// Initialize icon state on startup (in case extension was reloaded during recording)
(async () => {
  try {
    const result = await chrome.storage.local.get(['isRecording', 'isPaused']);
    if (result.isRecording) {
      isRecording = true;
      isPaused = result.isPaused || false;
      await updateRecordingIcon(true, isPaused);
    } else {
      await updateRecordingIcon(false);
    }
  } catch (error) {
    console.warn('[Background] Could not initialize icon state:', error);
    // Silently fail - icon will update when recording starts
  }
})();

