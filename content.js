/**
 * WubCast Screen Recorder
 * Copyright (c) 2026 Fasil Minale
 * GitHub: https://github.com/fasilminale
 *
 * Licensed under the MIT License.
 */

// Content Script - Tracks cursor movements, clicks, and keystrokes
// Injection guard to prevent duplicate declarations
if (window.__SCREEN_RECORDER_CONTENT_INJECTED__) {
  console.log('[Content] Already injected, skipping');
} else {
  window.__SCREEN_RECORDER_CONTENT_INJECTED__ = true;
  console.log('[Content] Script loaded on:', window.location.href);

  let isTracking = false;
  let lastSendTime = 0;
  let clickCount = 0;
  let moveCount = 0;
  const SEND_INTERVAL = 50; // Send cursor data every 50ms (clicks are always sent immediately)
  
  // Store handlers for visibility and focus events so they can be removed
  let visibilityChangeHandler = null;
  let focusHandler = null;
  
  // Helper function to check if extension context is still valid
  function isExtensionContextValid() {
    try {
      // Try to access chrome.runtime.id - this will throw if context is invalidated
      return chrome.runtime.id !== undefined;
    } catch (error) {
      return false;
    }
  }
  
  // Helper function to safely call Chrome APIs with error handling
  function safeChromeCall(apiCall, errorCallback) {
    if (!isExtensionContextValid()) {
      const error = new Error('Extension context invalidated');
      if (errorCallback) errorCallback(error);
      return Promise.reject(error);
    }
    
    try {
      const result = apiCall();
      // If it's a promise, add error handling
      if (result && typeof result.catch === 'function') {
        return result.catch((error) => {
          const errorMsg = error?.message || String(error);
          if (errorMsg.includes('Extension context invalidated') || 
              errorMsg.includes('context invalidated') ||
              errorMsg.includes('message port closed')) {
            console.warn('[Content] Extension context invalidated, stopping tracking');
            stopTracking();
          }
          if (errorCallback) errorCallback(error);
          throw error;
        });
      }
      return result;
    } catch (error) {
      const errorMsg = error?.message || String(error);
      if (errorMsg.includes('Extension context invalidated') || 
          errorMsg.includes('context invalidated') ||
          errorMsg.includes('message port closed')) {
        console.warn('[Content] Extension context invalidated, stopping tracking');
        stopTracking();
      }
      if (errorCallback) errorCallback(error);
      return Promise.reject(error);
    }
  }

  // Start tracking cursor
  function startTracking() {
    if (isTracking) {
      console.log('[Content] Already tracking');
      return;
    }
    
    console.log('[Content] 🎯 Starting cursor tracking...');
    isTracking = true;
    clickCount = 0;
    
    // Track mouse movements
    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    
    // Track clicks - use both capture and bubble phase
    document.addEventListener('click', handleClick, true);
    document.addEventListener('mousedown', handleMouseDown, true);
    
    // Track double clicks
    document.addEventListener('dblclick', handleDoubleClick, true);
    
    // Track keystrokes
    document.addEventListener('keydown', handleKeyDown, true);
    
    // Track scroll
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    
    // Re-add visibility and focus handlers if they were removed
    if (!visibilityChangeHandler) {
      visibilityChangeHandler = () => {
        if (document.visibilityState === 'visible') {
          safeChromeCall(() => chrome.storage.local.get(['isRecording']), () => {}).then(result => {
            if (result && result.isRecording && !isTracking) {
              console.log('[Content] Tab became visible, re-starting tracking');
              startTracking();
            }
          }).catch(() => {
            // Extension context may be invalid
          });
        }
      };
      document.addEventListener('visibilitychange', visibilityChangeHandler);
    }
    
    if (!focusHandler) {
      focusHandler = () => {
        safeChromeCall(() => chrome.storage.local.get(['isRecording']), () => {}).then(result => {
          if (result && result.isRecording && !isTracking) {
            console.log('[Content] Window focused, re-starting tracking');
            startTracking();
          }
        }).catch(() => {
          // Extension context may be invalid
        });
      };
      window.addEventListener('focus', focusHandler);
    }
    
    console.log('[Content] ✅ Cursor and keystroke tracking ACTIVE');
  }

  function handleMouseMove(event) {
    if (!isTracking) return;
    
    const now = Date.now();
    
    // Throttle cursor data sending for smooth ~30fps tracking
    if (now - lastSendTime < SEND_INTERVAL) {
      return;
    }
    
    lastSendTime = now;
    moveCount++;
    sendCursorData(event, 'move');
  }

  function handleMouseDown(event) {
    if (!isTracking) return;
    // Also track mousedown for more reliable click detection
    sendCursorData(event, 'mousedown');
  }

  function handleClick(event) {
    if (!isTracking) return;
    clickCount++;
    console.log('[Content] 🖱️ Click #' + clickCount + ' at:', event.clientX, event.clientY);
    sendCursorData(event, 'click');
  }

  function handleDoubleClick(event) {
    if (!isTracking) return;
    console.log('[Content] 🖱️🖱️ Double click at:', event.clientX, event.clientY);
    sendCursorData(event, 'doubleclick');
  }

  function handleKeyDown(event) {
    if (!isTracking) return;
    
    // Don't track if typing in input fields (privacy)
    if (event.target.matches('input, textarea, [contenteditable]')) {
      return;
    }
    
    // Get key display name
    let keyDisplay = getKeyDisplayName(event);
    
    // Only track meaningful keys (shortcuts, navigation, etc.)
    const trackableKeys = [
      'Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
    ];
    
    const isModifierCombo = event.ctrlKey || event.metaKey || event.altKey;
    const isTrackable = trackableKeys.includes(event.key) || isModifierCombo;
    
    if (!isTrackable) return;
    
    sendKeystrokeData(keyDisplay, event);
  }

  function handleScroll(event) {
    if (!isTracking) return;
    
    const now = Date.now();
    if (now - lastSendTime < 100) return;
    
    lastSendTime = now;
    
    safeChromeCall(() => chrome.runtime.sendMessage({
      action: 'cursorMove',
      type: 'scroll',
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      timestamp: now,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }), () => {}).catch(() => {
      // Ignore errors silently
    });
  }

  function getKeyDisplayName(event) {
    const modifiers = [];
    
    if (event.metaKey) modifiers.push('⌘');
    if (event.ctrlKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('⇧');
    
    let key = event.key;
    
    const keyMap = {
      'Enter': '↵',
      'Tab': '⇥',
      'Escape': 'Esc',
      'Backspace': '⌫',
      'Delete': 'Del',
      'ArrowUp': '↑',
      'ArrowDown': '↓',
      'ArrowLeft': '←',
      'ArrowRight': '→',
      'Space': '␣',
      ' ': '␣'
    };
    
    key = keyMap[key] || key.toUpperCase();
    
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
      return modifiers.join('+');
    }
    
    if (modifiers.length > 0) {
      return modifiers.join('+') + '+' + key;
    }
    
    return key;
  }

  function sendCursorData(event, type) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    const clientX = event.clientX;
    const clientY = event.clientY;
    
    // Normalized coordinates (0-1 range)
    const normalizedX = clientX / viewportWidth;
    const normalizedY = clientY / viewportHeight;
    
    // Get element info for click context
    let elementInfo = null;
    if (type === 'click' || type === 'doubleclick' || type === 'mousedown') {
      const target = event.target;
      elementInfo = {
        tagName: target.tagName?.toLowerCase(),
        className: target.className?.toString().slice(0, 50),
        id: target.id,
        text: target.textContent?.slice(0, 30)
      };
    }
    
    const data = {
      action: 'cursorMove',
      x: clientX,
      y: clientY,
      normalizedX: normalizedX,
      normalizedY: normalizedY,
      type: type,
      timestamp: Date.now(),
      viewportWidth: viewportWidth,
      viewportHeight: viewportHeight,
      elementInfo: elementInfo
    };
    
    safeChromeCall(() => chrome.runtime.sendMessage(data), (error) => {
      const errorMsg = error?.message || String(error);
      if (!errorMsg.includes('Extension context invalidated') && 
          !errorMsg.includes('context invalidated') &&
          !errorMsg.includes('message port closed')) {
        console.warn('[Content] Failed to send cursor data:', errorMsg);
      }
    }).then(response => {
      if (type === 'click' && response) {
        console.log('[Content] Click sent to background, response:', response);
      }
    }).catch(() => {
      // Error already handled in safeChromeCall
    });
  }

  function sendKeystrokeData(keyDisplay, event) {
    safeChromeCall(() => chrome.runtime.sendMessage({
      action: 'cursorMove',
      type: 'keystroke',
      key: keyDisplay,
      keyCode: event.code,
      timestamp: Date.now(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }), () => {}).catch(() => {
      // Ignore errors silently
    });
  }

  function stopTracking() {
    if (!isTracking) return;
    
    console.log('[Content] 🛑 Stopping cursor tracking. Total clicks:', clickCount, 'Total moves:', moveCount);
    isTracking = false;
    // Remove event listeners with EXACT same options as addEventListener
    // This is critical - options must match exactly or removal fails silently
    document.removeEventListener('mousemove', handleMouseMove, { passive: true });
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('mousedown', handleMouseDown, true);
    document.removeEventListener('dblclick', handleDoubleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('scroll', handleScroll, { passive: true, capture: true });
    
    // Remove visibility and focus event listeners
    if (visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', visibilityChangeHandler);
      visibilityChangeHandler = null;
    }
    if (focusHandler) {
      window.removeEventListener('focus', focusHandler);
      focusHandler = null;
    }
  }

  // Listen for messages from background/record page
  try {
    if (isExtensionContextValid()) {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log('[Content] Received message:', message.action);
        
        if (message.action === 'startTracking') {
          startTracking();
          sendResponse({ success: true });
        }
        
        if (message.action === 'stopTracking') {
          stopTracking();
          sendResponse({ success: true });
        }
        
        // Handle ping from background script
        if (message.action === 'ping') {
          sendResponse({ success: true });
          return true;
        }
        
        return true;
      });
    }
  } catch (error) {
    console.warn('[Content] Could not set up message listener:', error);
  }

  // Auto-start tracking if recording is already in progress
  safeChromeCall(() => chrome.storage.local.get(['isRecording']), () => {}).then(result => {
    if (result && result.isRecording) {
      console.log('[Content] Recording in progress, auto-starting tracking');
      startTracking();
    }
  }).catch(() => {
    // Extension context may be invalid
  });
  
  // Detect navigation events and notify background script
  // This helps track clicks across page navigations
  let lastUrl = window.location.href;
  
  // Monitor URL changes (for SPA navigation)
  const checkUrlChange = () => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log('[Content] URL changed to:', currentUrl);
      
      // Notify background script about navigation
      safeChromeCall(() => chrome.runtime.sendMessage({
        action: 'pageNavigated',
        url: currentUrl,
        timestamp: Date.now()
      }), () => {}).catch(() => {
        // Ignore errors
      });
      
      // Re-check if recording is active and restart tracking
      safeChromeCall(() => chrome.storage.local.get(['isRecording']), () => {}).then(result => {
        if (result && result.isRecording && !isTracking) {
          console.log('[Content] Recording active after navigation, re-starting tracking');
          startTracking();
        }
      }).catch(() => {});
    }
  };
  
  // Check for URL changes periodically (for SPA navigation)
  setInterval(checkUrlChange, 500);
  
  // Also listen for popstate (back/forward navigation)
  window.addEventListener('popstate', () => {
    setTimeout(checkUrlChange, 100);
  });
  
  // Listen for pushstate/replacestate (programmatic navigation)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    originalPushState.apply(history, args);
    setTimeout(checkUrlChange, 100);
  };
  
  history.replaceState = function(...args) {
    originalReplaceState.apply(history, args);
    setTimeout(checkUrlChange, 100);
  };

  // Handle visibility changes - re-enable tracking when tab becomes visible
  visibilityChangeHandler = () => {
    if (document.visibilityState === 'visible') {
      safeChromeCall(() => chrome.storage.local.get(['isRecording']), () => {}).then(result => {
        if (result && result.isRecording && !isTracking) {
          console.log('[Content] Tab became visible, re-starting tracking');
          startTracking();
        }
      }).catch(() => {
        // Extension context may be invalid
      });
    }
  };
  document.addEventListener('visibilitychange', visibilityChangeHandler);

  // Also listen for focus events as a backup
  focusHandler = () => {
    safeChromeCall(() => chrome.storage.local.get(['isRecording']), () => {}).then(result => {
      if (result && result.isRecording && !isTracking) {
        console.log('[Content] Window focused, re-starting tracking');
        startTracking();
      }
    }).catch(() => {
      // Extension context may be invalid
    });
  };
  window.addEventListener('focus', focusHandler);
}
