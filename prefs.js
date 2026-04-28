/**
 * WubCast Screen Recorder
 * Licensed under the MIT License.
 *
 * Shared preferences helper. Consumed by popup.js, record.js and background.js
 * so that "remember my choices" is a single source of truth in chrome.storage.local.
 *
 * Usage:
 *   const prefs = await WubcastPrefs.get();
 *   await WubcastPrefs.set({ cameraEnabled: true });
 *   const unsubscribe = WubcastPrefs.subscribe((newPrefs) => { ... });
 *
 * Shape (all keys have defaults, all off-by-default for media):
 *   cameraEnabled      : boolean   // picture-in-picture webcam
 *   micEnabled         : boolean   // mix voice into the recording
 *   systemAudioEnabled : boolean   // hint: ask for tab/system audio in the picker
 *   trackCursor        : boolean   // record cursor positions for auto zoom
 *   quality            : '4k' | '1440p' | '1080p' | '720p'
 *   fps                : '30' | '60'
 *   sourceHint         : 'screen' | 'window' | 'tab' (hint passed to getDisplayMedia)
 *   countdownSeconds   : 0 | 3 | 5 (pre-record countdown)
 */

(function (root) {
  'use strict';

  const KEY = 'wubcast.prefs';

  const DEFAULTS = Object.freeze({
    cameraEnabled: false,
    micEnabled: false,
    systemAudioEnabled: false,
    trackCursor: true,
    quality: '1080p',
    fps: '30',
    sourceHint: 'screen',
    countdownSeconds: 3
  });

  function hasStorage() {
    return typeof chrome !== 'undefined'
      && chrome.storage
      && chrome.storage.local;
  }

  function mergeDefaults(stored) {
    const out = { ...DEFAULTS };
    if (stored && typeof stored === 'object') {
      for (const k of Object.keys(DEFAULTS)) {
        if (k in stored) out[k] = stored[k];
      }
    }
    return out;
  }

  function get() {
    return new Promise((resolve) => {
      if (!hasStorage()) { resolve({ ...DEFAULTS }); return; }
      try {
        chrome.storage.local.get([KEY], (res) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({ ...DEFAULTS });
            return;
          }
          resolve(mergeDefaults(res && res[KEY]));
        });
      } catch (e) {
        resolve({ ...DEFAULTS });
      }
    });
  }

  async function set(partial) {
    const current = await get();
    const next = mergeDefaults({ ...current, ...(partial || {}) });
    if (!hasStorage()) return next;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [KEY]: next }, () => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(current);
            return;
          }
          resolve(next);
        });
      } catch (e) {
        resolve(current);
      }
    });
  }

  // Subscribe to live updates. Returns an unsubscribe function.
  function subscribe(cb) {
    if (!hasStorage() || !chrome.storage.onChanged) return () => {};
    const handler = (changes, areaName) => {
      if (areaName !== 'local') return;
      if (!Object.prototype.hasOwnProperty.call(changes, KEY)) return;
      const newVal = mergeDefaults(changes[KEY].newValue);
      try { cb(newVal); } catch (e) { /* swallow listener errors */ }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => {
      try { chrome.storage.onChanged.removeListener(handler); } catch (e) { /* noop */ }
    };
  }

  const api = { get, set, subscribe, DEFAULTS, KEY };

  // Expose in every context: window for HTML pages, self/globalThis for service workers.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.WubcastPrefs = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.WubcastPrefs = api;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this));
