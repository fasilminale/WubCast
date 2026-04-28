/**
 * WubCast Screen Recorder
 * Licensed under the MIT License.
 *
 * One-shot permission request runner. The only reason this page exists is
 * that Chrome refuses to surface a camera/microphone permission prompt in
 * an offscreen document — the prompt UI needs a regular tab. So we open
 * this page, call getUserMedia here, and let Chrome cache the decision for
 * the extension origin. After that the offscreen doc can reuse the same
 * stream silently.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const kind = params.get('kind') || 'both'; // 'camera' | 'microphone' | 'both'
  const titleEl = document.getElementById('title');
  const descEl = document.getElementById('description');
  const statusEl = document.getElementById('status');

  const labels = {
    camera: { title: 'Grant camera access', noun: 'camera' },
    microphone: { title: 'Grant microphone access', noun: 'microphone' },
    both: { title: 'Grant camera and microphone access', noun: 'camera and microphone' }
  };
  const label = labels[kind] || labels.both;
  titleEl.textContent = label.title;
  descEl.innerHTML = `Click <strong>Allow</strong> in the browser prompt so recordings can use your ${label.noun}.`;

  const constraints = {};
  if (kind === 'camera' || kind === 'both') {
    constraints.video = { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' };
  }
  if (kind === 'microphone' || kind === 'both') {
    constraints.audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }

  async function report(result) {
    try {
      await chrome.runtime.sendMessage({ action: 'mediaPermissionResult', ...result });
    } catch (e) {
      console.warn('[Permission] Could not notify background:', e);
    }
  }

  async function run() {
    try {
      // Call through a gesture-less path: the tab loaded, Chrome will still
      // show the prompt because this is a regular document under the
      // extension's origin. Some Chromium forks require a user gesture — in
      // that case we'd need a button; the tab is active and visible so the
      // prompt surfaces right above it.
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((t) => t.stop());

      statusEl.classList.add('granted');
      statusEl.textContent = 'Thanks! Access granted. Closing this tab…';
      await report({ granted: true, state: 'granted', kind });
      setTimeout(() => { try { window.close(); } catch (_) { /* noop */ } }, 400);
    } catch (error) {
      const name = (error && error.name) || 'Error';
      statusEl.classList.add('denied');
      statusEl.textContent = name === 'NotAllowedError'
        ? 'Access was not granted. You can click the extension icon again to retry.'
        : 'Could not access the device: ' + ((error && error.message) || name);
      await report({ granted: false, state: name, kind });
      setTimeout(() => { try { window.close(); } catch (_) { /* noop */ } }, 1400);
    }
  }

  // Give the DOM a frame to render so the user sees context before the
  // prompt pops over it — otherwise it looks like the prompt came out of
  // nowhere.
  setTimeout(run, 120);
})();
