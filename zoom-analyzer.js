/**
 * WubCast Screen Recorder
 * Copyright (c) 2026 Fasil Minale
 * GitHub: https://github.com/fasilminale

 *
 * Licensed under the MIT License.
 */

// Zoom Analyzer - Cinematic activity-aware zoom for demo recordings
// Segments are built from clicks + scroll bursts + keystroke bursts.
// Pan between anchors uses a critically-damped spring (Screen Studio feel).
// Per-segment zoom depth adapts to the tightness of the anchor cluster.

class ZoomAnalyzer {
  constructor() {
    // Ceiling zoom level set by the editor (shallow/moderate/deep/maximum).
    // Leave a sensible fallback so direct unit use still produces visible zoom.
    this.ZOOM_LEVEL = 1.3;

    // Per-segment adaptive zoom floor is derived from the ceiling:
    //   floor = 1 + (ZOOM_LEVEL - 1) * ADAPTIVE_FLOOR_RATIO
    // so tight clusters zoom all the way to ZOOM_LEVEL and spread clusters
    // still zoom in a bit.
    this.ADAPTIVE_FLOOR_RATIO = 0.6;
    // Anchor-bbox size (as a fraction of the frame) at which we stop
    // zooming deeper; clusters tighter than this peg to ZOOM_LEVEL.
    this.ADAPTIVE_TIGHT_SPREAD = 0.25;

    // Timing
    this.ANTICIPATE_TIME = 2000;     // Click: start zooming 2s BEFORE event
    this.ANTICIPATE_PASSIVE = 400;   // Scroll/type: only a short lead-in
    this.HOLD_AFTER_CLICK = 0;       // Zoom out immediately after last event
    this.TRANSITION_IN = 1000;       // Smooth zoom-in duration (ms)
    this.TRANSITION_OUT = 1000;      // Smooth zoom-out duration (ms)

    // Gap threshold: only zoom out if next event is this far away
    this.ZOOM_OUT_GAP = 5000;        // 5 seconds

    // Activity burst detection
    this.SCROLL_MAX_GAP = 400;       // Scroll events within 400ms are one burst
    this.SCROLL_MIN_DURATION = 600;  // Burst must last >=600ms to count
    this.TYPE_MAX_GAP = 600;         // Keystrokes within 600ms are one burst
    this.TYPE_MIN_KEYS = 3;          // Need >=3 keys to count as a burst
    this.TYPE_WINDOW = 2000;         // ...all within a 2s window

    // Pan trajectory (eased interpolation between anchors)
    this.PAN_START_PCT = 0.20;       // hold at current anchor for this fraction of the gap
    this.PAN_END_PCT   = 0.80;       // arrive at next anchor by this fraction
    this.MIN_PAN_GAP   = 500;        // effective min gap so rapid events don't jerk
    // Light low-pass smoothing on top of the eased trajectory
    this.SMOOTH_TAU       = 0.10;    // time constant (s); larger = smoother but laggier
    this.SMOOTH_RESET_DT  = 0.5;     // scrub/jump threshold (s) — snap instead of smoothing

    // Scroll/type bursts only add an anchor if no click is within this window
    this.PASSIVE_CLICK_NEIGHBORHOOD = 2500;
  }

  /**
   * Public entry point. Builds zoom segments from the full cursor-data stream,
   * including clicks, scroll bursts, and keystroke bursts.
   */
  analyzeActivity(cursorData, videoWidth = 1920, videoHeight = 1080) {
    console.log('[ZoomAnalyzer] Analyzing', cursorData.length, 'cursor events');
    console.log('[ZoomAnalyzer] Video dimensions:', videoWidth, 'x', videoHeight);

    if (!cursorData || cursorData.length === 0) return [];

    const sorted = cursorData.slice().sort((a, b) => a.timestamp - b.timestamp);

    const events = [];

    // --- Clicks -----------------------------------------------------------
    const clicks = sorted.filter(d =>
      d.type === 'click' || d.type === 'doubleclick' || d.type === 'mousedown'
    );
    let skippedClicks = 0;
    for (const c of clicks) {
      const pos = this._normalizeAnchor(c, videoWidth, videoHeight);
      if (!pos) { skippedClicks++; continue; }
      events.push({
        timestamp: c.timestamp,
        x: pos.x,
        y: pos.y,
        normalizedX: pos.normalizedX,
        normalizedY: pos.normalizedY,
        kind: 'click',
        anticipate: this.ANTICIPATE_TIME
      });
    }
    if (skippedClicks > 0) {
      console.warn('[ZoomAnalyzer] Skipped', skippedClicks, 'click events with missing/invalid coordinates');
    }

    // Timestamps of all click events — used to suppress redundant passive
    // anchors that would otherwise push the camera away from the clicked area.
    const clickTimestamps = clicks.map(c => c.timestamp);

    // --- Scroll bursts ----------------------------------------------------
    const scrolls = sorted.filter(d => d.type === 'scroll');
    const scrollBursts = this._groupBursts(scrolls, this.SCROLL_MAX_GAP);
    let scrollAnchors = 0;
    for (const burst of scrollBursts) {
      const duration = burst[burst.length - 1].timestamp - burst[0].timestamp;
      if (duration < this.SCROLL_MIN_DURATION) continue;
      const midT = burst[0].timestamp + duration / 2;
      if (this._hasClickNear(clickTimestamps, midT, this.PASSIVE_CLICK_NEIGHBORHOOD)) continue;
      const anchorSource = this._nearestCursorSample(sorted, midT);
      const pos = this._normalizeAnchor(anchorSource, videoWidth, videoHeight)
        || { x: videoWidth / 2, y: videoHeight / 2, normalizedX: 0.5, normalizedY: 0.5 };
      events.push({
        timestamp: midT,
        x: pos.x,
        y: pos.y,
        normalizedX: pos.normalizedX,
        normalizedY: pos.normalizedY,
        kind: 'scroll',
        anticipate: this.ANTICIPATE_PASSIVE
      });
      scrollAnchors++;
    }

    // --- Keystroke bursts -------------------------------------------------
    const keys = sorted.filter(d => d.type === 'keystroke');
    const typeBursts = this._groupBursts(keys, this.TYPE_MAX_GAP);
    let typeAnchors = 0;
    for (const burst of typeBursts) {
      if (burst.length < this.TYPE_MIN_KEYS) continue;
      const span = burst[burst.length - 1].timestamp - burst[0].timestamp;
      const midT = burst[0].timestamp + span / 2;
      if (this._hasClickNear(clickTimestamps, midT, this.PASSIVE_CLICK_NEIGHBORHOOD)) continue;
      const anchorSource = this._nearestCursorSample(sorted, midT);
      const pos = this._normalizeAnchor(anchorSource, videoWidth, videoHeight)
        || { x: videoWidth / 2, y: videoHeight / 2, normalizedX: 0.5, normalizedY: 0.5 };
      events.push({
        timestamp: midT,
        x: pos.x,
        y: pos.y,
        normalizedX: pos.normalizedX,
        normalizedY: pos.normalizedY,
        kind: 'type',
        anticipate: this.ANTICIPATE_PASSIVE
      });
      typeAnchors++;
    }

    if (events.length === 0) {
      const kinds = {};
      for (const d of sorted) kinds[d.type] = (kinds[d.type] || 0) + 1;
      console.log('[ZoomAnalyzer] No trigger events found. Input breakdown:', kinds);
      return [];
    }

    events.sort((a, b) => a.timestamp - b.timestamp);

    // --- Group events into segments (5s gap rule) -------------------------
    const segments = [];
    let current = null;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const next = events[i + 1];
      const gapToNext = next ? (next.timestamp - ev.timestamp) : Infinity;
      const shouldZoomOut = gapToNext >= this.ZOOM_OUT_GAP;

      if (!current) {
        const isFirstSegment = segments.length === 0;
        // Suppress lead-in only for a click that fires right at the start;
        // scroll/type bursts already use a short anticipation.
        const anticipate = (isFirstSegment && ev.kind === 'click')
          ? 0
          : ev.anticipate;
        current = {
          startTime: Math.max(0, ev.timestamp - anticipate),
          endTime: 0,
          positions: [this._positionFromEvent(ev)],
          events: [ev],
          clickCount: ev.kind === 'click' ? 1 : 0
        };
      } else {
        current.positions.push(this._positionFromEvent(ev));
        current.events.push(ev);
        if (ev.kind === 'click') current.clickCount++;
      }

      if (shouldZoomOut) {
        current.endTime = ev.timestamp + this.HOLD_AFTER_CLICK + this.TRANSITION_OUT;
        this._finalizeSegment(current);
        segments.push(current);
        current = null;
      }
    }

    if (current) {
      const lastEv = current.events[current.events.length - 1];
      current.endTime = lastEv.timestamp + this.HOLD_AFTER_CLICK + this.TRANSITION_OUT;
      this._finalizeSegment(current);
      segments.push(current);
    }

    console.log('[ZoomAnalyzer] Created', segments.length, 'segments from',
      clicks.length, 'click events,',
      scrollAnchors + '/' + scrollBursts.length, 'scroll-burst anchors (others skipped near clicks),',
      typeAnchors + '/' + typeBursts.length, 'type-burst anchors');

    return segments;
  }

  _hasClickNear(clickTimestamps, t, neighborhood) {
    for (const ct of clickTimestamps) {
      if (Math.abs(ct - t) <= neighborhood) return true;
    }
    return false;
  }

  /**
   * Backward-compatible alias used by existing callers.
   */
  analyzeClicks(cursorData, videoWidth = 1920, videoHeight = 1080) {
    return this.analyzeActivity(cursorData, videoWidth, videoHeight);
  }

  /**
   * Returns { active, level, x, y } at the given timestamp (ms).
   * Panning uses a critically-damped spring. Scrubbing-safe: large dt gaps
   * snap the spring to its target instead of overshooting.
   */
  getZoomAtTime(timestamp, zoomSegments, videoWidth = 1920, videoHeight = 1080) {
    if (!zoomSegments || zoomSegments.length === 0) {
      return { active: false, level: 1.0, x: 0, y: 0 };
    }

    for (const segment of zoomSegments) {
      if (timestamp >= segment.startTime && timestamp <= segment.endTime) {
        return this._sampleSegment(segment, timestamp, videoWidth, videoHeight);
      }
    }

    return { active: false, level: 1.0, x: 0, y: 0 };
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  _sampleSegment(segment, timestamp, videoWidth, videoHeight) {
    const positions = segment.positions || [];
    const zoomCeiling = segment.zoomLevel || this.ZOOM_LEVEL;

    // Segment without any anchors (e.g., manually added one with just centerX/Y)
    if (positions.length === 0) {
      const segmentDuration = segment.endTime - segment.startTime;
      const elapsed = timestamp - segment.startTime;
      const progress = segmentDuration > 0 ? elapsed / segmentDuration : 0;

      let currentZoom = zoomCeiling;
      const transitionPct = 0.15;
      if (progress < transitionPct) {
        currentZoom = 1.0 + (zoomCeiling - 1.0) * this.easeOutCubic(progress / transitionPct);
      } else if (progress > (1 - transitionPct)) {
        const outProgress = (progress - (1 - transitionPct)) / transitionPct;
        currentZoom = zoomCeiling - (zoomCeiling - 1.0) * this.easeInCubic(outProgress);
      }

      return {
        active: currentZoom > 1.01,
        level: Math.max(1.0, currentZoom),
        x: segment.centerX || videoWidth / 2,
        y: segment.centerY || videoHeight / 2
      };
    }

    const firstT = positions[0].timestamp;
    const lastT = positions[positions.length - 1].timestamp;
    const timeBeforeFirst = firstT - timestamp;
    const timeAfterLast = timestamp - lastT;

    // Zoom-level envelope
    let zoomLevel;
    if (timeBeforeFirst > 0) {
      if (timeBeforeFirst <= this.TRANSITION_IN) {
        const progress = 1 - (timeBeforeFirst / this.TRANSITION_IN);
        zoomLevel = 1.0 + (zoomCeiling - 1.0) * this.easeOutCubic(progress);
      } else {
        zoomLevel = 1.0;
      }
    } else if (timeAfterLast >= this.HOLD_AFTER_CLICK) {
      const outProgress = Math.min(1, timeAfterLast / this.TRANSITION_OUT);
      zoomLevel = zoomCeiling - (zoomCeiling - 1.0) * this.easeInCubic(outProgress);
    } else {
      zoomLevel = zoomCeiling;
    }

    // Pan trajectory target (anticipatory eased interpolation)
    let trajectoryX, trajectoryY;
    if (timeBeforeFirst > 0 && timeBeforeFirst <= this.TRANSITION_IN) {
      // Camera glides from frame center toward first anchor during zoom-in.
      const zoomInProgress = 1 - (timeBeforeFirst / this.TRANSITION_IN);
      const eased = this.easeOutCubic(zoomInProgress);
      const cx = videoWidth / 2;
      const cy = videoHeight / 2;
      trajectoryX = cx + (positions[0].x - cx) * eased;
      trajectoryY = cy + (positions[0].y - cy) * eased;
    } else {
      const pt = this._trajectoryBetween(positions, timestamp);
      trajectoryX = pt.x;
      trajectoryY = pt.y;
    }

    // Light low-pass smoothing on top of the eased trajectory.
    // Scrub-safe: a large or negative dt snaps to the trajectory.
    const pan = this._ensurePanState(segment, trajectoryX, trajectoryY);
    const dtSec = (timestamp - pan.lastT) / 1000;

    if (!isFinite(dtSec) || dtSec < 0 || dtSec > this.SMOOTH_RESET_DT) {
      pan.x = trajectoryX;
      pan.y = trajectoryY;
    } else if (dtSec > 0) {
      const alpha = 1 - Math.exp(-dtSec / this.SMOOTH_TAU);
      pan.x += (trajectoryX - pan.x) * alpha;
      pan.y += (trajectoryY - pan.y) * alpha;
    }
    pan.lastT = timestamp;

    return {
      active: zoomLevel > 1.01,
      level: Math.max(1.0, zoomLevel),
      x: pan.x,
      y: pan.y
    };
  }

  _ensurePanState(segment, initX, initY) {
    if (!segment._pan) {
      // Camera starts parked at the initial trajectory point so the first
      // frame doesn't snap from a stale location. The low-pass filter then
      // glides along the eased trajectory from here on.
      segment._pan = {
        x: initX,
        y: initY,
        lastT: segment.startTime
      };
    }
    return segment._pan;
  }

  _trajectoryBetween(positions, timestamp) {
    if (positions.length === 1) return { x: positions[0].x, y: positions[0].y };
    if (timestamp <= positions[0].timestamp) return { x: positions[0].x, y: positions[0].y };
    const last = positions[positions.length - 1];
    if (timestamp >= last.timestamp) return { x: last.x, y: last.y };

    for (let i = 0; i < positions.length - 1; i++) {
      const cur = positions[i];
      const nxt = positions[i + 1];
      if (timestamp >= cur.timestamp && timestamp <= nxt.timestamp) {
        const total = nxt.timestamp - cur.timestamp;
        // Cap min pan window so very rapid events don't produce jerky pans.
        const effective = Math.max(total, this.MIN_PAN_GAP);
        const panStart = effective * this.PAN_START_PCT;
        const panEnd   = effective * this.PAN_END_PCT;
        const elapsed  = timestamp - cur.timestamp;

        if (elapsed < panStart) return { x: cur.x, y: cur.y };
        if (elapsed >= panEnd)  return { x: nxt.x, y: nxt.y };

        const p = (elapsed - panStart) / (panEnd - panStart);
        const eased = this.easeInOutCubic(p);
        return {
          x: cur.x + (nxt.x - cur.x) * eased,
          y: cur.y + (nxt.y - cur.y) * eased
        };
      }
    }
    return { x: positions[0].x, y: positions[0].y };
  }

  _positionFromEvent(ev) {
    return {
      x: ev.x,
      y: ev.y,
      normalizedX: ev.normalizedX,
      normalizedY: ev.normalizedY,
      timestamp: ev.timestamp,
      kind: ev.kind
    };
  }

  _finalizeSegment(segment) {
    // Compute normalized bounding box of anchor points and pick a zoom level
    // adaptively: tight clusters zoom deeper, spread clusters zoom shallower.
    const positions = segment.positions;
    if (!positions || positions.length === 0) {
      segment.zoomLevel = this.ZOOM_LEVEL;
      segment.anchorBBox = { w: 0, h: 0 };
      return;
    }

    let minNx = Infinity, maxNx = -Infinity;
    let minNy = Infinity, maxNy = -Infinity;
    for (const p of positions) {
      const nx = (p.normalizedX !== undefined) ? p.normalizedX : 0.5;
      const ny = (p.normalizedY !== undefined) ? p.normalizedY : 0.5;
      if (nx < minNx) minNx = nx;
      if (nx > maxNx) maxNx = nx;
      if (ny < minNy) minNy = ny;
      if (ny > maxNy) maxNy = ny;
    }
    const bboxW = Math.max(0, maxNx - minNx);
    const bboxH = Math.max(0, maxNy - minNy);
    segment.anchorBBox = { w: bboxW, h: bboxH };

    const spread = Math.max(bboxW, bboxH);
    const tight = 1 - Math.min(1, spread / this.ADAPTIVE_TIGHT_SPREAD);

    const ceiling = this.ZOOM_LEVEL;
    const floor = 1 + (ceiling - 1) * this.ADAPTIVE_FLOOR_RATIO;
    segment.zoomLevel = floor + (ceiling - floor) * tight;
  }

  _groupBursts(events, maxGap) {
    const bursts = [];
    let current = null;
    for (const ev of events) {
      if (!current) {
        current = [ev];
      } else if (ev.timestamp - current[current.length - 1].timestamp <= maxGap) {
        current.push(ev);
      } else {
        bursts.push(current);
        current = [ev];
      }
    }
    if (current) bursts.push(current);
    return bursts;
  }

  _nearestCursorSample(sorted, targetT) {
    // Prefer a move/click/mousedown sample whose timestamp is closest to targetT.
    let best = null;
    let bestDist = Infinity;
    for (const d of sorted) {
      if (d.type !== 'move' && d.type !== 'click'
          && d.type !== 'doubleclick' && d.type !== 'mousedown') continue;
      if (d.normalizedX === undefined && d.x === undefined) continue;
      const dist = Math.abs(d.timestamp - targetT);
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    return best;
  }

  _normalizeAnchor(sample, videoWidth, videoHeight) {
    if (!sample) return null;

    let nx, ny;
    if (sample.normalizedX !== undefined && !isNaN(sample.normalizedX)) {
      nx = sample.normalizedX;
      ny = sample.normalizedY;
    } else if (sample.viewportWidth && sample.viewportWidth > 0) {
      nx = sample.x / sample.viewportWidth;
      ny = sample.y / sample.viewportHeight;
    } else if (sample.x !== undefined) {
      nx = sample.x / videoWidth;
      ny = sample.y / videoHeight;
    } else {
      return null;
    }

    // Clamp closer to edges (0.03-0.97) so the camera can still pan out there.
    nx = Math.max(0.03, Math.min(0.97, nx));
    ny = Math.max(0.03, Math.min(0.97, ny));

    return {
      x: nx * videoWidth,
      y: ny * videoHeight,
      normalizedX: nx,
      normalizedY: ny
    };
  }

  // Easing functions
  easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  easeInCubic(t) {
    return t * t * t;
  }

  easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  generateSummary(zoomSegments) {
    const totalZoomTime = zoomSegments.reduce((sum, seg) =>
      sum + (seg.endTime - seg.startTime), 0
    );

    const totalClicks = zoomSegments.reduce((sum, seg) =>
      sum + (seg.clickCount || 1), 0
    );

    return {
      totalSegments: zoomSegments.length,
      totalZoomTime,
      totalClicks
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZoomAnalyzer;
}
