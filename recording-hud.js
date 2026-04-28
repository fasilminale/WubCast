/**
 * WubCast Screen Recorder
 * Licensed under the MIT License.
 *
 * Floating in-page HUD injected into the recorded tab while recording is active.
 * Provides a timer plus Stop / Pause / Mic-mute controls so the user doesn't have
 * to hunt for the record page. Draggable; position is persisted per-origin.
 *
 * The HUD talks to background via chrome.runtime.sendMessage:
 *   { action: 'hudStop' }            -> stop and save the recording
 *   { action: 'hudTogglePause' }     -> pause or resume
 *   { action: 'hudToggleMicMute' }   -> toggle microphone track.enabled
 *
 * Background forwards these to the record page (which owns MediaRecorder).
 *
 * This file is also the authoritative "inject HUD" script; background.js calls
 * chrome.scripting.executeScript({ files: ['recording-hud.js'] }) to install it.
 */

(function () {
  'use strict';

  const HUD_ID = 'wubcast-recording-hud';
  const HUD_DRAG_HANDLE_ID = 'wubcast-recording-hud-handle';
  const POSITION_KEY = 'wubcast.hud.position';

  if (document.getElementById(HUD_ID)) {
    return;
  }

  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => {
      try {
        chrome.scripting && chrome.scripting.executeScript; // no-op, keeps reference
      } catch (e) { /* noop */ }
    }, { once: true });
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', install, { once: true });
      return;
    }
  }

  install();

  function install() {
    if (document.getElementById(HUD_ID)) return;
    if (!document.body) {
      setTimeout(install, 50);
      return;
    }

    // Start with the best guess; we'll correct as soon as background or
    // storage answers. Using Date.now() here means a freshly-injected HUD
    // after a navigation flashes 00:00 for at most one tick before snapping
    // to the real elapsed time.
    const state = {
      startTime: Date.now(),
      paused: false,
      pausedAccumulatedMs: 0,
      pausedAtMs: 0,
      micMuted: false
    };

    const host = document.createElement('div');
    host.id = HUD_ID;
    host.style.cssText = [
      'position: fixed',
      'left: auto',
      'right: 24px',
      'bottom: 24px',
      'z-index: 2147483647',
      'width: auto',
      'height: auto',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      'color: #fff',
      'pointer-events: auto',
      'user-select: none',
      '-webkit-user-select: none'
    ].join(';') + ';';

    const shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;

    const style = document.createElement('style');
    style.textContent = `
      /* WubCast HUD palette:
         Ink Black surface + glassy blur so it reads on any page,
         Wub Purple focus ring so controls feel branded,
         universal red pulse for the recording indicator. */
      .hud {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px 6px 12px;
        background: rgba(17, 24, 39, 0.88);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 999px;
        box-shadow: 0 8px 28px rgba(17, 24, 39, 0.35), 0 2px 6px rgba(17, 24, 39, 0.2);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        font-size: 13px;
        line-height: 1;
      }
      .handle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: grab;
        padding: 4px 4px 4px 0;
      }
      .handle:active { cursor: grabbing; }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #EF4444;
        box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6);
        animation: pulse 1.4s ease-out infinite;
      }
      .dot.paused {
        background: #F59E0B;
        animation: none;
      }
      @keyframes pulse {
        0%   { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55); }
        70%  { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
        100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
      }
      .timer {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        letter-spacing: 0.02em;
        min-width: 52px;
        text-align: center;
      }
      .sep {
        width: 1px;
        height: 16px;
        background: rgba(255, 255, 255, 0.12);
        margin: 0 2px;
      }
      button {
        all: unset;
        cursor: pointer;
        width: 30px;
        height: 30px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        color: #fff;
        transition: background 0.12s ease, transform 0.08s ease, color 0.12s ease;
      }
      button:hover { background: rgba(129, 140, 248, 0.22); color: #C7D2FE; }
      button:active { transform: scale(0.94); }
      button:focus-visible { outline: 2px solid #818CF8; outline-offset: 1px; }
      .stop { color: #F87171; }
      .stop:hover { background: rgba(239, 68, 68, 0.22); color: #FCA5A5; }
      .muted { color: #F59E0B; }
      button.armed {
        color: #F87171;
        background: rgba(239, 68, 68, 0.22);
        box-shadow: 0 0 0 1.5px rgba(239, 68, 68, 0.6) inset;
      }
      svg { width: 16px; height: 16px; display: block; }
    `;
    shadow.appendChild(style);

    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.setAttribute('role', 'toolbar');
    hud.setAttribute('aria-label', 'Recording controls');

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.id = HUD_DRAG_HANDLE_ID;
    handle.title = 'Drag to move';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const timer = document.createElement('span');
    timer.className = 'timer';
    timer.textContent = '00:00';

    handle.appendChild(dot);
    handle.appendChild(timer);
    hud.appendChild(handle);

    hud.appendChild(makeSep());

    const pauseBtn = makeButton('pause', 'Pause (Ctrl/Cmd+Shift+P)', iconPause());
    pauseBtn.addEventListener('click', onTogglePause);

    const micBtn = makeButton('mic', 'Toggle microphone mute', iconMicOn());
    micBtn.addEventListener('click', onToggleMic);

    const cancelBtn = makeButton('cancel', 'Discard recording (no save)', iconCancel());
    cancelBtn.addEventListener('click', onCancel);

    const stopBtn = makeButton('stop', 'Stop recording (Ctrl/Cmd+Shift+E)', iconStop());
    stopBtn.classList.add('stop');
    stopBtn.addEventListener('click', onStop);

    hud.appendChild(pauseBtn);
    hud.appendChild(micBtn);
    hud.appendChild(cancelBtn);
    hud.appendChild(makeSep());
    hud.appendChild(stopBtn);

    shadow.appendChild(hud);
    // Start invisible and fade in — content scripts get re-injected after
    // every navigation so the HUD would otherwise pop in abruptly. The
    // transition smooths that flicker.
    host.style.opacity = '0';
    host.style.transition = 'opacity 0.18s ease-out';
    document.body.appendChild(host);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        host.style.opacity = '1';
      });
    });

    restorePosition(host);
    makeDraggable(host, handle);

    const tickInterval = setInterval(() => {
      if (!state.paused) {
        timer.textContent = formatElapsed(elapsedMs());
      }
    }, 200);
    window.__wubcastHudTickInterval = tickInterval;

    // Pull the true recording start time from storage (fast) and from
    // background (authoritative). Whichever answers first wins, and the
    // slower response just re-confirms. This is what keeps the timer from
    // resetting to 00:00 every time the recorded tab navigates.
    try {
      chrome.storage && chrome.storage.local && chrome.storage.local.get(
        ['recordingStartTime', 'pausedAt', 'pausedAccumulatedMs', 'isPaused'],
        (res) => {
          if (chrome.runtime.lastError || !res) return;
          applyStateFromStore(res);
        }
      );
    } catch (e) { /* noop */ }
    try {
      chrome.runtime.sendMessage({ action: 'getRecordingStatus' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        applyStateFromStore(res);
      });
    } catch (e) { /* noop */ }

    function applyStateFromStore(res) {
      if (typeof res.recordingStartTime === 'number' && res.recordingStartTime > 0) {
        state.startTime = res.recordingStartTime;
      }
      if (typeof res.pausedAccumulatedMs === 'number') {
        state.pausedAccumulatedMs = res.pausedAccumulatedMs;
      }
      if (res.isPaused && typeof res.pausedAt === 'number' && res.pausedAt > 0) {
        state.pausedAtMs = res.pausedAt;
        if (!state.paused) applyPausedVisual(true);
      }
      timer.textContent = formatElapsed(elapsedMs());
    }

    function elapsedMs() {
      if (state.paused) {
        return state.pausedAtMs - state.startTime - state.pausedAccumulatedMs;
      }
      return Date.now() - state.startTime - state.pausedAccumulatedMs;
    }

    function onStop() {
      stopBtn.disabled = true;
      try { chrome.runtime.sendMessage({ action: 'hudStop' }, () => void chrome.runtime.lastError); }
      catch (e) { /* extension context may be gone */ }
    }

    function applyPausedVisual(paused) {
      if (paused) {
        if (!state.paused) state.pausedAtMs = Date.now();
        state.paused = true;
        dot.classList.add('paused');
        pauseBtn.replaceChildren(iconPlay());
        pauseBtn.title = 'Resume (Ctrl/Cmd+Shift+P)';
      } else {
        if (state.paused) state.pausedAccumulatedMs += Date.now() - state.pausedAtMs;
        state.paused = false;
        dot.classList.remove('paused');
        pauseBtn.replaceChildren(iconPause());
        pauseBtn.title = 'Pause (Ctrl/Cmd+Shift+P)';
      }
    }

    function applyMicVisual(muted) {
      state.micMuted = muted;
      if (muted) {
        micBtn.classList.add('muted');
        micBtn.replaceChildren(iconMicOff());
        micBtn.title = 'Unmute microphone';
      } else {
        micBtn.classList.remove('muted');
        micBtn.replaceChildren(iconMicOn());
        micBtn.title = 'Mute microphone';
      }
    }

    function onTogglePause() {
      applyPausedVisual(!state.paused);
      try { chrome.runtime.sendMessage({ action: 'hudTogglePause' }, () => void chrome.runtime.lastError); }
      catch (e) { /* noop */ }
    }

    function onToggleMic() {
      applyMicVisual(!state.micMuted);
      try { chrome.runtime.sendMessage({ action: 'hudToggleMicMute', muted: state.micMuted }, () => void chrome.runtime.lastError); }
      catch (e) { /* noop */ }
    }

    function onCancel() {
      // Two-click confirmation: first click asks, second click discards.
      if (cancelBtn.dataset.armed !== '1') {
        cancelBtn.dataset.armed = '1';
        cancelBtn.title = 'Click again to discard';
        cancelBtn.classList.add('armed');
        setTimeout(() => {
          cancelBtn.dataset.armed = '';
          cancelBtn.classList.remove('armed');
          cancelBtn.title = 'Discard recording (no save)';
        }, 2500);
        return;
      }
      cancelBtn.disabled = true;
      stopBtn.disabled = true;
      try { chrome.runtime.sendMessage({ action: 'hudCancel' }, () => void chrome.runtime.lastError); }
      catch (e) { /* noop */ }
    }

    // React to state broadcasts from background (e.g. global shortcut triggered pause).
    const listener = (message) => {
      if (!message || !message.action) return;
      if (message.action === 'hudSync') {
        if (typeof message.paused === 'boolean' && message.paused !== state.paused) {
          applyPausedVisual(message.paused);
        }
        if (typeof message.micMuted === 'boolean' && message.micMuted !== state.micMuted) {
          applyMicVisual(message.micMuted);
        }
      }
      if (message.action === 'hudRemove' || message.action === 'recordingStopped') {
        teardown();
      }
    };
    window.__wubcastHudMessageListener = listener;
    try { chrome.runtime.onMessage.addListener(listener); } catch (e) { /* noop */ }

    function teardown() {
      try { chrome.runtime.onMessage.removeListener(listener); } catch (e) { /* noop */ }
      clearInterval(tickInterval);
      if (host.parentNode) host.parentNode.removeChild(host);
      window.__wubcastHudTickInterval = null;
      window.__wubcastHudMessageListener = null;
    }

    function makeSep() {
      const s = document.createElement('span');
      s.className = 'sep';
      return s;
    }

    function makeButton(kind, title, svgNode) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.dataset.kind = kind;
      b.appendChild(svgNode);
      return b;
    }

    function makeDraggable(target, grip) {
      let dragging = false;
      let startX = 0, startY = 0;
      let origRight = 0, origBottom = 0;

      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        grip.setPointerCapture(e.pointerId);
        const rect = target.getBoundingClientRect();
        origRight = window.innerWidth - rect.right;
        origBottom = window.innerHeight - rect.bottom;
        startX = e.clientX;
        startY = e.clientY;
        e.preventDefault();
      });

      grip.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const newRight = clamp(origRight - dx, 8, window.innerWidth - 120);
        const newBottom = clamp(origBottom - dy, 8, window.innerHeight - 60);
        target.style.right = newRight + 'px';
        target.style.bottom = newBottom + 'px';
        target.style.left = 'auto';
        target.style.top = 'auto';
      });

      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
        savePosition({ right: target.style.right, bottom: target.style.bottom });
      };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    }

    function restorePosition(target) {
      try {
        chrome.storage && chrome.storage.local && chrome.storage.local.get([POSITION_KEY], (res) => {
          if (chrome.runtime.lastError) return;
          const p = res && res[POSITION_KEY];
          if (p && typeof p.right === 'string' && typeof p.bottom === 'string') {
            target.style.right = p.right;
            target.style.bottom = p.bottom;
          }
        });
      } catch (e) { /* noop */ }
    }

    function savePosition(pos) {
      try {
        chrome.storage && chrome.storage.local && chrome.storage.local.set({ [POSITION_KEY]: pos });
      } catch (e) { /* noop */ }
    }

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    function formatElapsed(ms) {
      const totalSec = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }
  }

  function iconStop() {
    return svg('<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>');
  }
  function iconPause() {
    return svg('<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>');
  }
  function iconPlay() {
    return svg('<path d="M7 5l12 7-12 7V5z" fill="currentColor"/>');
  }
  function iconMicOn() {
    return svg('<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" fill="currentColor"/>');
  }
  function iconMicOff() {
    return svg('<path d="M4 4l16 16-1.4 1.4-3.17-3.17A7 7 0 0 1 13 17.92V21h-2v-3.08A7 7 0 0 1 5 11h2a5 5 0 0 0 6.07 4.9l-1.55-1.55A3 3 0 0 1 9 11v-.59L2.6 4 4 4zm5 1a3 3 0 0 1 6 0v5c0 .2-.02.4-.06.58L9 5.58V5z" fill="currentColor"/>');
  }
  function iconCancel() {
    return svg('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>');
  }
  function svg(inner) {
    const ns = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(ns, 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('fill', 'none');
    el.innerHTML = inner;
    return el;
  }
})();
