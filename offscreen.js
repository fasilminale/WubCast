/**
 * WubCast Screen Recorder
 * Licensed under the MIT License.
 *
 * Offscreen document — owns every MediaStream in the extension.
 *
 * The popup can't safely call getUserMedia/getDisplayMedia: it closes as soon
 * as Chrome's permission or picker UI grabs focus, which is where the old
 * "Permission dismissed" bug came from. record.html worked around it by being
 * a real tab, but that tab was ugly and visible during setup.
 *
 * Offscreen docs are a persistent, invisible context authored for exactly
 * this job. They can:
 *   - call getDisplayMedia (reason: 'DISPLAY_MEDIA') to show Chrome's screen
 *     picker even though no tab is focused,
 *   - call getUserMedia (reason: 'USER_MEDIA') for camera + microphone,
 *   - host the MediaRecorder for the full recording duration without getting
 *     suspended by the service-worker lifetime.
 *
 * Message protocol:
 *   Background  -> Offscreen : { target: 'offscreen', type, ... }
 *   Offscreen   -> Background: { action: ... }  (plain, like the rest of the
 *                                                 extension; background just
 *                                                 listens for the relevant
 *                                                 actions.)
 *   Offscreen   -> Popup     : broadcast via chrome.runtime.sendMessage with
 *                               actions 'previewCameraFrame' / 'micLevel' /
 *                               'captureStarted' / 'captureError'. Popup
 *                               filters on action.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State. Intentionally plain globals — the offscreen doc is single-instance
  // per extension, so there's no contention.
  // ---------------------------------------------------------------------------
  let cameraStream = null;       // MediaStream from getUserMedia({video:true})
  let micStream = null;          // MediaStream from getUserMedia({audio:true})
  let displayStream = null;      // MediaStream from getDisplayMedia
  let combinedStream = null;     // What MediaRecorder records (display + mic track)
  let mediaRecorder = null;
  let recordedChunks = [];
  let selectedMimeType = 'video/webm;codecs=vp9';

  let capturePrefs = null;       // Snapshot of prefs at startCapture time
  let captureTabId = null;       // Target tab for HUD / camera overlay routing
  let captureActive = false;
  // True for the window between startCapture() being invoked and
  // MediaRecorder.start() succeeding. Used so a racing stopPreviewCamera /
  // stopPreviewMic (fired when the popup closes) does NOT release the very
  // streams we're about to hand to MediaRecorder. Without this guard the
  // exported recording lost its mic track when the user had both camera and
  // mic enabled, because captureActive only flips true at the very end of
  // startCapture and the popup's pagehide fires in the middle of it.
  let captureStarting = false;
  let capturePaused = false;
  let cancelRequested = false;
  let videoWidth = 1920;
  let videoHeight = 1080;

  // Preview pumps (independent of capture — the popup uses these to render the
  // live camera image and mic meter before the user hits Start).
  let previewCameraActive = false;
  let previewMicActive = false;
  let previewHiddenVideo = null;
  let previewCanvas = null;
  let previewCtx = null;
  let previewRvfcSupported = false;
  let previewPumpToken = 0;      // Incremented on every start/stop so stale rVFC callbacks can self-cancel.
  let previewFallbackTimer = null;

  let micAudioCtx = null;
  let micAnalyser = null;
  let micMeterTimer = null;

  // In-tab camera-overlay pump. Mirrors the now-removed record.js path so the
  // PiP circle on the recorded tab keeps getting frames.
  let overlayCanvas = null;
  let overlayCtx = null;
  let overlayPumpToken = 0;

  console.log('[Offscreen] Document loaded');

  // ---------------------------------------------------------------------------
  // Message dispatcher. Only acts on messages explicitly targeted at us.
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== 'offscreen') return false;

    console.log('[Offscreen] <=', message.type);

    const replyAsync = (promise) => {
      Promise.resolve(promise).then(
        (value) => sendResponse({ success: true, ...(value || {}) }),
        (error) => sendResponse({ success: false, error: error && error.message ? error.message : String(error) })
      );
      return true;
    };

    switch (message.type) {
      case 'startPreviewCamera': return replyAsync(startPreviewCamera());
      case 'stopPreviewCamera':  return replyAsync(stopPreviewCamera());
      case 'startPreviewMic':    return replyAsync(startPreviewMic());
      case 'stopPreviewMic':     return replyAsync(stopPreviewMic());
      case 'startCapture':       return replyAsync(startCapture(message.prefs, message.tabId));
      case 'stopCapture':        return replyAsync(stopCapture({ save: true }));
      case 'cancelCapture':      return replyAsync(stopCapture({ save: false }));
      case 'pauseCapture':       return replyAsync(pauseCapture());
      case 'resumeCapture':      return replyAsync(resumeCapture());
      case 'setMicMuted':        return replyAsync(setMicMuted(!!message.muted));
      case 'ping':
        sendResponse({ success: true, ready: true, captureActive });
        return false;
      default:
        sendResponse({ success: false, error: 'Unknown offscreen message: ' + message.type });
        return false;
    }
  });

  // ---------------------------------------------------------------------------
  // Camera / mic acquisition. Chrome does NOT let an offscreen document host
  // a getUserMedia permission prompt — attempting it returns immediately with
  // `NotAllowedError: Permission dismissed`. The fix is to check the
  // permission state first and, if it's still `prompt`, delegate to a real
  // tab (permission.html) that *can* host the prompt. After the user answers,
  // Chrome caches the decision for the extension origin and getUserMedia
  // here succeeds silently.
  // ---------------------------------------------------------------------------
  async function queryPermissionState(name) {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return 'prompt';
      const status = await navigator.permissions.query({ name });
      return status && status.state ? status.state : 'prompt';
    } catch (e) {
      // `permissions.query({name:'microphone'})` is unsupported in some
      // Chromium forks — fall through and let getUserMedia decide.
      return 'prompt';
    }
  }

  async function ensurePermissionGranted(kind) {
    const permName = kind === 'camera' ? 'camera' : 'microphone';
    const state = await queryPermissionState(permName);
    if (state === 'granted') return true;
    if (state === 'denied') {
      const err = new Error(`${permName} permission denied`);
      err.name = 'NotAllowedError';
      throw err;
    }
    // state === 'prompt': bounce through a visible tab.
    const resp = await chrome.runtime.sendMessage({ action: 'requestMediaPermissionTab', kind: permName });
    if (!resp || !resp.success) {
      const err = new Error(`${permName} permission ${(resp && resp.state) || 'denied'}`);
      err.name = 'NotAllowedError';
      throw err;
    }
    return true;
  }

  async function ensureCameraStream() {
    if (cameraStream && cameraStream.getVideoTracks().some((t) => t.readyState === 'live')) {
      return cameraStream;
    }
    await ensurePermissionGranted('camera');
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
    return cameraStream;
  }

  async function ensureMicStream() {
    if (micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live')) {
      return micStream;
    }
    await ensurePermissionGranted('microphone');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: { ideal: 48000, min: 44100 },
        channelCount: { ideal: 2, min: 1 }
      },
      video: false
    });
    return micStream;
  }

  async function startPreviewCamera() {
    if (previewCameraActive) return { alreadyOn: true };
    try {
      await ensureCameraStream();
    } catch (error) {
      console.warn('[Offscreen] Camera permission failed:', error.name, error.message);
      broadcast({ action: 'previewCameraError', error: error.name || 'NotAllowedError' });
      throw error;
    }
    previewCameraActive = true;
    ensurePreviewCanvas();
    startPreviewPump();
    return {};
  }

  async function stopPreviewCamera() {
    previewCameraActive = false;
    previewPumpToken += 1;
    if (previewFallbackTimer) { clearInterval(previewFallbackTimer); previewFallbackTimer = null; }
    if (previewHiddenVideo) {
      try { previewHiddenVideo.pause(); } catch (_) { /* noop */ }
      previewHiddenVideo.srcObject = null;
      try { previewHiddenVideo.remove(); } catch (_) { /* noop */ }
      previewHiddenVideo = null;
    }
    // Only release the camera stream if it isn't also needed by an active
    // or imminent capture. `captureStarting` guards the window between
    // startCapture() being invoked and MediaRecorder.start() returning —
    // releasing here during that window would stop tracks that are about to
    // be handed to MediaRecorder.
    if (!captureActive && !captureStarting) {
      releaseCameraStream();
    }
    return {};
  }

  function ensurePreviewCanvas() {
    if (previewCanvas) return;
    previewCanvas = document.createElement('canvas');
    previewCanvas.width = 320;
    previewCanvas.height = 240;
    previewCtx = previewCanvas.getContext('2d');
  }

  // Pulls frames directly off the camera track via ImageCapture. We used to
  // use a hidden <video> + drawImage, but offscreen documents don't always
  // run their render loop, so drawImage kept painting black frames.
  // ImageCapture.grabFrame() returns an ImageBitmap straight from the
  // decoder, sidestepping the render pipeline entirely.
  function startPreviewPump() {
    previewPumpToken += 1;
    const myToken = previewPumpToken;

    const track = cameraStream && cameraStream.getVideoTracks()[0];
    if (!track) return;

    let imageCapture = null;
    try {
      imageCapture = new ImageCapture(track);
    } catch (e) {
      console.warn('[Offscreen] ImageCapture unavailable, falling back to video element:', e);
    }

    let inFlight = false;
    const emit = async () => {
      if (!previewCameraActive || myToken !== previewPumpToken) return;
      if (inFlight) return;
      inFlight = true;
      try {
        if (imageCapture) {
          const bitmap = await imageCapture.grabFrame();
          previewCtx.drawImage(bitmap, 0, 0, previewCanvas.width, previewCanvas.height);
          try { bitmap.close(); } catch (_) { /* older Chromes no-op */ }
        } else {
          // Fallback path: make sure the hidden <video> is around and drawable.
          await ensureFallbackPreviewVideo();
          if (previewHiddenVideo && previewHiddenVideo.readyState >= 2) {
            previewCtx.drawImage(previewHiddenVideo, 0, 0, previewCanvas.width, previewCanvas.height);
          } else {
            return;
          }
        }
        const dataUrl = previewCanvas.toDataURL('image/jpeg', 0.7);
        broadcast({ action: 'previewCameraFrame', data: dataUrl });
      } catch (e) {
        // grabFrame can intermittently reject with "Failed to grab frame" when
        // the track is still warming up; swallow and try again next tick.
        if (myToken === previewPumpToken && previewCameraActive) {
          // Only log once per pump to keep the console quiet.
          if (!emit._warned) { console.warn('[Offscreen] preview grabFrame failed:', e.name || e.message); emit._warned = true; }
        }
      } finally {
        inFlight = false;
      }
    };

    previewFallbackTimer = setInterval(emit, 100); // 10fps preview is plenty
    // Kick one frame immediately so the popup doesn't stare at a broken-image
    // placeholder for 100ms longer than it has to.
    emit();
  }

  async function ensureFallbackPreviewVideo() {
    if (previewHiddenVideo) return;
    previewHiddenVideo = document.createElement('video');
    previewHiddenVideo.autoplay = true;
    previewHiddenVideo.muted = true;
    previewHiddenVideo.playsInline = true;
    applyOffscreenVideoStyle(previewHiddenVideo, 320, 240);
    document.body.appendChild(previewHiddenVideo);
    previewHiddenVideo.srcObject = cameraStream;
    try { await previewHiddenVideo.play(); } catch (_) { /* noop */ }
  }

  // Shared style for the hidden decoding videos we create in the offscreen
  // document. Kept off-screen rather than display:none so the compositor
  // still runs the decoder.
  function applyOffscreenVideoStyle(video, width, height) {
    video.width = width;
    video.height = height;
    video.style.position = 'fixed';
    video.style.left = '-10000px';
    video.style.top = '0';
    video.style.width = width + 'px';
    video.style.height = height + 'px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
  }

  function releaseCameraStream() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Mic preview / meter.
  // ---------------------------------------------------------------------------
  async function startPreviewMic() {
    if (previewMicActive) return { alreadyOn: true };
    try {
      await ensureMicStream();
    } catch (error) {
      console.warn('[Offscreen] Mic permission failed:', error.name, error.message);
      broadcast({ action: 'previewMicError', error: error.name || 'NotAllowedError' });
      throw error;
    }
    previewMicActive = true;
    try {
      micAudioCtx = micAudioCtx || new (self.AudioContext || self.webkitAudioContext)();
      const src = micAudioCtx.createMediaStreamSource(micStream);
      micAnalyser = micAudioCtx.createAnalyser();
      micAnalyser.fftSize = 256;
      src.connect(micAnalyser);
      const buffer = new Uint8Array(micAnalyser.frequencyBinCount);
      micMeterTimer = setInterval(() => {
        if (!previewMicActive || !micAnalyser) return;
        micAnalyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = Math.abs(buffer[i] - 128);
          if (v > peak) peak = v;
        }
        broadcast({ action: 'micLevel', peak: peak / 128 });
      }, 33);
    } catch (e) {
      console.warn('[Offscreen] Mic meter init failed:', e);
    }
    return {};
  }

  async function stopPreviewMic() {
    previewMicActive = false;
    if (micMeterTimer) { clearInterval(micMeterTimer); micMeterTimer = null; }
    if (micAnalyser) { try { micAnalyser.disconnect(); } catch (e) { /* noop */ } micAnalyser = null; }
    // Same guard as stopPreviewCamera: don't yank the mic track out from
    // under an in-flight startCapture, or the exported recording will have
    // a silent (ended) audio track even though MediaRecorder thought it had
    // one.
    if (!captureActive && !captureStarting) {
      releaseMicStream();
    }
    broadcast({ action: 'micLevel', peak: 0 });
    return {};
  }

  function releaseMicStream() {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Capture lifecycle. Offscreen owns getDisplayMedia + MediaRecorder.
  // ---------------------------------------------------------------------------
  async function startCapture(prefs, tabId) {
    if (captureActive) throw new Error('Capture already active');
    captureStarting = true;
    capturePrefs = prefs || {};
    captureTabId = tabId || null;
    cancelRequested = false;
    recordedChunks = [];

    // Ensure optional media streams before the screen picker, so if the user
    // hasn't granted camera/mic yet, they see those prompts first and we fail
    // cleanly. The screen picker is the last and most jarring UI, we want it
    // right before the countdown.
    try {
      if (capturePrefs.cameraEnabled) await ensureCameraStream();
      if (capturePrefs.micEnabled)    await ensureMicStream();
    } catch (error) {
      captureStarting = false;
      broadcast({ action: 'captureError', error: error.name || error.message || 'MediaError' });
      throw error;
    }

    // getDisplayMedia picker. Offscreen triggers this — the popup is already
    // closed by this point and Chrome shows its native picker over the
    // currently focused tab.
    try {
      const dm = await acquireDisplayMedia(capturePrefs);
      displayStream = dm;
    } catch (error) {
      console.warn('[Offscreen] getDisplayMedia failed or cancelled:', error.name, error.message);
      captureStarting = false;
      // Release any earlier-acquired optional streams so we don't leave camera
      // lights blinking after a cancelled picker.
      if (!previewCameraActive) releaseCameraStream();
      if (!previewMicActive)    releaseMicStream();
      broadcast({ action: 'captureCancelled', error: error.name || 'NotAllowedError' });
      throw error;
    }

    // Capture the actual video resolution for the save pipeline.
    const vTrack = displayStream.getVideoTracks()[0];
    if (vTrack) {
      const s = vTrack.getSettings();
      videoWidth = s.width || videoWidth;
      videoHeight = s.height || videoHeight;
      // Native "Stop sharing" bar — funnels through our save path so the clip
      // is actually persisted instead of just resetting UI.
      vTrack.onended = () => {
        if (captureActive) stopCapture({ save: true }).catch((e) => console.warn('[Offscreen] stopCapture from track end failed:', e));
      };
    }

    // Build the stream that goes to MediaRecorder: display video + (optional)
    // display audio + (optional) mic. Camera is NOT composited into the
    // recording — it only shows up as a PiP in the recorded tab, which means
    // zero chance of the camera being duplicated inside the screen capture.
    combinedStream = new MediaStream();
    displayStream.getVideoTracks().forEach((t) => combinedStream.addTrack(t));
    displayStream.getAudioTracks().forEach((t) => combinedStream.addTrack(t)); // system audio if user ticked it in the picker
    if (micStream) {
      micStream.getAudioTracks().forEach((t) => combinedStream.addTrack(t));
    }

    // In-tab PiP camera overlay — send JPEG frames to background which
    // forwards them to the recorded tab.
    if (capturePrefs.cameraEnabled && cameraStream) {
      startOverlayPump();
    }

    // Let the badge / HUD / countdown happen before MediaRecorder.start() so
    // we don't eat empty frames. Background handles countdown + sync itself.
    broadcast({
      action: 'captureStarted',
      width: videoWidth,
      height: videoHeight,
      tabId: captureTabId,
      cameraOverlayEnabled: !!capturePrefs.cameraEnabled
    });

    const countdownSeconds = Math.max(0, parseInt(capturePrefs.countdownSeconds, 10) || 0);
    if (countdownSeconds > 0 && captureTabId != null) {
      try {
        await chrome.runtime.sendMessage({ action: 'showCountdown', tabId: captureTabId, seconds: countdownSeconds });
      } catch (e) { /* tab may not be able to host the countdown; keep going */ }
      // Give the captured tab a few extra frames of wall-clock time to fully
      // repaint (and the displayMedia compositor to sample a clean frame)
      // before MediaRecorder.start() runs. Without this buffer the very first
      // encoded frame can still show the trailing "1" from the countdown.
      await new Promise((r) => setTimeout(r, 250));
    }

    // Sync cursor timeline right before MediaRecorder.start(), same contract
    // record.js had with background.
    try { await chrome.runtime.sendMessage({ action: 'syncRecordingStartTime' }); } catch (e) { /* noop */ }

    // Actually start recording. If the stream carries any audio tracks
    // (system audio and/or mic), explicitly pick a mime type that declares
    // an audio codec — otherwise Chrome's MediaRecorder silently encodes
    // video only even though the tracks are on the stream.
    const hasAudio = combinedStream.getAudioTracks().length > 0;
    selectedMimeType = pickMimeType(hasAudio);
    const options = {
      mimeType: selectedMimeType,
      videoBitsPerSecond: bitrateForHeight(videoHeight)
    };
    if (hasAudio) {
      // 192 kbps Opus — near-transparent for voice and music.
      options.audioBitsPerSecond = 192000;
    }
    console.log('[Offscreen] Recording',
      hasAudio ? `with ${combinedStream.getAudioTracks().length} audio track(s)` : 'video only',
      '·', selectedMimeType);
    mediaRecorder = new MediaRecorder(combinedStream, options);
    recordedChunks = [];
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    };
    mediaRecorder.onerror = (event) => {
      console.error('[Offscreen] MediaRecorder error:', event.error);
      broadcast({ action: 'captureError', error: (event.error && event.error.message) || 'MediaRecorderError' });
    };
    mediaRecorder.onstop = async () => {
      console.log('[Offscreen] MediaRecorder stopped, chunks:', recordedChunks.length);
      try {
        if (!cancelRequested) {
          const blob = new Blob(recordedChunks, { type: selectedMimeType });
          if (blob.size > 0) await deliverBlobToBackground(blob);
        }
      } catch (e) {
        console.error('[Offscreen] Error delivering blob:', e);
      }
      teardownAfterStop();
    };

    mediaRecorder.start(1000);
    captureActive = true;
    captureStarting = false;
    capturePaused = false;
    return {
      width: videoWidth,
      height: videoHeight,
      cameraOverlayEnabled: !!capturePrefs.cameraEnabled
    };
  }

  async function acquireDisplayMedia(prefs) {
    const height = parseHeight(prefs.quality);
    const width = Math.floor(height * 16 / 9);
    const frameRate = parseInt(prefs.fps, 10) || 30;

    const videoConstraints = {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: frameRate }
    };
    // The sourceHint ('screen'|'window'|'tab') becomes displaySurface — a
    // preselect hint for Chrome's picker.
    if (prefs.sourceHint) {
      videoConstraints.displaySurface = prefs.sourceHint === 'tab' ? 'browser' : prefs.sourceHint;
    }

    const constraints = {
      video: videoConstraints,
      audio: prefs.systemAudioEnabled ? true : false
    };
    return await navigator.mediaDevices.getDisplayMedia(constraints);
  }

  async function stopCapture({ save }) {
    if (!captureActive && !mediaRecorder) {
      return { alreadyStopped: true };
    }
    cancelRequested = !save;
    captureActive = false;
    captureStarting = false;
    capturePaused = false;
    stopOverlayPump();

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        if (!save) {
          // Detach onstop handlers so the blob doesn't land anywhere.
          mediaRecorder.ondataavailable = null;
        }
        mediaRecorder.stop(); // triggers onstop -> teardownAfterStop()
      } catch (e) {
        console.warn('[Offscreen] mediaRecorder.stop() threw:', e);
        teardownAfterStop();
      }
    } else {
      teardownAfterStop();
    }

    if (!save) {
      try { await chrome.runtime.sendMessage({ action: 'discardRecording' }); } catch (e) { /* noop */ }
    }
    return {};
  }

  function teardownAfterStop() {
    // Stop everything except streams we're keeping alive for previews.
    if (displayStream) {
      displayStream.getTracks().forEach((t) => t.stop());
      displayStream = null;
    }
    if (combinedStream) {
      combinedStream = null;
    }
    if (!previewCameraActive) releaseCameraStream();
    if (!previewMicActive)    releaseMicStream();

    mediaRecorder = null;
    recordedChunks = [];
    capturePrefs = null;
    captureTabId = null;
    cancelRequested = false;

    broadcast({ action: 'captureStopped' });
  }

  async function pauseCapture() {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return { ignored: true };
    mediaRecorder.pause();
    capturePaused = true;
    try { chrome.runtime.sendMessage({ action: 'pauseRecording' }); } catch (e) { /* noop */ }
    return {};
  }

  async function resumeCapture() {
    if (!mediaRecorder || mediaRecorder.state !== 'paused') return { ignored: true };
    mediaRecorder.resume();
    capturePaused = false;
    try { chrome.runtime.sendMessage({ action: 'resumeRecording' }); } catch (e) { /* noop */ }
    return {};
  }

  async function setMicMuted(muted) {
    if (micStream) {
      micStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    }
    return {};
  }

  // ---------------------------------------------------------------------------
  // In-tab camera overlay pump. Sends JPEGs to background which relays them
  // to the content script on the recorded tab.
  // ---------------------------------------------------------------------------
  // In-tab camera overlay pump. Mirrors the preview pump but broadcasts via
  // `updateCameraFrame` (which the content script picks up). Uses
  // ImageCapture.grabFrame() for the same reason as the preview: offscreen
  // docs don't reliably run the render loop, so the old video+drawImage
  // approach painted black frames.
  function startOverlayPump() {
    stopOverlayPump();
    if (!cameraStream) return;
    const track = cameraStream.getVideoTracks()[0];
    if (!track) return;

    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = 480;
    overlayCanvas.height = 360;
    overlayCtx = overlayCanvas.getContext('2d');

    overlayPumpToken += 1;
    const myToken = overlayPumpToken;

    let imageCapture = null;
    try {
      imageCapture = new ImageCapture(track);
    } catch (e) {
      console.warn('[Offscreen] Overlay ImageCapture unavailable:', e);
    }

    let inFlight = false;
    const emit = async () => {
      if (myToken !== overlayPumpToken) return;
      if (!captureActive) return;
      if (inFlight) return;
      inFlight = true;
      try {
        if (imageCapture) {
          const bitmap = await imageCapture.grabFrame();
          overlayCtx.drawImage(bitmap, 0, 0, overlayCanvas.width, overlayCanvas.height);
          try { bitmap.close(); } catch (_) { /* noop */ }
        } else {
          await ensureFallbackOverlayVideo();
          const v = self.__wubcastOverlayVideo;
          if (!v || v.readyState < 2) return;
          overlayCtx.drawImage(v, 0, 0, overlayCanvas.width, overlayCanvas.height);
        }
        const dataUrl = overlayCanvas.toDataURL('image/jpeg', 0.8);
        try { chrome.runtime.sendMessage({ action: 'updateCameraFrame', frameData: dataUrl }); } catch (e) { /* noop */ }
      } catch (e) {
        if (myToken === overlayPumpToken && !emit._warned) {
          console.warn('[Offscreen] overlay grabFrame failed:', e.name || e.message);
          emit._warned = true;
        }
      } finally {
        inFlight = false;
      }
    };

    // ~30fps is plenty for the tiny circular overlay.
    const interval = setInterval(() => {
      if (myToken !== overlayPumpToken) { clearInterval(interval); return; }
      emit();
    }, 33);
    self.__wubcastOverlayInterval = interval;
    emit();
  }

  async function ensureFallbackOverlayVideo() {
    if (self.__wubcastOverlayVideo) return;
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    applyOffscreenVideoStyle(video, 480, 360);
    video.srcObject = cameraStream;
    document.body.appendChild(video);
    try { await video.play(); } catch (_) { /* noop */ }
    self.__wubcastOverlayVideo = video;
  }

  function stopOverlayPump() {
    overlayPumpToken += 1;
    if (self.__wubcastOverlayInterval) {
      clearInterval(self.__wubcastOverlayInterval);
      self.__wubcastOverlayInterval = null;
    }
    if (self.__wubcastOverlayVideo) {
      try { self.__wubcastOverlayVideo.pause(); } catch (e) { /* noop */ }
      try { self.__wubcastOverlayVideo.srcObject = null; } catch (e) { /* noop */ }
      try { self.__wubcastOverlayVideo.remove(); } catch (e) { /* noop */ }
      self.__wubcastOverlayVideo = null;
    }
    overlayCanvas = null;
    overlayCtx = null;
  }

  // ---------------------------------------------------------------------------
  // Blob delivery to background — mirrors record.js's storeVideoBlob contract
  // so the editor pipeline works unchanged.
  // ---------------------------------------------------------------------------
  async function deliverBlobToBackground(blob) {
    const MAX_MESSAGE_SIZE = 40 * 1024 * 1024;
    const useIndexedDB = blob.size > MAX_MESSAGE_SIZE;
    console.log('[Offscreen] Delivering blob:', blob.size, 'bytes, via', useIndexedDB ? 'IndexedDB' : 'message');

    if (useIndexedDB) {
      const videoId = 'video_' + Date.now();
      await storeVideoInIndexedDB(videoId, blob);
      await chrome.runtime.sendMessage({
        action: 'storeVideoBlob',
        videoId,
        useIndexedDB: true,
        size: blob.size,
        width: videoWidth,
        height: videoHeight,
        cameraOverlayEnabled: !!(capturePrefs && capturePrefs.cameraEnabled)
      });
    } else {
      const dataUrl = await blobToDataURL(blob);
      const MAX_B64 = 64 * 1024 * 1024;
      if (dataUrl.length > MAX_B64) {
        // Fall back to IndexedDB for borderline cases where base64 overshoots.
        const videoId = 'video_' + Date.now();
        await storeVideoInIndexedDB(videoId, blob);
        await chrome.runtime.sendMessage({
          action: 'storeVideoBlob',
          videoId,
          useIndexedDB: true,
          size: blob.size,
          width: videoWidth,
          height: videoHeight,
          cameraOverlayEnabled: !!(capturePrefs && capturePrefs.cameraEnabled)
        });
      } else {
        await chrome.runtime.sendMessage({
          action: 'storeVideoBlob',
          videoData: dataUrl,
          useIndexedDB: false,
          size: blob.size,
          width: videoWidth,
          height: videoHeight,
          cameraOverlayEnabled: !!(capturePrefs && capturePrefs.cameraEnabled)
        });
      }
    }

    // Signal end of capture; background will open the editor once cursor data
    // is also ready.
    try { await chrome.runtime.sendMessage({ action: 'recordingStopped' }); } catch (e) { /* noop */ }
  }

  function storeVideoInIndexedDB(videoId, blob) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('WubCastVideoStorage', 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('videos')) {
          db.createObjectStore('videos', { keyPath: 'id' });
        }
      };
      request.onerror = () => reject(new Error('Failed to open IndexedDB'));
      request.onsuccess = (event) => {
        const db = event.target.result;
        const tx = db.transaction(['videos'], 'readwrite');
        tx.objectStore('videos').put({ id: videoId, blob, timestamp: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error('Failed to store video'));
      };
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  function pickMimeType(hasAudio) {
    // When the stream has audio tracks we MUST pick a mimeType whose codec
    // string mentions opus — otherwise MediaRecorder in Chrome drops audio
    // silently even though the tracks are on the stream. Fall back to the
    // video-only list only when there is genuinely no audio.
    const withAudio = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=opus',
      'video/webm'
    ];
    const videoOnly = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4'
    ];
    const candidates = hasAudio ? withAudio : videoOnly;
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return candidates[candidates.length - 1];
  }

  function parseHeight(quality) {
    switch (quality) {
      case '4k':    return 2160;
      case '1440p': return 1440;
      case '720p':  return 720;
      case '1080p':
      default:      return 1080;
    }
  }

  function bitrateForHeight(height) {
    if (height >= 2160) return 20000000;
    if (height >= 1440) return 12000000;
    if (height >= 1080) return 8000000;
    if (height >= 720)  return 5000000;
    return 2500000;
  }

  function broadcast(payload) {
    try {
      chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
    } catch (e) { /* extension may be reloading */ }
  }
})();
