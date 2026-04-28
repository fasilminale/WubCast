/**
 * WubCast Screen Recorder
 * Copyright (c) 2026 Fasil Minale
 * GitHub: https://github.com/fasilminale
 *
 * Licensed under the MIT License.
 */

// Editor Page Controller - WubCast-style Editor with full features
// Production mode: set to false to disable debug logging
// Use window object to share across multiple scripts
if (typeof window !== 'undefined' && typeof window.DEBUG_MODE === 'undefined') {
  window.DEBUG_MODE = false;
}

// Debug logging utility
function debugLog(...args) {
  if (typeof window !== 'undefined' && window.DEBUG_MODE) {
    console.log(...args);
  }
}

// Retrieve video from IndexedDB
async function retrieveVideoFromIndexedDB(videoId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('WubCastVideoStorage', 1);
    
    request.onerror = () => reject(new Error('Failed to open IndexedDB'));
    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction(['videos'], 'readonly');
      const store = transaction.objectStore('videos');
      const getRequest = store.get(videoId);
      
      getRequest.onsuccess = (e) => {
        const result = e.target.result;
        if (result && result.blob) {
          resolve(result.blob);
        } else {
          reject(new Error('Video not found in IndexedDB'));
        }
      };
      
      getRequest.onerror = () => reject(new Error('Failed to retrieve video from IndexedDB'));
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('videos')) {
        db.createObjectStore('videos', { keyPath: 'id' });
      }
    };
  });
}

// State
let cursorData = [];
let zoomSegments = [];
let videoWidth = 1920;
let videoHeight = 1080;
let isPlaying = false;
let animationFrameId = null;
let videoLoaded = false;
let selectedZoomIndex = -1;
let trimHandles = { start: 0, end: 1 };
let undoStack = [];
let redoStack = [];
let cameraOverlayEnabled = false; // Store camera overlay flag at module level

// Drag state
let isDragging = false;
let dragType = null; // 'segment', 'handle-left', 'handle-right', 'trim-start', 'trim-end', 'playhead'
let dragStartX = 0;
let dragStartValue = 0;
let dragSegmentIndex = -1;

// Settings
let settings = {
  background: 'grad-1',
  aspectRatio: 'native',
  applyZoom: true,
  zoomDepth: 'moderate',
  clickStyle: 'orb',
  clickColor: 'white',
  customClickColor: '#ffffff', // Store custom hex color
  clickForce: 'moderate',
  backgroundImage: null, // Store uploaded image data URL
  showBrowserFrame: true, // true = show browser UI, false = hide browser UI (auto-crop)
  showShadow: true // true = show shadow effect, false = hide shadow
};

// Zoom depth values
const zoomDepths = {
  shallow: 1.1,
  moderate: 1.3,
  deep: 1.5,
  maximum: 2.0
};

// Background styles
const backgrounds = {
  'grad-1': 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'grad-2': 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'grad-3': 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'grad-4': 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'grad-5': 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'grad-6': 'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
  'grad-7': 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
  'grad-8': 'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)',
  'white': '#ffffff',
  'black': '#000000',
  'hidden': 'transparent'
};

// Click effect colors
const clickColors = {
  green: '#10b981',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  pink: '#ec4899',
  orange: '#f97316',
  red: '#ef4444',
  white: '#ffffff'
};

let analyzer = null;
let processor = null;

// DOM Elements
let loadingOverlay, emptyState, videoFrame, videoBackground, videoWindow;
let video, previewCanvas, ctx;
let playBtn, currentTimeEl, currentTimeMsEl, totalTimeEl, totalTimeMsEl;
let timelineTrack, timelinePlayhead, zoomSegmentsLayer, timelineRuler;
let trimStartScissor, trimEndScissor, trimOverlayStart, trimOverlayEnd;
let timelineProgressFill;
let trimmedLeft, trimmedRight, playheadElement, timeMarkers, timeDisplay, leftLabel;

// Initialize
document.addEventListener('DOMContentLoaded', function() {
  debugLog('[Editor] DOM loaded');
  
  // Get DOM elements
  loadingOverlay = document.getElementById('loadingOverlay');
  emptyState = document.getElementById('emptyState');
  videoFrame = document.getElementById('videoFrame');
  videoBackground = document.getElementById('videoBackground');
  videoWindow = document.getElementById('videoWindow');
  video = document.getElementById('video');
  previewCanvas = document.getElementById('previewCanvas');
  playBtn = document.getElementById('playBtn');
  currentTimeEl = document.getElementById('currentTime');
  currentTimeMsEl = document.getElementById('currentTimeMs');
  totalTimeEl = document.getElementById('totalTime');
  totalTimeMsEl = document.getElementById('totalTimeMs');
  timelineTrack = document.getElementById('timelineTrack');
  timelinePlayhead = document.getElementById('timelinePlayhead');
  playheadElement = document.getElementById('playhead');
  zoomSegmentsLayer = document.getElementById('zoomSegmentsLayer');
  timelineRuler = document.getElementById('timelineRuler');
  trimStartScissor = document.getElementById('trimStartScissor');
  trimEndScissor = document.getElementById('trimEndScissor');
  trimOverlayStart = document.getElementById('trimOverlayStart');
  trimOverlayEnd = document.getElementById('trimOverlayEnd');
  trimmedLeft = document.getElementById('trimmedLeft');
  trimmedRight = document.getElementById('trimmedRight');
  timeMarkers = document.getElementById('timeMarkers');
  timeDisplay = document.getElementById('timeDisplay');
  leftLabel = document.getElementById('leftLabel');
  timelineProgressFill = document.getElementById('timelineProgressFill');
  
  // Initialize classes
  analyzer = new ZoomAnalyzer();
  processor = new VideoProcessor();
  
  // Setup event listeners
  setupEventListeners();
  setupExportModal();
  setupDragInteractions();
  
  // Initialize UI to match settings
  const showBrowserFrameCheckbox = document.getElementById('showBrowserFrame');
  const showShadowCheckbox = document.getElementById('showShadow');
  if (showBrowserFrameCheckbox) {
    showBrowserFrameCheckbox.checked = settings.showBrowserFrame;
  }
  if (showShadowCheckbox) {
    showShadowCheckbox.checked = settings.showShadow;
  }
  
  // Initialize click animation settings
  const clickEnabledCheckbox = document.getElementById('clickEnabled');
  const clickStyleSelect = document.getElementById('clickStyle');
  if (clickEnabledCheckbox && clickStyleSelect) {
    clickEnabledCheckbox.checked = settings.clickStyle !== 'none';
    clickStyleSelect.value = settings.clickStyle !== 'none' ? 'orb' : 'none';
  }
  
  // Initialize click color selection
  const colorOptions = document.querySelectorAll('.color-option');
  colorOptions.forEach(opt => {
    if (opt.dataset.color === settings.clickColor) {
      opt.classList.add('selected');
    }
  });
  
  // Initialize custom color picker and hex input
  const customColorPicker = document.getElementById('customColorPicker');
  const hexColorInput = document.getElementById('hexColorInput');
  if (customColorPicker && hexColorInput) {
    // Set initial values - use custom color if set, otherwise use preset color
    if (!settings.customClickColor) {
      settings.customClickColor = clickColors[settings.clickColor] || '#ffffff';
    }
    let currentColor = settings.customClickColor;
    // Normalize 3-digit hex to 6-digit for color picker compatibility
    if (currentColor.length === 4 && currentColor.startsWith('#')) {
      currentColor = '#' + currentColor[1] + currentColor[1] + currentColor[2] + currentColor[2] + currentColor[3] + currentColor[3];
      settings.customClickColor = currentColor;
    }
    customColorPicker.value = currentColor;
    hexColorInput.value = currentColor;
  }
  
  // Initialize click intensity
  const clickForceSelect = document.getElementById('clickForce');
  if (clickForceSelect) {
    clickForceSelect.value = settings.clickForce || 'moderate';
  }
  
  // Initialize background tab state
  const bgGrid = document.getElementById('bgGrid');
  const bgTabs = document.querySelectorAll('.bg-tab');
  if (settings.background === 'hidden') {
    bgTabs.forEach(t => t.classList.remove('active'));
    document.querySelector('.bg-tab[data-bg-type="hidden"]')?.classList.add('active');
    if (bgGrid) bgGrid.style.display = 'none';
  } else if (settings.backgroundImage) {
    bgTabs.forEach(t => t.classList.remove('active'));
    document.querySelector('.bg-tab[data-bg-type="upload"]')?.classList.add('active');
    if (bgGrid) bgGrid.style.display = 'none';
  } else {
    bgTabs.forEach(t => t.classList.remove('active'));
    document.querySelector('.bg-tab[data-bg-type="gradient"]')?.classList.add('active');
    if (bgGrid) bgGrid.style.display = 'grid';
  }
  
  // Load data
  init();
});

async function init() {
  try {
    debugLog('[Editor] Fetching recording data...');
    
    let response = null;
    let attempts = 0;
    
    while (!response && attempts < 10) {
      try {
        response = await chrome.runtime.sendMessage({ action: 'getRecordingData' });
        if (response && response.success && response.videoData) {
          debugLog('[Editor] Got recording data');
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
        response = null;
      } catch (e) {
        await new Promise(r => setTimeout(r, 1000));
      }
      attempts++;
    }
    
    if (!response || !response.videoData) {
      showEmptyState();
      return;
    }
    
    cursorData = response.cursorData || [];
    videoWidth = response.videoWidth || 1920;
    videoHeight = response.videoHeight || 1080;
    cameraOverlayEnabled = response.cameraOverlayEnabled || false;
    
    
    // Log cursor data info
    debugLog('[Editor] Cursor data points:', cursorData.length);
    const clicks = cursorData.filter(d => d.type === 'click' || d.type === 'doubleclick');
    debugLog('[Editor] Click events:', clicks.length);
    
    // Validate video data exists
    if (!response.videoData) {
      throw new Error('No video data in response');
    }
    
    let blob;
    
    // Check if video is stored in IndexedDB
    if (response.videoStoredInIndexedDB && typeof response.videoData === 'string' && !response.videoData.startsWith('data:')) {
      // Video is in IndexedDB - retrieve it
      debugLog('[Editor] Video stored in IndexedDB, retrieving with ID:', response.videoData);
      try {
        blob = await retrieveVideoFromIndexedDB(response.videoData);
        debugLog('[Editor] Video retrieved from IndexedDB, size:', blob.size, 'bytes');
      } catch (error) {
        console.error('[Editor] Failed to retrieve video from IndexedDB:', error);
        throw new Error('Failed to retrieve video from IndexedDB: ' + error.message);
      }
    } else {
      // Video is in data URL format - convert to blob
      // Check if videoData is a valid data URL
      if (!response.videoData.startsWith('data:')) {
        console.error('[Editor] Invalid video data format:', response.videoData.substring(0, 100));
        throw new Error('Invalid video data format');
      }
      
      // Load video
      debugLog('[Editor] Loading video from data URL, size:', response.videoData.length, 'chars');
      
      try {
        // FIX: Extract base64 data from data URL and convert directly to blob
        // This avoids fetch() including the data URL prefix in the blob
        // Data URL format: data:video/webm;codecs=vp9,opus;base64,BASE64DATA
        // or simpler: data:video/webm;base64,BASE64DATA
        
        // Find the base64 part - it's everything after the last ";base64,"
        const base64Index = response.videoData.indexOf(';base64,');
        if (base64Index === -1) {
          throw new Error('Invalid data URL format: missing ;base64, separator');
        }
        
        // Extract MIME type (everything between "data:" and first ";")
        const mimeTypeMatch = response.videoData.match(/^data:([^;]+)/);
        const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'video/webm';
        
        // Extract base64 data (everything after ";base64,")
        const base64Data = response.videoData.substring(base64Index + 8); // 8 = length of ";base64,"
        
        debugLog('[Editor] Extracted base64 data, length:', base64Data.length);
        debugLog('[Editor] MIME type:', mimeType);
        
        // Convert base64 string to binary
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Create blob from binary data
        blob = new Blob([bytes], { type: mimeType });
        
      } catch (conversionError) {
        console.error('[Editor] Error converting data URL to blob:', conversionError);
        throw new Error('Failed to convert data URL to blob: ' + (conversionError.message || conversionError.toString()));
      }
    }
    
    if (!blob || blob.size === 0) {
      throw new Error('Video blob is empty - recording may have failed');
    }
    
    debugLog('[Editor] Video blob size:', blob.size, 'bytes');
    
    // Validate blob has WebM magic bytes
    const firstBytes = await blob.slice(0, 4).arrayBuffer();
    const view = new Uint8Array(firstBytes);
    const magicBytes = Array.from(view).map(b => b.toString(16).padStart(2, '0')).join(' ');
    debugLog('[Editor] Reconstructed blob first 4 bytes (hex):', magicBytes);
    
    if (view[0] === 0x1A && view[1] === 0x45 && view[2] === 0xDF && view[3] === 0xA3) {
      debugLog('[Editor] ✅ Reconstructed blob has valid WebM magic bytes');
    } else {
      console.error('[Editor] ⚠️ Reconstructed blob does NOT have valid WebM magic bytes!');
      console.error('[Editor] Expected: 1A 45 DF A3, Got:', magicBytes);
      throw new Error('Video blob is corrupted - invalid WebM format. Magic bytes: ' + magicBytes);
    }
    
    const url = URL.createObjectURL(blob);
    
    try {
      await loadVideo(url);
    } catch (loadError) {
      console.error('[Editor] Error loading video:', loadError);
      // Clean up the object URL
      URL.revokeObjectURL(url);
      throw new Error('Failed to load video: ' + (loadError.message || loadError.toString()));
    }
    
  } catch (error) {
    // Handle Event objects and Error objects properly
    let errorMessage = 'Unknown error';
    let errorDetails = {};
    
    if (error instanceof Error) {
      errorMessage = error.message || 'Unknown error';
      errorDetails = {
        message: error.message,
        stack: error.stack,
        name: error.name
      };
    } else if (error && typeof error === 'object') {
      // Handle Event objects
      if (error.type) {
        errorMessage = `Event error: ${error.type}`;
        errorDetails = {
          type: error.type,
          target: error.target,
          currentTarget: error.currentTarget,
          timeStamp: error.timeStamp
        };
      } else {
        errorMessage = error.toString();
        errorDetails = { error: error };
      }
    } else {
      errorMessage = String(error);
    }
    
    console.error('[Editor] Init error:', error);
    console.error('[Editor] Error details:', errorDetails);
    console.error('[Editor] Error type:', typeof error, error instanceof Error ? '(Error)' : error instanceof Event ? '(Event)' : '(Other)');
    
    // Show user-friendly error message
    if (errorMessage.includes('fetch') || errorMessage.includes('Failed to fetch')) {
      console.error('[Editor] Failed to fetch video data - recording may be empty or corrupted');
      alert('Error: Could not load recording. The recording may be empty or corrupted. Please try recording again.');
    } else if (errorMessage.includes('No video data') || errorMessage.includes('No recording data')) {
      console.error('[Editor] No video data available');
      alert('Error: No recording data found. Please make sure you completed a recording before opening the editor.');
    } else if (errorMessage.includes('empty') || errorMessage.includes('blob is empty')) {
      console.error('[Editor] Video blob is empty');
      alert('Error: The recording appears to be empty. Please try recording again.');
    } else {
      console.error('[Editor] Unknown error loading video:', errorMessage);
      alert('Error loading recording: ' + errorMessage + '\n\nPlease try recording again.');
    }
    
    showEmptyState();
  }
}

function setupEventListeners() {
  // Play button
  playBtn.addEventListener('click', togglePlay);
  
  // New recording button
  document.getElementById('newRecordingBtn').addEventListener('click', startNewRecording);
  document.getElementById('loadVideoBtn').addEventListener('click', loadVideoFromFile);
  
  // Export button
  document.getElementById('exportBtn').addEventListener('click', exportVideo);
  
  // Toolbar buttons
  document.getElementById('resetTimelineBtn').addEventListener('click', resetTimeline);
  
  // Background options (only gradients now)
  document.querySelectorAll('.bg-option').forEach(opt => {
    opt.addEventListener('click', function() {
      const bg = this.dataset.bg;
      document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('selected'));
      this.classList.add('selected');
      settings.background = bg;
      settings.backgroundImage = null; // Clear image when selecting gradient
      updateBackground();
    });
  });
  
  // Background tabs
  document.querySelectorAll('.bg-tab').forEach(tab => {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.bg-tab').forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      
      const bgType = this.dataset.bgType;
      const bgGrid = document.getElementById('bgGrid');
      
      if (bgType === 'gradient') {
        // Show gradient grid
        bgGrid.style.display = 'grid';
        // If no background selected, select first gradient
        if (!settings.background || settings.background === 'hidden' || settings.backgroundImage) {
          settings.background = 'grad-1';
          settings.backgroundImage = null;
          document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('selected'));
          document.querySelector('.bg-option[data-bg="grad-1"]')?.classList.add('selected');
        }
        updateBackground();
      } else if (bgType === 'hidden') {
        // Hide gradient grid, set to hidden
        bgGrid.style.display = 'none';
        settings.background = 'hidden';
        settings.backgroundImage = null;
        updateBackground();
      } else if (bgType === 'upload') {
        // Hide gradient grid, trigger upload
        bgGrid.style.display = 'none';
        uploadBackground();
      }
    });
  });
  
  // Settings dropdowns
  document.getElementById('aspectSelect').addEventListener('change', function() {
    settings.aspectRatio = this.value;
    updateFrameSize();
  });
  
  document.getElementById('zoomDepth').addEventListener('change', function() {
    settings.zoomDepth = this.value;
    if (analyzer) {
      analyzer.ZOOM_LEVEL = zoomDepths[settings.zoomDepth];
      reanalyzeZoom();
    }
  });
  
  // Click animation toggle — quick on/off that remembers last selected style
  let lastClickStyle = settings.clickStyle && settings.clickStyle !== 'none'
    ? settings.clickStyle
    : 'orb';
  document.getElementById('clickEnabled')?.addEventListener('change', function() {
    const clickStyleSelect = document.getElementById('clickStyle');
    if (this.checked) {
      settings.clickStyle = lastClickStyle || 'orb';
    } else {
      if (settings.clickStyle && settings.clickStyle !== 'none') {
        lastClickStyle = settings.clickStyle;
      }
      settings.clickStyle = 'none';
    }
    if (clickStyleSelect) {
      clickStyleSelect.value = settings.clickStyle;
    }
  });

  // Click style dropdown — writes through to settings and syncs the enable toggle
  document.getElementById('clickStyle')?.addEventListener('change', function() {
    settings.clickStyle = this.value;
    if (this.value !== 'none') {
      lastClickStyle = this.value;
    }
    const clickEnabled = document.getElementById('clickEnabled');
    if (clickEnabled) {
      clickEnabled.checked = this.value !== 'none';
    }
  });
  
  // Click color options
  document.querySelectorAll('.color-option').forEach(opt => {
    opt.addEventListener('click', function() {
      document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
      this.classList.add('selected');
      settings.clickColor = this.dataset.color;
      // Update color picker and hex input to match preset color
      const presetColor = clickColors[this.dataset.color];
      if (presetColor) {
        // Ensure preset colors are always 6-digit (they should be, but normalize just in case)
        let normalizedColor = presetColor;
        if (presetColor.length === 4 && presetColor.startsWith('#')) {
          normalizedColor = '#' + presetColor[1] + presetColor[1] + presetColor[2] + presetColor[2] + presetColor[3] + presetColor[3];
        }
        const customColorPicker = document.getElementById('customColorPicker');
        const hexColorInput = document.getElementById('hexColorInput');
        if (customColorPicker) customColorPicker.value = normalizedColor;
        if (hexColorInput) hexColorInput.value = normalizedColor;
        settings.customClickColor = normalizedColor;
      }
    });
  });
  
  // Custom color picker
  const customColorPicker = document.getElementById('customColorPicker');
  if (customColorPicker) {
    customColorPicker.addEventListener('input', function() {
      const color = this.value;
      const hexColorInput = document.getElementById('hexColorInput');
      if (hexColorInput) hexColorInput.value = color;
      settings.customClickColor = color;
      // Deselect preset colors when using custom color
      document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
    });
  }
  
  // Hex color input
  const hexColorInput = document.getElementById('hexColorInput');
  if (hexColorInput) {
    hexColorInput.addEventListener('input', function() {
      let color = this.value.trim();
      // Add # if missing
      if (!color.startsWith('#')) {
        color = '#' + color;
      }
      // Validate hex color
      const hexRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
      if (hexRegex.test(color)) {
        // Normalize 3-digit hex to 6-digit for color picker compatibility
        let normalizedColor = color;
        if (color.length === 4) {
          normalizedColor = '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
        }
        this.value = color; // Keep original format in input for user
        const customColorPicker = document.getElementById('customColorPicker');
        if (customColorPicker) customColorPicker.value = normalizedColor; // Use normalized for picker
        settings.customClickColor = normalizedColor; // Store normalized version
        // Deselect preset colors when using custom color
        document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
      }
    });
    
    hexColorInput.addEventListener('blur', function() {
      let color = this.value.trim();
      // Add # if missing
      if (!color.startsWith('#')) {
        color = '#' + color;
      }
      // Validate and normalize hex color
      const hexRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
      if (hexRegex.test(color)) {
        // Normalize 3-digit hex to 6-digit
        if (color.length === 4) {
          color = '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
        }
        this.value = color;
        const customColorPicker = document.getElementById('customColorPicker');
        if (customColorPicker) customColorPicker.value = color;
        settings.customClickColor = color;
      } else {
        // Reset to current custom color or default
        const currentColor = settings.customClickColor || clickColors[settings.clickColor] || '#ffffff';
        this.value = currentColor;
      }
    });
  }
  
  // Click intensity option
  document.getElementById('clickForce')?.addEventListener('change', function() {
    settings.clickForce = this.value;
  });
  
  // Browser frame toggle
  const showBrowserFrameCheckbox = document.getElementById('showBrowserFrame');
  const showShadowCheckbox = document.getElementById('showShadow');
  
  showBrowserFrameCheckbox?.addEventListener('change', function() {
    settings.showBrowserFrame = this.checked;
    debugLog('[Editor] Browser UI:', settings.showBrowserFrame ? 'shown' : 'hidden (auto-cropped)');
    
    // Update frame size which now handles canvas resizing for all aspect ratios
    if (videoLoaded) {
      updateFrameSize();
    }
  });
  
  // Shadow effect toggle
  showShadowCheckbox?.addEventListener('change', function() {
    settings.showShadow = this.checked;
    debugLog('[Editor] Shadow effect:', settings.showShadow ? 'enabled' : 'disabled');
    
    // Update preview shadow effect
    if (videoWindow) {
      if (settings.showShadow) {
        videoWindow.style.boxShadow = '0 20px 40px rgba(0, 0, 0, 0.4)';
      } else {
        videoWindow.style.boxShadow = 'none';
      }
    }
  });
  
  // Initialize shadow effect on load
  if (showShadowCheckbox && videoWindow) {
    if (settings.showShadow) {
      videoWindow.style.boxShadow = '0 20px 40px rgba(0, 0, 0, 0.4)';
    } else {
      videoWindow.style.boxShadow = 'none';
    }
  }
  
  // Toggle buttons
  document.getElementById('applyZoomToggle').addEventListener('click', function() {
    this.classList.toggle('active');
    settings.applyZoom = this.classList.contains('active');
    if (!settings.applyZoom) {
      videoWindow.style.transform = 'translate(-50%, -50%)';
    }
  });
  
  // Timeline click to seek
  timelineTrack.addEventListener('click', function(e) {
    if (!videoLoaded || !isFinite(video.duration)) return;
    if (isDragging) return;
    if (e.target.closest('.zoom-segment')) return;
    
    const rect = this.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const targetTime = trimHandles.start * video.duration + percent * (trimHandles.end - trimHandles.start) * video.duration;
    video.currentTime = Math.max(0, Math.min(video.duration, targetTime));
  });
  
  // Video events
  video.addEventListener('timeupdate', function() {
    updateTimeline();
    
    // Check if we've reached the end of the trimmed section
    if (isPlaying && video.duration && isFinite(video.duration)) {
      const trimEndTime = trimHandles.end * video.duration;
      if (video.currentTime >= trimEndTime) {
        video.pause();
        video.currentTime = trimHandles.start * video.duration;
        isPlaying = false;
        updatePlayButton();
      }
    }
  });
  video.addEventListener('ended', function() {
    isPlaying = false;
    updatePlayButton();
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.target.matches('input, textarea, select')) return;
    
    switch(e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 5 : 1));
        break;
      case 'ArrowRight':
        video.currentTime = Math.min(video.duration, video.currentTime + (e.shiftKey ? 5 : 1));
        break;
      case 'Home':
        video.currentTime = trimHandles.start * video.duration;
        break;
      case 'End':
        video.currentTime = trimHandles.end * video.duration;
        break;
      case 'Escape':
        deselectAllZooms();
        break;
    }
  });
  
  // Click outside to deselect
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.zoom-segment') && !e.target.closest('.toolbar-btn')) {
      deselectAllZooms();
    }
  });
}

function setupDragInteractions() {
  // Scissor trim handles
  trimStartScissor?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startDrag(e, 'trim-start');
  });
  
  trimEndScissor?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startDrag(e, 'trim-end');
  });
  
  // Global mouse events for dragging
  document.addEventListener('mousemove', handleDrag);
  document.addEventListener('mouseup', endDrag);
  
  // Playhead drag - use timeline container for new widget structure
  const timelineContainerInner = document.querySelector('.timeline-container-inner');
  const clickTarget = timelineContainerInner || timelineTrack;
  
  clickTarget?.addEventListener('mousedown', (e) => {
    // Don't start drag if clicking on trim handles
    if (e.target.closest('.trim-handle')) return;
    if (e.target.closest('.zoom-segment')) return;
    if (!videoLoaded) return;
    
    const rect = timelineContainerInner ? timelineContainerInner.getBoundingClientRect() : timelineTrack.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const clampedPercent = Math.max(0, Math.min(1, percent));
    const targetTime = trimHandles.start * video.duration + clampedPercent * (trimHandles.end - trimHandles.start) * video.duration;
    video.currentTime = Math.max(0, Math.min(video.duration, targetTime));
    
    startDrag(e, 'playhead');
  });
}

function startDrag(e, type, segmentIndex = -1) {
  isDragging = true;
  dragType = type;
  dragStartX = e.clientX;
  dragSegmentIndex = segmentIndex;
  
  if (type === 'trim-start') {
    dragStartValue = trimHandles.start;
    trimStartScissor?.classList.add('active');
  } else if (type === 'trim-end') {
    dragStartValue = trimHandles.end;
    trimEndScissor?.classList.add('active');
  } else if (type === 'segment' && segmentIndex >= 0) {
    dragStartValue = zoomSegments[segmentIndex].startTime;
  } else if (type === 'handle-left' && segmentIndex >= 0) {
    dragStartValue = zoomSegments[segmentIndex].startTime;
  } else if (type === 'handle-right' && segmentIndex >= 0) {
    dragStartValue = zoomSegments[segmentIndex].endTime;
  }
  
  document.body.style.cursor = 'ew-resize';
  document.body.style.userSelect = 'none';
}

function handleDrag(e) {
  if (!isDragging || !videoLoaded) return;
  
  // Get the timeline container for trim handles (new widget structure)
  const timelineContainer = document.querySelector('.timeline-container-inner');
  const containerRect = timelineContainer ? timelineContainer.getBoundingClientRect() : null;
  const trackRect = timelineTrack ? timelineTrack.getBoundingClientRect() : null;
  
  // Use container rect for trim handles, track rect for playhead
  const rect = (dragType === 'trim-start' || dragType === 'trim-end') ? containerRect : trackRect;
  if (!rect) return;
  
  const deltaX = e.clientX - dragStartX;
  const percentDelta = deltaX / rect.width;
  const timeDelta = percentDelta * video.duration * 1000;
  
  if (dragType === 'trim-start') {
    const newStart = Math.max(0, Math.min(trimHandles.end - 0.05, dragStartValue + percentDelta));
    trimHandles.start = newStart;
    // Scrub video to the trim start position
    if (video && video.duration && isFinite(video.duration)) {
      video.currentTime = trimHandles.start * video.duration;
    }
    updateTrimUI();
  } else if (dragType === 'trim-end') {
    const newEnd = Math.max(trimHandles.start + 0.05, Math.min(1, dragStartValue + percentDelta));
    trimHandles.end = newEnd;
    // Scrub video to the trim end position
    if (video && video.duration && isFinite(video.duration)) {
      video.currentTime = trimHandles.end * video.duration;
    }
    updateTrimUI();
  } else if (dragType === 'playhead') {
    const percent = (e.clientX - trackRect.left) / trackRect.width;
    const clampedPercent = Math.max(0, Math.min(1, percent));
    const targetTime = trimHandles.start * video.duration + clampedPercent * (trimHandles.end - trimHandles.start) * video.duration;
    video.currentTime = Math.max(0, Math.min(video.duration, targetTime));
  } else if (dragType === 'segment' && dragSegmentIndex >= 0) {
    const seg = zoomSegments[dragSegmentIndex];
    const duration = seg.endTime - seg.startTime;
    const newStart = Math.max(0, Math.min(video.duration * 1000 - duration, dragStartValue + timeDelta));
    seg.startTime = newStart;
    seg.endTime = newStart + duration;
    renderZoomSegments();
  } else if (dragType === 'handle-left' && dragSegmentIndex >= 0) {
    const seg = zoomSegments[dragSegmentIndex];
    const minDuration = 500; // 0.5s minimum
    const newStart = Math.max(0, Math.min(seg.endTime - minDuration, dragStartValue + timeDelta));
    seg.startTime = newStart;
    renderZoomSegments();
  } else if (dragType === 'handle-right' && dragSegmentIndex >= 0) {
    const seg = zoomSegments[dragSegmentIndex];
    const minDuration = 500;
    const newEnd = Math.max(seg.startTime + minDuration, Math.min(video.duration * 1000, dragStartValue + timeDelta));
    seg.endTime = newEnd;
    renderZoomSegments();
  }
}

function endDrag() {
  if (isDragging && (dragType === 'segment' || dragType === 'handle-left' || dragType === 'handle-right')) {
    saveState();
  }
  
  isDragging = false;
  dragType = null;
  dragSegmentIndex = -1;
  
  trimStartScissor?.classList.remove('active');
  trimEndScissor?.classList.remove('active');
  
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

function updateTrimUI() {
  if (!video || !video.duration || !isFinite(video.duration)) return;
  
  const startPercent = trimHandles.start * 100;
  const endPercent = (1 - trimHandles.end) * 100;
  
  // Update trimmed areas
  if (trimmedLeft) {
    trimmedLeft.style.width = startPercent + '%';
  }
  if (trimmedRight) {
    trimmedRight.style.width = endPercent + '%';
  }
  
  // Update trim handle positions
  if (trimStartScissor) {
    trimStartScissor.style.left = startPercent + '%';
  }
  if (trimEndScissor) {
    trimEndScissor.style.right = (100 - trimHandles.end * 100) + '%';
    trimEndScissor.style.left = 'auto';
  }
  
  // Update label visibility
  if (leftLabel) {
    if (startPercent < 2) {
      leftLabel.style.display = 'flex';
    } else {
      leftLabel.style.display = 'none';
    }
  }
  
  // Update time display
  if (timeDisplay) {
    const startTime = trimHandles.start * video.duration;
    const endTime = trimHandles.end * video.duration;
    const startFormatted = formatTimeWithDecimals(startTime);
    const endFormatted = formatTimeWithDecimals(endTime);
    timeDisplay.textContent = `${startFormatted} - ${endFormatted}`;
  }
  
  // Legacy support for old overlay elements
  if (trimOverlayStart) {
    trimOverlayStart.style.width = startPercent + '%';
  }
  if (trimOverlayEnd) {
    trimOverlayEnd.style.width = endPercent + '%';
  }
}

function saveState() {
  undoStack.push({
    zoomSegments: JSON.parse(JSON.stringify(zoomSegments)),
    trimHandles: { ...trimHandles }
  });
  redoStack = [];
  
  if (undoStack.length > 50) {
    undoStack.shift();
  }
}

function undo() {
  if (undoStack.length === 0) return;
  
  redoStack.push({
    zoomSegments: JSON.parse(JSON.stringify(zoomSegments)),
    trimHandles: { ...trimHandles }
  });
  
  const state = undoStack.pop();
  zoomSegments = state.zoomSegments;
  trimHandles = state.trimHandles;
  
  updateZoomUI();
  updateTrimUI();
}

function redo() {
  if (redoStack.length === 0) return;
  
  undoStack.push({
    zoomSegments: JSON.parse(JSON.stringify(zoomSegments)),
    trimHandles: { ...trimHandles }
  });
  
  const state = redoStack.pop();
  zoomSegments = state.zoomSegments;
  trimHandles = state.trimHandles;
  
  updateZoomUI();
  updateTrimUI();
}

function showEmptyState() {
  loadingOverlay.classList.add('hidden');
  emptyState.classList.remove('hidden');
  videoFrame.classList.add('hidden');
}

function startNewRecording() {
  window.location.href = chrome.runtime.getURL('record.html');
}

function loadVideoFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*';
  input.onchange = async function(e) {
    const file = e.target.files[0];
    if (file) {
      // Clean up previous video and processor
      if (video && video.src) {
        const oldUrl = video.src;
        video.pause();
        video.src = '';
        video.srcObject = null;
        if (oldUrl.startsWith('blob:') || oldUrl.startsWith('data:')) {
          URL.revokeObjectURL(oldUrl);
        }
      }
      
      if (processor) {
        processor.cancel();
        processor = null;
      }
      
      const url = URL.createObjectURL(file);
      cursorData = [];
      videoLoaded = false;
      isPlaying = false;
      await loadVideo(url);
    }
  };
  input.click();
}

async function loadVideo(url) {
  return new Promise((resolve, reject) => {
    // Clear any previous error handlers
    video.onerror = null;
    video.onloadeddata = null;
    
    // Set up error handler FIRST
    video.onerror = function(event) {
      console.error('[Editor] Video error event:', event);
      console.error('[Editor] Video error details:', {
        type: event.type,
        target: event.target,
        error: video.error
      });
      
      if (video.error) {
        const errorMsg = `Video load error: ${video.error.code} - ${video.error.message}`;
        console.error('[Editor]', errorMsg);
        reject(new Error(errorMsg));
      } else {
        reject(new Error('Video failed to load (unknown error)'));
      }
    };
    
    video.src = url;
    // Don't mute - allow audio playback in editor
    video.muted = false;
    
    video.onloadeddata = async function() {
      debugLog('[Editor] Video loaded:', video.videoWidth, 'x', video.videoHeight);
      videoLoaded = true;
      videoWidth = video.videoWidth || 1920;
      videoHeight = video.videoHeight || 1080;
      
      // Handle WebM Infinity duration issue
      let duration = video.duration;
      if (!isFinite(duration) || duration <= 0) {
        debugLog('[Editor] Finding real duration...');
        video.currentTime = Number.MAX_SAFE_INTEGER;
        
        await new Promise((res) => {
          video.onseeked = () => {
            duration = video.duration;
            res();
          };
          setTimeout(() => {
            duration = video.currentTime || 30;
            res();
          }, 2000);
        });
        
        // Reset to start
        video.currentTime = 0;
        await new Promise(res => {
          video.onseeked = res;
          setTimeout(res, 500);
        });
      }
      
      debugLog('[Editor] Video duration:', duration);
      
      // Setup canvas with high-quality rendering for smooth preview
      previewCanvas.width = videoWidth;
      previewCanvas.height = videoHeight;
      ctx = previewCanvas.getContext('2d', { alpha: false, willReadFrequently: false });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
      
      // Setup UI
      updateBackground();
      updateFrameSize();
      updateTimelineRuler();
      generateTimeMarkers();
      analyzeZoom();
      updateTrimUI();
      
      // Initial timeline update
      updateTimeline();
      
      // Hide loading/empty states
      loadingOverlay.classList.add('hidden');
      emptyState.classList.add('hidden');
      videoFrame.classList.remove('hidden');
      
      // Start render loop
      startRenderLoop();
      
      resolve();
    };
    
    // Add timeout to detect if video never loads
    let loadTimeout;
    const originalOnLoadedData = video.onloadeddata;
    video.onloadeddata = async function() {
      if (loadTimeout) {
        clearTimeout(loadTimeout);
        loadTimeout = null;
      }
      if (originalOnLoadedData) {
        await originalOnLoadedData();
      }
    };
    
    loadTimeout = setTimeout(() => {
      if (!videoLoaded) {
        console.error('[Editor] Video load timeout after 30 seconds');
        reject(new Error('Video load timeout - the video file may be corrupted or invalid. Please try recording again.'));
      }
    }, 30000); // 30 second timeout
    
    video.load();
  });
}

function updateTimelineRuler() {
  if (!video.duration || !isFinite(video.duration)) return;
  
  const ticks = timelineRuler.querySelectorAll('span');
  const numTicks = ticks.length;
  
  ticks.forEach((tick, i) => {
    const time = (i / (numTicks - 1)) * video.duration;
    tick.textContent = formatTimeWithSeconds(time);
  });
}

function generateTimeMarkers() {
  if (!timeMarkers || !video || !video.duration || !isFinite(video.duration)) return;
  
  timeMarkers.innerHTML = '';
  const markerCount = 4;
  const duration = video.duration;
  
  for (let i = 0; i <= markerCount; i++) {
    const marker = document.createElement('div');
    marker.className = 'time-marker';
    const time = (duration * i / markerCount);
    marker.textContent = formatTime(time);
    timeMarkers.appendChild(marker);
  }
}

function formatTimeWithSeconds(s) {
  if (!isFinite(s)) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function formatTimeWithDecimals(s) {
  if (!isFinite(s)) return '00:00.00';
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2);
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(5, '0');
}

function updateBackground() {
  if (settings.backgroundImage) {
    // Use uploaded image
    videoBackground.style.background = `url(${settings.backgroundImage}) center/cover`;
    videoBackground.style.display = 'block';
  } else if (settings.background === 'hidden') {
    videoBackground.style.display = 'none';
  } else {
    // Use gradient or solid color
    const bg = backgrounds[settings.background] || backgrounds['grad-1'];
    videoBackground.style.background = bg;
    videoBackground.style.display = 'block';
  }
  
  // Recalculate video window size when background changes (padding changes)
  if (videoLoaded) {
    updateFrameSize();
  }
}

function updateFrameSize() {
  if (!videoLoaded) return;
  
  const container = document.querySelector('.preview-area');
  const maxW = container.clientWidth - 48;
  const maxH = container.clientHeight - 48;
  
  // Calculate the target aspect ratio based on selection
  let targetRatio;
  if (settings.aspectRatio === 'native') {
    targetRatio = videoWidth / videoHeight;
  } else {
    const [w, h] = settings.aspectRatio.split(':').map(Number);
    targetRatio = w / h;
  }
  
  // Calculate frame dimensions (the outer container with background)
  let frameW, frameH;
  if (targetRatio >= 1) {
    frameW = Math.min(maxW, maxH * targetRatio);
    frameH = frameW / targetRatio;
  } else {
    frameH = Math.min(maxH, maxW / targetRatio);
    frameW = frameH * targetRatio;
  }
  
  videoFrame.style.width = frameW + 'px';
  videoFrame.style.height = frameH + 'px';
  
  // Calculate source video dimensions (possibly cropped for browser UI)
  let sourceHeight = videoHeight;
  if (!settings.showBrowserFrame) {
    const browserUIHeight = Math.min(105, Math.floor(videoHeight * 0.08) + 5);
    sourceHeight = videoHeight - browserUIHeight;
  }
  const sourceAspect = videoWidth / sourceHeight;
  
  // Calculate video window size to fit within frame (with padding)
  // The video window should be centered and maintain the source video's aspect ratio
  const padding = settings.background === 'hidden' ? 0 : 24;
  const availableW = frameW - (padding * 2);
  const availableH = frameH - (padding * 2);
  
  let windowW, windowH;
  if (sourceAspect > (availableW / availableH)) {
    // Video is wider than available space - fit to width
    windowW = availableW;
    windowH = availableW / sourceAspect;
  } else {
    // Video is taller than available space - fit to height
    windowH = availableH;
    windowW = availableH * sourceAspect;
  }
  
  // Apply video window dimensions
  videoWindow.style.width = windowW + 'px';
  videoWindow.style.height = windowH + 'px';
  
  // Ensure video window is centered (CSS transform might not be applied yet)
  videoWindow.style.transform = 'translate(-50%, -50%)';
  
  // Canvas should match source video dimensions (we'll draw to it at source resolution)
  previewCanvas.width = videoWidth;
  previewCanvas.height = sourceHeight;
  
  // Reinitialize canvas context after resize with high-quality rendering
  ctx = previewCanvas.getContext('2d', { alpha: false, willReadFrequently: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

function analyzeZoom() {
  debugLog('[Editor] analyzeZoom called');
  
  if (!analyzer || !settings.applyZoom) {
    zoomSegments = [];
    updateZoomUI();
    return;
  }
  
  const clicks = cursorData.filter(d => d.type === 'click' || d.type === 'doubleclick');
  debugLog('[Editor] Clicks to analyze:', clicks.length);
  
  analyzer.ZOOM_LEVEL = zoomDepths[settings.zoomDepth];
  zoomSegments = analyzer.analyzeClicks(cursorData, videoWidth, videoHeight);
  debugLog('[Editor] ✅ Found', zoomSegments.length, 'zoom segments');
  
  updateZoomUI();
}

function reanalyzeZoom() {
  analyzeZoom();
}

function updateZoomUI() {
  const badge = document.getElementById('zoomCountBadge');
  if (badge) {
    badge.textContent = zoomSegments.length + (zoomSegments.length === 1 ? ' zoom' : ' zooms');
  }
  
  document.getElementById('zoomCount').textContent = zoomSegments.length;
  updateZoomList();
  renderZoomSegments();
}

function renderZoomSegments() {
  // Zoom segments are not displayed in the simple timeline
  // They still work in the background for the zoom/pan effect
}

function selectZoom(index) {
  selectedZoomIndex = index;
  renderZoomSegments();
  
  // Scroll to time
  if (index >= 0 && index < zoomSegments.length) {
    video.currentTime = zoomSegments[index].startTime / 1000;
  }
}

function deselectAllZooms() {
  selectedZoomIndex = -1;
  renderZoomSegments();
}

function updateZoomList() {
  const zoomList = document.getElementById('zoomList');
  if (!zoomList) return;
  
  if (zoomSegments.length === 0) {
    zoomList.innerHTML = '<p style="color: var(--text-muted); font-size: 13px; padding: 12px; text-align: center;">Click "Add Zoom" to create zoom effects</p>';
    return;
  }
  
  zoomList.innerHTML = '';
  zoomSegments.forEach((seg, i) => {
    const duration = ((seg.endTime - seg.startTime) / 1000).toFixed(1);
    const clicks = seg.clickCount || 1;
    
    const item = document.createElement('div');
    item.className = 'zoom-list-item';
    item.style.cssText = `
      padding: 10px; 
      background: ${i === selectedZoomIndex ? 'var(--accent-light)' : 'var(--bg-main)'}; 
      border-radius: 8px; 
      margin-bottom: 8px; 
      cursor: pointer; 
      transition: all 0.15s; 
      border: 2px solid ${i === selectedZoomIndex ? 'var(--accent)' : 'transparent'};
    `;
    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-weight: 500; font-size: 13px;">${formatTime(seg.startTime / 1000)}</span>
        <div style="display: flex; gap: 6px; align-items: center;">
          <span style="font-size: 11px; background: var(--accent-light); color: var(--accent); padding: 2px 8px; border-radius: 4px;">${duration}s</span>
          <button class="zoom-delete-btn" data-index="${i}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 16px;">×</button>
        </div>
      </div>
    `;
    
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('zoom-delete-btn')) {
        e.stopPropagation();
        saveState();
        zoomSegments.splice(i, 1);
        if (selectedZoomIndex === i) selectedZoomIndex = -1;
        else if (selectedZoomIndex > i) selectedZoomIndex--;
        updateZoomUI();
        return;
      }
      selectZoom(i);
    });
    
    zoomList.appendChild(item);
  });
}

function addZoomAtCurrentTime() {
  if (!videoLoaded) return;
  
  saveState();
  
  const time = video.currentTime * 1000;
  const zoomLevel = zoomDepths[settings.zoomDepth] || 1.3;
  
  // Create a zoom segment with proper position data
  // The zoom will center on the middle of the video
  const centerX = videoWidth / 2;
  const centerY = videoHeight / 2;
  
  // Create segment structure compatible with the analyzer
  // The analyzer expects positions with timestamps for panning
  const newSegment = {
    startTime: time,
    endTime: time + 3000, // 3 second zoom
    positions: [{ 
      x: centerX, 
      y: centerY, 
      normalizedX: 0.5,
      normalizedY: 0.5,
      timestamp: time + 1000 // Click happens 1s into the segment (after zoom-in)
    }],
    zoomLevel: zoomLevel,
    clickCount: 1,
    // Also store center for fallback
    centerX: centerX,
    centerY: centerY
  };
  
  zoomSegments.push(newSegment);
  zoomSegments.sort((a, b) => a.startTime - b.startTime);
  
  // Select the new segment
  selectedZoomIndex = zoomSegments.findIndex(s => s === newSegment);
  
  debugLog('[Editor] Added zoom segment:', newSegment);
  debugLog('[Editor] Total zoom segments:', zoomSegments.length);
  
  updateZoomUI();
}

function deleteSelectedZoom() {
  if (selectedZoomIndex >= 0 && selectedZoomIndex < zoomSegments.length) {
    saveState();
    zoomSegments.splice(selectedZoomIndex, 1);
    selectedZoomIndex = -1;
    updateZoomUI();
  }
}

function resetTimeline() {
  // Just reset trim handles to start and end
  trimHandles = { start: 0, end: 1 };
  if (video && video.duration) {
    video.currentTime = 0;
  }
  if (isPlaying) {
    video.pause();
    isPlaying = false;
    updatePlayButton();
  }
  updateTrimUI();
  if (playheadElement) {
    playheadElement.style.left = '0%';
  }
  if (timelinePlayhead) {
    timelinePlayhead.style.left = '0%';
  }
}

function togglePlay() {
  if (!videoLoaded) return;
  
  if (isPlaying) {
    video.pause();
    isPlaying = false;
  } else {
    // Start playback from trimmed start position
    const trimStartTime = trimHandles.start * video.duration;
    const trimEndTime = trimHandles.end * video.duration;
    
    // If current time is outside trimmed range, jump to start
    if (video.currentTime < trimStartTime || video.currentTime >= trimEndTime) {
      video.currentTime = trimStartTime;
    }
    
    video.play();
    isPlaying = true;
  }
  updatePlayButton();
}

function updatePlayButton() {
  if (isPlaying) {
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  } else {
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  }
}

function updateTimeline() {
  if (!video || !video.duration || !isFinite(video.duration)) return;
  
  // Calculate playhead position as percentage of full video
  const percent = (video.currentTime / video.duration) * 100;
  
  // Update playhead position (new widget)
  if (playheadElement) {
    playheadElement.style.left = Math.max(0, Math.min(100, percent)) + '%';
  }
  
  // Update playhead position (legacy)
  if (timelinePlayhead) {
    timelinePlayhead.style.left = Math.max(0, Math.min(100, percent)) + '%';
  }
  
  // Update progress bar
  if (timelineProgressFill) {
    timelineProgressFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  }
  
  // Update time display with milliseconds
  const currentMs = Math.floor((video.currentTime % 1) * 100);
  const totalMs = Math.floor((video.duration % 1) * 100);
  
  if (currentTimeEl) currentTimeEl.textContent = formatTime(video.currentTime);
  if (currentTimeMsEl) currentTimeMsEl.textContent = String(currentMs).padStart(2, '0');
  if (totalTimeEl) totalTimeEl.textContent = formatTime(video.duration);
  if (totalTimeMsEl) totalTimeMsEl.textContent = String(totalMs).padStart(2, '0');
}

function formatTime(s) {
  if (!isFinite(s)) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function formatTimeShort(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

// Render loop - applies zoom effect to video window
function startRenderLoop() {
  function render() {
    if (!videoLoaded || !ctx) {
      animationFrameId = requestAnimationFrame(render);
      return;
    }
    
    // Calculate source dimensions (possibly cropped)
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = videoWidth;
    let sourceHeight = videoHeight;
    
    if (!settings.showBrowserFrame) {
      // Auto-crop browser UI from top (address bar + tabs)
      const browserUIHeight = Math.min(105, Math.floor(videoHeight * 0.08) + 5);
      sourceY = browserUIHeight;
      sourceHeight = videoHeight - browserUIHeight;
    }
    
    // Draw video to canvas with high-quality smoothing (canvas is sized to match source, centering is handled by CSS)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, previewCanvas.width, previewCanvas.height);
    
    // Draw click effects on canvas preview
    if (settings.clickStyle !== 'none') {
      drawClickEffectsOnCanvas();
    }
    
    // Apply zoom to video window using the analyzer
    // Note: videoWindow uses transform: translate(-50%, -50%) for centering,
    // so we need to preserve that and add zoom on top
    if (settings.applyZoom && zoomSegments.length > 0 && analyzer) {
      const timestamp = video.currentTime * 1000;
      const zoomState = analyzer.getZoomAtTime(timestamp, zoomSegments, videoWidth, videoHeight);
      
      if (zoomState.active && zoomState.level > 1.01) {
        const scale = zoomState.level;
        const normX = zoomState.x / videoWidth;
        const normY = zoomState.y / videoHeight;
        // Moderate panning range for preview to match exported video (2.0x multiplier)
        const panMultiplier = 2.0;
        const panX = (0.5 - normX) * (scale - 1) * 100 * panMultiplier;
        const panY = (0.5 - normY) * (scale - 1) * 100 * panMultiplier;
        
        // Combine centering transform with zoom/pan
        videoWindow.style.transform = `translate(-50%, -50%) scale(${scale}) translate(${panX}%, ${panY}%)`;
      } else {
        videoWindow.style.transform = 'translate(-50%, -50%)';
      }
    } else {
      videoWindow.style.transform = 'translate(-50%, -50%)';
    }
    
    animationFrameId = requestAnimationFrame(render);
  }
  
  render();
}


function drawClickEffectsOnCanvas() {
  if (!cursorData || cursorData.length === 0) return;

  const style = settings.clickStyle || 'orb';
  if (style === 'none') return;

  const timestamp = video.currentTime * 1000;

  const clicks = cursorData.filter(d => d.type === 'click' || d.type === 'doubleclick');
  if (clicks.length === 0) return;

  const pressMap = (style === 'pulse') ? pairPressReleasePreview(cursorData) : null;

  let browserUIHeight = 0;
  if (!settings.showBrowserFrame && videoLoaded) {
    browserUIHeight = Math.min(105, Math.floor(videoHeight * 0.08) + 5);
  }

  const color = settings.customClickColor || clickColors[settings.clickColor] || clickColors['white'] || '#ffffff';
  const intensity = clickIntensity();

  for (const click of clicks) {
    const isDouble = click.type === 'doubleclick';
    const sizeMult = isDouble ? 1.3 : 1.0;
    const durationMult = isDouble ? 0.8 : 1.0;

    const win = clickEffectWindow(style, click, durationMult, pressMap);
    if (timestamp < win.start || timestamp >= win.end) continue;

    const span = win.end - win.start;
    if (span <= 0) continue;
    const progress = (timestamp - win.start) / span;
    const clickProgress = (click.timestamp - win.start) / span;

    let normX, normY;
    if (click.normalizedX !== undefined) {
      normX = click.normalizedX;
      normY = click.normalizedY;
    } else if (click.viewportWidth) {
      normX = click.x / click.viewportWidth;
      normY = click.y / click.viewportHeight;
    } else {
      normX = click.x / videoWidth;
      normY = click.y / videoHeight;
    }

    // Click coordinates are normalized against the browser *viewport*
    // (content.js uses clientX / innerWidth, clientY / innerHeight). The
    // recorded source video may or may not include browser chrome above the
    // viewport — tab captures have no chrome at all; window and full-screen
    // captures have a chrome strip at top. Compute the actual chrome height
    // from the cursor data's reported viewport size rather than guessing 8%.
    const vpW = click.viewportWidth || videoWidth;
    const vpH = click.viewportHeight || videoHeight;
    const srcToVpScale = videoWidth / vpW;
    const contentHInSrc = Math.min(videoHeight, vpH * srcToVpScale);
    const chromeHInSrc  = Math.max(0, videoHeight - contentHInSrc);

    // Position of the click inside the *source* video (pre-crop).
    const srcClickY = chromeHInSrc + (normY * contentHInSrc);

    // Map from source-Y into preview-canvas-Y. The preview canvas is sized to
    // `previewCanvas.height = videoHeight - browserUIHeight` and shows source
    // rows [browserUIHeight .. videoHeight] stretched to fill the canvas.
    const srcVisibleTop    = browserUIHeight;
    const srcVisibleHeight = videoHeight - browserUIHeight;
    const x = normX * previewCanvas.width;
    const y = ((srcClickY - srcVisibleTop) / srcVisibleHeight) * previewCanvas.height;

    const fx = { x, y, progress, clickProgress, sizeMult, color, intensity };
    switch (style) {
      case 'ripple': drawRippleClick(fx); break;
      case 'pulse':  drawPulseClick(fx); break;
      case 'burst':  drawBurstClick(fx); break;
      case 'orb':
      default:       drawOrbClick(fx); break;
    }
  }
}

function clickIntensity() {
  const table = {
    weak:     { size: 0.7, alpha: 0.7 },
    moderate: { size: 1.0, alpha: 1.0 },
    strong:   { size: 1.4, alpha: 1.2 }
  };
  return table[settings.clickForce] || table.moderate;
}

function clickEffectWindow(style, click, durationMult, pressMap) {
  const t = click.timestamp;
  switch (style) {
    case 'ripple':
      return { start: t - 60 * durationMult, end: t + 500 * durationMult };
    case 'burst':
      return { start: t - 80 * durationMult, end: t + 400 * durationMult };
    case 'pulse': {
      const pressT = (pressMap && pressMap.get(t)) || (t - 150 * durationMult);
      return { start: pressT, end: t + 300 * durationMult };
    }
    case 'orb':
    default:
      return { start: t - 120 * durationMult, end: t + 250 * durationMult };
  }
}

let _previewPressMap = null;
let _previewPressMapRef = null;
function pairPressReleasePreview(data) {
  if (_previewPressMap && _previewPressMapRef === data) return _previewPressMap;
  const map = new Map();
  const sorted = data.slice().sort((a, b) => a.timestamp - b.timestamp);
  const MAX_AGE = 600;
  const pending = [];
  for (const ev of sorted) {
    if (ev.type === 'mousedown') {
      pending.push(ev);
    } else if (ev.type === 'click' || ev.type === 'doubleclick') {
      while (pending.length && ev.timestamp - pending[0].timestamp > MAX_AGE) pending.shift();
      if (pending.length) {
        const press = pending.pop();
        map.set(ev.timestamp, press.timestamp);
      }
    }
  }
  _previewPressMap = map;
  _previewPressMapRef = data;
  return map;
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }
function easeOutElasticPreview(t) {
  const c4 = (2 * Math.PI) / 3;
  return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

function drawRippleClick(fx) {
  const { x, y, progress, sizeMult, color, intensity } = fx;
  const maxRadius = 58 * intensity.size * sizeMult;
  const rings = [
    { start: 0.00, radius: maxRadius },
    { start: 0.15, radius: maxRadius * 0.78 }
  ];
  for (const ring of rings) {
    const localT = (progress - ring.start) / (1 - ring.start);
    if (localT < 0 || localT > 1) continue;
    const r = ring.radius * easeOutQuart(localT);
    const ringAlpha = (1 - easeOutQuart(localT)) * 0.9 * intensity.alpha;
    const lineWidth = Math.max(1, 4 * (1 - localT) * sizeMult);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(color, ringAlpha);
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
  const dotFade = 1 - Math.min(1, progress / 0.35);
  const dotAlpha = 0.9 * dotFade * intensity.alpha;
  if (dotAlpha > 0.01) {
    const dotR = 8 * intensity.size * sizeMult * (0.6 + 0.4 * easeOutCubic(Math.min(1, progress / 0.2)));
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, dotAlpha);
    ctx.fill();
  }
}

function drawPulseClick(fx) {
  const { x, y, progress, clickProgress, sizeMult, color, intensity } = fx;
  const baseSize = 28 * intensity.size * sizeMult;
  let size, alpha;
  if (progress <= clickProgress && clickProgress > 0) {
    const pressT = progress / clickProgress;
    size = baseSize * (0.5 + 0.5 * easeOutCubic(pressT));
    alpha = (0.55 + 0.3 * pressT) * intensity.alpha;
  } else {
    const releaseT = clickProgress < 1 ? (progress - clickProgress) / (1 - clickProgress) : 0;
    size = baseSize * (1.0 + 0.5 * easeOutElasticPreview(Math.min(1, releaseT * 2)));
    alpha = (0.95 * (1 - easeOutQuart(releaseT))) * intensity.alpha;
  }
  alpha = Math.max(0, Math.min(1, alpha));
  if (alpha <= 0.01) return;

  const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
  gradient.addColorStop(0, hexToRgba(color, alpha * 1.0));
  gradient.addColorStop(0.5, hexToRgba(color, alpha * 0.7));
  gradient.addColorStop(1, hexToRgba(color, 0));
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, size * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(color, alpha);
  ctx.fill();
}

function drawBurstClick(fx) {
  const { x, y, progress, sizeMult, color, intensity } = fx;
  const orbT = Math.min(1, progress / 0.5);
  const orbSize = 22 * intensity.size * sizeMult * easeOutElasticPreview(orbT);
  const orbAlpha = (1 - easeOutQuart(progress)) * 0.9 * intensity.alpha;
  if (orbAlpha > 0.01 && orbSize > 0.1) {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, orbSize);
    grad.addColorStop(0, hexToRgba(color, orbAlpha));
    grad.addColorStop(1, hexToRgba(color, 0));
    ctx.beginPath();
    ctx.arc(x, y, orbSize, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  const streakCount = 8;
  const streakInner = 14 * intensity.size * sizeMult;
  const streakMaxLen = 46 * intensity.size * sizeMult;
  const streakT = Math.min(1, progress / 0.6);
  const streakLen = streakMaxLen * easeOutQuart(streakT);
  const streakAlpha = (1 - easeOutQuart(progress)) * intensity.alpha;
  if (streakAlpha > 0.01 && streakLen > 1) {
    ctx.save();
    ctx.strokeStyle = hexToRgba(color, streakAlpha);
    ctx.lineWidth = Math.max(1.5, 3 * sizeMult * (1 - progress * 0.6));
    ctx.lineCap = 'round';
    for (let i = 0; i < streakCount; i++) {
      const angle = (i / streakCount) * Math.PI * 2;
      const ix = x + Math.cos(angle) * streakInner;
      const iy = y + Math.sin(angle) * streakInner;
      const ox = x + Math.cos(angle) * (streakInner + streakLen);
      const oy = y + Math.sin(angle) * (streakInner + streakLen);
      ctx.beginPath();
      ctx.moveTo(ix, iy);
      ctx.lineTo(ox, oy);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function hexToRgba(hex, alpha) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return `rgba(16, 185, 129, ${alpha})`;
  return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`;
}

function drawOrbClick(fx) {
  const { x, y, progress, sizeMult, color, intensity } = fx;
  const baseSize = 35 * intensity.size * sizeMult;

  const growT = Math.min(progress / 0.35, 1);
  const fadeT = Math.max(0, (progress - 0.35) / 0.65);
  const size = baseSize * (0.5 + easeOutCubic(growT) * 1.2 + fadeT * 0.3);

  let alpha;
  if (progress < 0.35) {
    alpha = (0.7 + easeOutCubic(growT) * 0.25) * intensity.alpha;
  } else {
    alpha = (0.95 * (1 - easeOutQuart(fadeT))) * intensity.alpha;
  }
  alpha = Math.max(0, Math.min(1, alpha));

  ctx.beginPath();
  ctx.arc(x, y, size + 3, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(0, 0, 0, ${alpha * 0.08})`;
  ctx.lineWidth = 4;
  ctx.stroke();

  const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
  gradient.addColorStop(0, hexToRgba(color, alpha * 1.0));
  gradient.addColorStop(0.2, hexToRgba(color, alpha * 0.9));
  gradient.addColorStop(0.4, hexToRgba(color, alpha * 0.7));
  gradient.addColorStop(0.7, hexToRgba(color, alpha * 0.4));
  gradient.addColorStop(1, hexToRgba(color, 0));

  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.strokeStyle = hexToRgba(color, alpha * 0.95);
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, size * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(color, alpha * 0.8);
  ctx.fill();
}

function hexToRgba(hex, alpha) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return `rgba(16, 185, 129, ${alpha})`;
  return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`;
}

// Show export modal
function exportVideo() {
  if (!videoLoaded) return alert('No video loaded');
  
  const modal = document.getElementById('exportModal');
  modal.classList.remove('hidden');
  
  updateExportEstimate();
}

// Track if export is processing
let isExportProcessing = false;

// Setup export modal events
function setupExportModal() {
  const modal = document.getElementById('exportModal');
  const closeBtn = document.getElementById('closeExportModal');
  const cancelBtn = document.getElementById('cancelExport');
  const confirmBtn = document.getElementById('confirmExport');
  const resolutionSelect = document.getElementById('exportResolution');
  const formatSelect = document.getElementById('exportFormat');
  const qualitySelect = document.getElementById('exportQuality');
  const backdrop = modal?.querySelector('.modal-backdrop');
  
  const closeModal = () => {
    // Don't allow closing while processing
    if (isExportProcessing) {
      return;
    }
    modal.classList.add('hidden');
  };
  
  closeBtn?.addEventListener('click', closeModal);
  cancelBtn?.addEventListener('click', closeModal);
  
  // Only allow backdrop click to close if not processing
  backdrop?.addEventListener('click', (e) => {
    if (!isExportProcessing) {
      closeModal();
    }
  });
  
  resolutionSelect?.addEventListener('change', updateExportEstimate);
  formatSelect?.addEventListener('change', updateExportEstimate);
  qualitySelect?.addEventListener('change', updateExportEstimate);
  
  confirmBtn?.addEventListener('click', doExport);
}

function updateExportEstimate() {
  // This function is no longer needed since we removed the estimate text
  // Keeping it for compatibility but it does nothing
}

async function doExport() {
  const modal = document.getElementById('exportModal');
  const confirmBtn = document.getElementById('confirmExport');
  const closeBtn = document.getElementById('closeExportModal');
  const cancelBtn = document.getElementById('cancelExport');
  const resolution = document.getElementById('exportResolution')?.value || '1080p';
  const format = document.getElementById('exportFormat')?.value || 'webm';
  const quality = document.getElementById('exportQuality')?.value || 'high';
  
  if (!processor || typeof processor.processVideo !== 'function') {
    console.error('[Editor] VideoProcessor not available');
    alert('Video processor not initialized. Please refresh the page.');
    return;
  }
  
  // Set processing flag to prevent modal dismissal
  isExportProcessing = true;
  
  // Pause preview video to avoid performance impact during export
  // The video processor uses its own separate video element
  if (video && !video.paused) {
    video.pause();
    isPlaying = false;
    updatePlayButton();
    debugLog('[Editor] Paused preview video for export');
  }
  
  // Disable close buttons during processing
  if (closeBtn) closeBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  
  try {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '⏳ Initializing...';
    
    const blob = await fetch(video.src).then(r => r.blob());
    debugLog('[Editor] Video blob size:', (blob.size / 1024 / 1024).toFixed(2), 'MB');
    
    const resolutions = {
      'original': { width: videoWidth, height: videoHeight },
      '4k': { width: 3840, height: 2160 },
      '1440p': { width: 2560, height: 1440 },
      '1080p': { width: 1920, height: 1080 },
      '720p': { width: 1280, height: 720 },
      '480p': { width: 854, height: 480 }
    };
    
    const bitrates = {
      'high': 150000000,  // 150 Mbps base for 1080p high (ultra-high quality, artifact-free)
      'medium': 75000000, // 75 Mbps base for 1080p medium
      'low': 40000000     // 40 Mbps base for 1080p low
    };
    
    const targetRes = resolutions[resolution] || resolutions['1080p'];
    const targetBitrate = bitrates[quality] || bitrates['high'];
    
    // Apply aspect ratio to export dimensions
    let exportWidth = targetRes.width;
    let exportHeight = targetRes.height;
    
    if (settings.aspectRatio !== 'native') {
      // Calculate aspect ratio
      const [aspectW, aspectH] = settings.aspectRatio.split(':').map(Number);
      const targetAspectRatio = aspectW / aspectH;
      const currentAspectRatio = targetRes.width / targetRes.height;
      
      // Adjust dimensions to match selected aspect ratio
      // Maintain the dimension that results in higher total pixels (better quality)
      if (Math.abs(targetAspectRatio - currentAspectRatio) > 0.01) {
        // Calculate both options and choose the one with more pixels
        const option1Width = Math.round(targetRes.height * targetAspectRatio);
        const option1Height = targetRes.height;
        const option1Pixels = option1Width * option1Height;
        
        const option2Width = targetRes.width;
        const option2Height = Math.round(targetRes.width / targetAspectRatio);
        const option2Pixels = option2Width * option2Height;
        
        // Choose the option with more pixels (better quality)
        if (option1Pixels >= option2Pixels) {
          exportWidth = option1Width;
          exportHeight = option1Height;
        } else {
          exportWidth = option2Width;
          exportHeight = option2Height;
        }
        
        debugLog('[Editor] Applied aspect ratio', settings.aspectRatio, 'to export dimensions:', 
                    exportWidth, 'x', exportHeight, '(original:', targetRes.width, 'x', targetRes.height + ')');
      }
    }

    // Even width/height — fewer encoder artifacts (H.264 / VP9) at 1440p and 4K
    const snapEven = (n) => {
      const v = Math.max(2, Math.round(Number(n) || 0));
      return v - (v % 2);
    };
    exportWidth = snapEven(exportWidth);
    exportHeight = snapEven(exportHeight);
    
    // Scale bitrate based on actual export resolution
    const scaleFactor = (exportWidth * exportHeight) / (1920 * 1080);
    // For 4K, use even higher multiplier to ensure 100% quality
    let resolutionMultiplier = scaleFactor;
    if (resolution === '4k') {
      resolutionMultiplier = Math.max(scaleFactor, 5.0); // Minimum 5x for 4K = 500 Mbps
    }
    // Ensure minimum bitrate for quality exports - don't reduce too much for smaller aspect ratios
    // For portrait/vertical videos, maintain quality by ensuring minimum 0.5x multiplier
    if (resolutionMultiplier < 0.5) {
      resolutionMultiplier = 0.5; // Minimum 50% of base bitrate for quality
    }
    let finalBitrate = Math.round(targetBitrate * resolutionMultiplier);
    
    // Cap bitrate to browser-safe maximum based on format
    // Different codecs have different limits:
    // - VP9/WebM: Can handle up to ~250 Mbps
    // - H.264/MP4: Often limited to ~100-150 Mbps in browsers
    let MAX_SAFE_BITRATE = 250000000; // 250 Mbps default for VP9/WebM
    
    if (format === 'mp4') {
      MAX_SAFE_BITRATE = 150000000; // 150 Mbps for H.264/MP4 (more conservative)
    }
    
    if (finalBitrate > MAX_SAFE_BITRATE) {
      // Silently cap bitrate to browser-safe maximum
      finalBitrate = MAX_SAFE_BITRATE;
    }
    
    
    // Ensure trim handles have valid values
    const trimStart = (trimHandles && isFinite(trimHandles.start)) ? trimHandles.start : 0;
    const trimEnd = (trimHandles && isFinite(trimHandles.end)) ? trimHandles.end : 1;
    
    debugLog('[Editor] Export settings:', { 
      resolution, 
      aspectRatio: settings.aspectRatio,
      format, 
      quality, 
      exportDimensions: { width: exportWidth, height: exportHeight },
      finalBitrate: (finalBitrate / 1000000).toFixed(1) + ' Mbps',
      trim: [trimStart, trimEnd]
    });
    
    
    const exportSettings = {
      background: settings.backgroundImage || (backgrounds[settings.background] || backgrounds['grad-1']),
      backgroundImage: settings.backgroundImage, // Pass image separately for video processor
      padding: settings.background === 'hidden' ? 0 : 24,
      borderRadius: 8,
      trimStart: trimStart,
      trimEnd: trimEnd,
      clickStyle: settings.clickStyle,
      clickColor: settings.customClickColor || clickColors[settings.clickColor] || '#ffffff',
      clickForce: settings.clickForce || 'moderate',
      showWebcam: false, // Camera overlay is already in the recorded video, don't request again during export
      webcamPosition: 'bottom-right',
      webcamSize: 'medium',
      webcamShape: 'circular',
      webcamFlip: false,
      showBrowserFrame: settings.showBrowserFrame,
      showShadow: settings.showShadow,
      outputWidth: exportWidth,
      outputHeight: exportHeight,
      bitrate: finalBitrate,
      format: format,
      quality: quality,
      // Processor caps FPS at 30 for 1440p/4K for stable encoding; 1080p and below can use 60
      fps: resolution === '4k' || resolution === '1440p' ? 30 : 60,
      maxFps: resolution === '4k' || resolution === '1440p' ? 30 : 60,
      sharpening: true,
      antiAlias: true,
      useWebCodecs: false
    };
    
    debugLog('[Editor] Starting export...');
    
    confirmBtn.innerHTML = '⏳ Processing 0%';
    const processed = await processor.processVideo(
      blob, 
      zoomSegments, 
      function(progress) {
        confirmBtn.innerHTML = '⏳ Processing ' + Math.round(progress) + '%';
      }, 
      exportSettings, 
      cursorData
    );
    
    debugLog('[Editor] ✅ Processing complete');
    debugLog('[Editor] Output size:', (processed.size / 1024 / 1024).toFixed(2), 'MB');
    
    let fileExtension = 'webm';
    let mimeType = processed.type;
    
    if (format === 'mp4') {
      if (mimeType.includes('mp4')) {
        fileExtension = 'mp4';
      } else {
        // Note: MP4 requested but browser produced WebM (fallback)
        fileExtension = 'webm';
      }
    }
    
    confirmBtn.innerHTML = '⏳ Saving...';
    const url = URL.createObjectURL(processed);
    const a = document.createElement('a');
    a.href = url;
    a.download = `WubCast-${Date.now()}.${fileExtension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // Clean up: revoke object URL
    // Note: blobs are automatically garbage collected when they go out of scope
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
    
    confirmBtn.innerHTML = '✅ Export Complete!';
    setTimeout(() => {
      // Re-enable close buttons
      isExportProcessing = false;
      if (closeBtn) closeBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Export';
      modal.classList.add('hidden');
    }, 2000);
    
  } catch (e) {
    console.error('[Editor] Export error:', e);
    
    // Re-enable close buttons on error
    isExportProcessing = false;
    if (closeBtn) closeBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    
    let errorMsg = 'Export failed: ' + e.message;
    
    if (e.message.includes('VideoEncoder')) {
      errorMsg += '\n\nTip: Try using WebM format instead of MP4.';
    } else if (e.message.includes('duration')) {
      errorMsg += '\n\nTip: The video file may be corrupted. Try recording again.';
    }
    
    alert(errorMsg);
    
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Export';
  }
}

function uploadBackground() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function(ev) {
        settings.backgroundImage = ev.target.result;
        settings.background = 'image'; // Set background type to image
        updateBackground();
      };
      reader.readAsDataURL(file);
    }
  };
  input.click();
}

window.addEventListener('beforeunload', function() {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
});

window.addEventListener('resize', function() {
  updateFrameSize();
});
