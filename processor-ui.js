/**
 * WubCast Screen Recorder
 * Copyright (c) 2026 Fasil Minale
 * GitHub: https://github.com/fasilminale
 *
 * Licensed under the MIT License.
 */

// Processor UI Controller

let videoFile = null;
let cursorData = null;
let zoomSegments = null;
let processedVideoBlob = null;

const analyzer = new ZoomAnalyzer();
const processor = new VideoProcessor();

// DOM Elements
const videoFileInput = document.getElementById('videoFile');
const cursorFileInput = document.getElementById('cursorFile');
const videoFileName = document.getElementById('videoFileName');
const cursorFileName = document.getElementById('cursorFileName');
const previewArea = document.getElementById('previewArea');
const previewVideo = document.getElementById('previewVideo');
const analyzeBtn = document.getElementById('analyzeBtn');
const analysisResults = document.getElementById('analysisResults');
const processBtn = document.getElementById('processBtn');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const successBox = document.getElementById('successBox');
const downloadBtn = document.getElementById('downloadBtn');

// File selection handlers
videoFileInput.addEventListener('change', handleVideoFile);
cursorFileInput.addEventListener('change', handleCursorFile);
analyzeBtn.addEventListener('click', analyzeCursorData);
processBtn.addEventListener('click', processVideo);
downloadBtn.addEventListener('click', downloadProcessedVideo);

async function handleVideoFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  console.log('Video file selected:', file.name, file.size, 'bytes');
  videoFile = file;
  videoFileName.textContent = '✓ ' + file.name;

  // Show preview
  const url = URL.createObjectURL(file);
  previewVideo.src = url;
  previewArea.classList.add('active');

  checkReadyToAnalyze();
}

async function handleCursorFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  console.log('Cursor file selected:', file.name);

  try {
    const text = await file.text();
    cursorData = JSON.parse(text);
    console.log('Cursor data loaded:', cursorData.length, 'events');
    cursorFileName.textContent = '✓ ' + file.name + ' (' + cursorData.length + ' events)';
    
    checkReadyToAnalyze();
  } catch (error) {
    console.error('Error loading cursor data:', error);
    alert('Error loading cursor data: ' + error.message);
  }
}

function checkReadyToAnalyze() {
  if (videoFile && cursorData) {
    analyzeBtn.disabled = false;
    analyzeBtn.style.background = '#28a745';
  }
}

async function analyzeCursorData() {
  console.log('Analyzing cursor data...');
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = '🔍 Analyzing...';

  try {
    // Analyze clicks to find zoom segments
    zoomSegments = analyzer.analyzeClicks(cursorData);
    
    console.log('Analysis complete:', zoomSegments.length, 'zoom segments found');

    // Display results
    displayAnalysisResults(zoomSegments);

    // Enable process button
    processBtn.disabled = false;

    analyzeBtn.textContent = '✓ Analysis Complete';
    analyzeBtn.style.background = '#28a745';
  } catch (error) {
    console.error('Error analyzing:', error);
    alert('Error analyzing cursor data: ' + error.message);
    analyzeBtn.textContent = '🔍 Analyze Cursor Data';
    analyzeBtn.disabled = false;
  }
}

function displayAnalysisResults(segments) {
  analysisResults.classList.add('active');

  // Calculate statistics
  const summary = analyzer.generateSummary(segments);

  document.getElementById('segmentCount').textContent = summary.totalSegments;
  document.getElementById('zoomTime').textContent = (summary.totalZoomTime / 1000).toFixed(1) + 's';
  document.getElementById('totalClicks').textContent = summary.totalClicks;

  // Display timeline
  displayTimeline(segments);

  // Display segment list
  displaySegmentList(segments);
}

function displayTimeline(segments) {
  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';

  // Get video duration
  const duration = previewVideo.duration * 1000; // Convert to ms

  segments.forEach((segment, index) => {
    const startPercent = (segment.startTime / duration) * 100;
    const widthPercent = ((segment.endTime - segment.startTime) / duration) * 100;

    const div = document.createElement('div');
    div.className = 'timeline-zoom';
    div.style.left = startPercent + '%';
    div.style.width = widthPercent + '%';
    div.title = `Zoom ${index + 1}: ${(segment.startTime / 1000).toFixed(1)}s - ${(segment.endTime / 1000).toFixed(1)}s`;
    
    timeline.appendChild(div);
  });
}

function displaySegmentList(segments) {
  const list = document.getElementById('segmentsList');
  list.innerHTML = '';

  if (segments.length === 0) {
    list.innerHTML = '<p style="color: #666; font-style: italic;">No zoom segments detected. Try recording with more click interactions.</p>';
    return;
  }

  segments.forEach((segment, index) => {
    const div = document.createElement('div');
    div.className = 'zoom-segment';
    div.innerHTML = `
      <strong>Zoom ${index + 1}</strong><br>
      <span style="color: #666;">
        Time: ${(segment.startTime / 1000).toFixed(1)}s - ${(segment.endTime / 1000).toFixed(1)}s 
        (${((segment.endTime - segment.startTime) / 1000).toFixed(1)}s duration)
      </span><br>
      <span style="color: #666;">
        Position: (${Math.round(segment.centerX)}, ${Math.round(segment.centerY)}) | 
        Zoom: ${segment.zoomLevel}x | 
        Clicks: ${segment.clickCount}
      </span>
    `;
    list.appendChild(div);
  });
}

async function processVideo() {
  console.log('Starting video processing...');
  
  processBtn.disabled = true;
  processBtn.textContent = '⚙️ Processing...';
  progressBar.classList.add('active');
  successBox.classList.remove('active');

  try {
    // Process video with zoom effects
    processedVideoBlob = await processor.processVideo(
      videoFile,
      zoomSegments,
      (progress) => {
        // Update progress bar
        const percent = Math.round(progress);
        progressFill.style.width = percent + '%';
        progressFill.textContent = percent + '%';
      }
    );

    console.log('Video processing complete!');
    
    // Show success
    progressFill.style.width = '100%';
    progressFill.textContent = '100%';
    
    setTimeout(() => {
      progressBar.classList.remove('active');
      successBox.classList.add('active');
    }, 500);

  } catch (error) {
    console.error('Error processing video:', error);
    alert('Error processing video: ' + error.message);
    processBtn.disabled = false;
    processBtn.textContent = '✨ Apply Automatic Zoom Effects';
    progressBar.classList.remove('active');
  }
}

function downloadProcessedVideo() {
  if (!processedVideoBlob) {
    alert('No processed video available');
    return;
  }

  console.log('Downloading processed video...');

  const url = URL.createObjectURL(processedVideoBlob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = 'WubCast-' + Date.now() + '.webm';
  document.body.appendChild(a);
  a.click();
  
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);

  console.log('Download started!');
}

// Display tips on load
console.log('%c🎬 Video Processor Loaded', 'color: #667eea; font-size: 16px; font-weight: bold;');
console.log('%cHow to use:', 'font-weight: bold;');
console.log('1. Select your recorded video (.webm file)');
console.log('2. Select the cursor data (.json file)');
console.log('3. Click "Analyze" to detect zoom moments');
console.log('4. Click "Apply Zoom Effects" to process the video');
console.log('5. Download your enhanced video!');
