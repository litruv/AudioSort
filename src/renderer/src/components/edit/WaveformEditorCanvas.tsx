import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { SegmentDraft } from './types';

export interface WaveformEditorCanvasProps {
  /** Normalised waveform peaks in the range 0..1 across the whole file. */
  samples: number[];
  /** Total duration of the file in milliseconds. */
  durationMs: number;
  /** Current set of draft segments. */
  segments: SegmentDraft[];
  /** Currently focused segment identifier. */
  selectedSegmentId: string | null;
  /** Invoked when the focused segment should change. */
  onSelectSegment(segmentId: string | null): void;
  /** Invoked when a new segment is created via drag selection. */
  onCreateSegment(startMs: number, endMs: number): void;
  /** Invoked while resizing an existing segment. */
  onResizeSegment(segmentId: string, nextStartMs: number, nextEndMs: number): void;
  /** Invoked when the user clicks the waveform background to audition from that cursor position. */
  onPlayFromCursor(startMs: number): void;
  /** Location of the active playback cursor relative to the source audio, if playing. */
  playbackCursorMs: number | null;
  /** Invoked when fade in/out values change. */
  onUpdateFade(segmentId: string, fadeInMs: number, fadeOutMs: number): void;
}

interface DraftSelection {
  startMs: number;
  endMs: number;
}

type DragState =
  | { type: 'none' }
  | { type: 'creating'; anchorMs: number; pointerMs: number }
  | { type: 'resizing'; segmentId: string; handle: 'start' | 'end' }
  | { type: 'panning'; startViewportMs: number; pointerStartX: number }
  | { type: 'fade'; segmentId: string; handle: 'fadeIn' | 'fadeOut'; initialMs: number };

const MIN_SEGMENT_MS = 50;
const MIN_VIEWPORT_MS = 200;
const MAX_VIEWPORT_MS = Number.POSITIVE_INFINITY;
const HANDLE_WIDTH_PX = 6;
const CLICK_TOLERANCE_MS = 20;
const VIEWPORT_EASING = 0.18;

/**
 * Interactive waveform canvas supporting zoom, pan, and region selection for splitting.
 */
export function WaveformEditorCanvas({
  samples,
  durationMs,
  segments,
  selectedSegmentId,
  onSelectSegment,
  onCreateSegment,
  onResizeSegment,
  onPlayFromCursor,
  playbackCursorMs,
  onUpdateFade
}: WaveformEditorCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<DragState>({ type: 'none' });
  const viewportRef = useRef<{ startMs: number; durationMs: number }>({ startMs: 0, durationMs });
  const targetViewportRef = useRef<{ startMs: number; durationMs: number }>({ startMs: 0, durationMs });
  const [viewportVersion, setViewportVersion] = useState(0);
  const [draftSelection, setDraftSelection] = useState<DraftSelection | null>(null);
  const clickContextRef = useRef<{ startMs: number; insideSegmentId: string | null } | null>(null);
  const [cursorX, setCursorX] = useState<number | null>(null);
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const [hoveredSegmentId, setHoveredSegmentId] = useState<string | null>(null);
  const targetCursorXRef = useRef<number | null>(null);
  const targetCursorMsRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const viewportAnimationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    viewportRef.current = {
      startMs: 0,
      durationMs
    };
    targetViewportRef.current = {
      startMs: 0,
      durationMs
    };
    if (viewportAnimationFrameRef.current !== null) {
      cancelAnimationFrame(viewportAnimationFrameRef.current);
      viewportAnimationFrameRef.current = null;
    }
    setViewportVersion((value) => value + 1);
  }, [durationMs]);

  const samplesPerMs = useMemo(() => {
    if (durationMs <= 0 || samples.length === 0) {
      return 0;
    }
    return samples.length / durationMs;
  }, [samples.length, durationMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    context.scale(dpr, dpr);

    context.clearRect(0, 0, width, height);
    context.fillStyle = '#0c0f13';
    context.fillRect(0, 0, width, height);

    const viewport = viewportRef.current;
    const viewportStart = viewport.startMs;
    const viewportDuration = Math.min(durationMs, viewport.durationMs);
    const viewportEnd = Math.min(durationMs, viewportStart + viewportDuration);
    const baselineY = height / 2;

    const visibleSampleStart = Math.max(0, Math.floor(viewportStart * samplesPerMs));
    const visibleSampleEnd = Math.min(samples.length, Math.ceil(viewportEnd * samplesPerMs));
    const visibleSampleCount = Math.max(1, visibleSampleEnd - visibleSampleStart);

    context.lineWidth = 1;

    // Draw timeline grid lines.
    const gridStepMs = pickGridSpacing(viewportDuration);
    context.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    context.beginPath();
    for (let grid = Math.ceil(viewportStart / gridStepMs) * gridStepMs; grid < viewportEnd; grid += gridStepMs) {
      const ratio = (grid - viewportStart) / viewportDuration;
      if (ratio < 0 || ratio > 1) {
        continue;
      }
      const x = ratio * width;
      context.moveTo(x, 0);
      context.lineTo(x, height);
    }
    context.stroke();

    // Draw waveform peaks.
    context.strokeStyle = '#2c8cff';
    context.beginPath();
    for (let index = visibleSampleStart; index < visibleSampleEnd; index += 1) {
      const sample = samples[index] ?? 0;
      const clamped = Math.max(0, Math.min(1, sample));
      const ratio = (index - visibleSampleStart) / visibleSampleCount;
      const x = ratio * width;
      const amplitude = clamped * (height * 0.45);
      context.moveTo(x, baselineY - amplitude);
      context.lineTo(x, baselineY + amplitude);
    }
    context.stroke();

    // Draw segments.
    segments.forEach((segment) => {
      const startRatio = (segment.startMs - viewportStart) / viewportDuration;
      const endRatio = (segment.endMs - viewportStart) / viewportDuration;
      const startX = Math.max(0, Math.min(width, startRatio * width));
      const endX = Math.max(0, Math.min(width, endRatio * width));
      if (endX <= startX) {
        return;
      }
      const isSelected = segment.id === selectedSegmentId;
      
      // Use segment color with adjusted opacity
      const color = segment.color;
      const rgbMatch = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      if (rgbMatch) {
        const r = parseInt(rgbMatch[1], 16);
        const g = parseInt(rgbMatch[2], 16);
        const b = parseInt(rgbMatch[3], 16);
        context.fillStyle = isSelected ? `rgba(${r}, ${g}, ${b}, 0.4)` : `rgba(${r}, ${g}, ${b}, 0.25)`;
      } else {
        context.fillStyle = isSelected ? 'rgba(255, 204, 0, 0.25)' : 'rgba(255, 255, 255, 0.18)';
      }
      context.fillRect(startX, 0, endX - startX, height);
      
      // Draw fade curves as bezier splines (volume envelope visualization)
      const segmentDurationMs = segment.endMs - segment.startMs;
      const fadeInMs = Math.min(segment.fadeInMs, segmentDurationMs / 2);
      const fadeOutMs = Math.min(segment.fadeOutMs, segmentDurationMs / 2);
      
      const fadeLineColor = isSelected ? '#ffcc00' : (rgbMatch ? `rgb(${parseInt(rgbMatch[1], 16)}, ${parseInt(rgbMatch[2], 16)}, ${parseInt(rgbMatch[3], 16)})` : '#ffffff');
      
      // Draw fade in curve (volume ramp from 0 to 1)
      if (fadeInMs > 0) {
        const fadeInRatio = fadeInMs / viewportDuration;
        const fadeInWidth = fadeInRatio * width;
        const fadeInEndX = startX + fadeInWidth;
        
        if (fadeInEndX > startX && fadeInEndX <= endX) {
          context.strokeStyle = fadeLineColor;
          context.lineWidth = 2.5;
          context.beginPath();
          
          // Start from bottom (silence) and curve up to full volume
          context.moveTo(startX, height);
          
          // Smooth S-curve using bezier - starts slow, accelerates, then eases in
          const cp1X = startX + fadeInWidth * 0.3;
          const cp1Y = height * 0.8;
          const cp2X = startX + fadeInWidth * 0.7;
          const cp2Y = height * 0.2;
          
          context.bezierCurveTo(
            cp1X, cp1Y,
            cp2X, cp2Y,
            fadeInEndX, 0
          );
          context.stroke();
          
          // Add a subtle fill under the curve
          context.globalAlpha = 0.1;
          context.fillStyle = fadeLineColor;
          context.lineTo(fadeInEndX, height);
          context.lineTo(startX, height);
          context.closePath();
          context.fill();
          context.globalAlpha = 1.0;
        }
      }
      
      // Draw fade out curve (volume ramp from 1 to 0)
      if (fadeOutMs > 0) {
        const fadeOutRatio = fadeOutMs / viewportDuration;
        const fadeOutWidth = fadeOutRatio * width;
        const fadeOutStartX = endX - fadeOutWidth;
        
        if (fadeOutStartX >= startX && fadeOutStartX < endX) {
          context.strokeStyle = fadeLineColor;
          context.lineWidth = 2.5;
          context.beginPath();
          
          // Start from top (full volume) and curve down to silence
          context.moveTo(fadeOutStartX, 0);
          
          // Smooth S-curve using bezier
          const cp1X = fadeOutStartX + fadeOutWidth * 0.3;
          const cp1Y = height * 0.2;
          const cp2X = fadeOutStartX + fadeOutWidth * 0.7;
          const cp2Y = height * 0.8;
          
          context.bezierCurveTo(
            cp1X, cp1Y,
            cp2X, cp2Y,
            endX, height
          );
          context.stroke();
          
          // Add a subtle fill under the curve
          context.globalAlpha = 0.1;
          context.fillStyle = fadeLineColor;
          context.lineTo(endX, height);
          context.lineTo(fadeOutStartX, height);
          context.closePath();
          context.fill();
          context.globalAlpha = 1.0;
        }
      }
      
      // Use segment color for handles
      context.fillStyle = isSelected ? '#ffcc00' : color;
      context.fillRect(startX - HANDLE_WIDTH_PX / 2, 0, HANDLE_WIDTH_PX, height);
      context.fillRect(endX - HANDLE_WIDTH_PX / 2, 0, HANDLE_WIDTH_PX, height);
      
      // Draw corner handles for fade control (DaVinci Resolve style)
      const dragState = dragStateRef.current;
      const isFadeDragging = dragState.type === 'fade' && dragState.segmentId === segment.id;
      const showFadeHandles = isSelected || isFadeDragging;
      const cornerHandleSize = 12;
      
      if (showFadeHandles) {
        // Top-left corner handle for fade in
        context.fillStyle = fadeInMs > 0 ? fadeLineColor : 'rgba(255, 255, 255, 0.3)';
        context.beginPath();
        context.moveTo(startX, 0);
        context.lineTo(startX + cornerHandleSize, 0);
        context.lineTo(startX, cornerHandleSize);
        context.closePath();
        context.fill();
        
        // Top-right corner handle for fade out
        context.fillStyle = fadeOutMs > 0 ? fadeLineColor : 'rgba(255, 255, 255, 0.3)';
        context.beginPath();
        context.moveTo(endX, 0);
        context.lineTo(endX - cornerHandleSize, 0);
        context.lineTo(endX, cornerHandleSize);
        context.closePath();
        context.fill();
      }

      // Draw segment labels when being resized or hovered
      const shouldShowLabels = (dragState.type === 'resizing' && dragState.segmentId === segment.id) || 
                               (hoveredSegmentId === segment.id && dragState.type === 'none');
      
      if (shouldShowLabels) {
        context.font = '11px "Consolas", "Monaco", monospace';
        context.textBaseline = 'top';
        
        const segmentWidth = endX - startX;
        const durationMs = segment.endMs - segment.startMs;
        
        // Start time label
        const startText = formatTimecode(segment.startMs);
        const startTextWidth = context.measureText(startText).width;
        context.fillStyle = 'rgba(0, 0, 0, 0.7)';
        context.fillRect(startX + 2, height - 22, startTextWidth + 6, 18);
        context.fillStyle = 'rgba(255, 255, 255, 0.95)';
        context.textAlign = 'left';
        context.fillText(startText, startX + 5, height - 19);
        
        // End time label
        const endText = formatTimecode(segment.endMs);
        const endTextWidth = context.measureText(endText).width;
        context.fillStyle = 'rgba(0, 0, 0, 0.7)';
        context.fillRect(endX - endTextWidth - 8, height - 22, endTextWidth + 6, 18);
        context.fillStyle = 'rgba(255, 255, 255, 0.95)';
        context.textAlign = 'right';
        context.fillText(endText, endX - 5, height - 19);
        
        // Duration label in the middle
        const durationText = formatTimecode(durationMs);
        const durationTextWidth = context.measureText(durationText).width;
        const centerX = startX + segmentWidth / 2;
        context.fillStyle = 'rgba(0, 0, 0, 0.7)';
        context.fillRect(centerX - durationTextWidth / 2 - 3, height / 2 - 9, durationTextWidth + 6, 18);
        context.fillStyle = 'rgba(255, 204, 0, 1)';
        context.textAlign = 'center';
        context.fillText(durationText, centerX, height / 2 - 6);
      }
    });

    if (draftSelection) {
      const draftStartRatio = (draftSelection.startMs - viewportStart) / viewportDuration;
      const draftEndRatio = (draftSelection.endMs - viewportStart) / viewportDuration;
      const draftStartX = Math.max(0, Math.min(width, draftStartRatio * width));
      const draftEndX = Math.max(0, Math.min(width, draftEndRatio * width));
      const draftWidth = draftEndX - draftStartX;
      if (draftWidth > 0) {
        context.fillStyle = 'rgba(76, 201, 240, 0.22)';
        context.fillRect(draftStartX, 0, draftWidth, height);
        context.fillStyle = '#4cc9f0';
        context.fillRect(draftStartX - HANDLE_WIDTH_PX / 2, 0, HANDLE_WIDTH_PX, height);
        context.fillRect(draftEndX - HANDLE_WIDTH_PX / 2, 0, HANDLE_WIDTH_PX, height);

        // Draw draft segment labels
        context.font = '11px "Consolas", "Monaco", monospace';
        context.textBaseline = 'top';
        
        const durationMs = draftSelection.endMs - draftSelection.startMs;
        
        // Start time label
        const startText = formatTimecode(draftSelection.startMs);
        const startTextWidth = context.measureText(startText).width;
        context.fillStyle = 'rgba(0, 0, 0, 0.7)';
        context.fillRect(draftStartX + 2, height - 22, startTextWidth + 6, 18);
        context.fillStyle = 'rgba(76, 201, 240, 1)';
        context.textAlign = 'left';
        context.fillText(startText, draftStartX + 5, height - 19);
        
        // End time label
        const endText = formatTimecode(draftSelection.endMs);
        const endTextWidth = context.measureText(endText).width;
        context.fillStyle = 'rgba(0, 0, 0, 0.7)';
        context.fillRect(draftEndX - endTextWidth - 8, height - 22, endTextWidth + 6, 18);
        context.fillStyle = 'rgba(76, 201, 240, 1)';
        context.textAlign = 'right';
        context.fillText(endText, draftEndX - 5, height - 19);
        
        // Duration label in the middle
        const durationText = formatTimecode(durationMs);
        const durationTextWidth = context.measureText(durationText).width;
        const centerX = draftStartX + draftWidth / 2;
        context.fillStyle = 'rgba(0, 0, 0, 0.7)';
        context.fillRect(centerX - durationTextWidth / 2 - 3, height / 2 - 9, durationTextWidth + 6, 18);
        context.fillStyle = 'rgba(76, 201, 240, 1)';
        context.textAlign = 'center';
        context.fillText(durationText, centerX, height / 2 - 6);
      }
    }

    // Draw live playback cursor when the audio is currently playing
    if (typeof playbackCursorMs === 'number') {
      const playbackRatio = (playbackCursorMs - viewportStart) / viewportDuration;
      if (playbackRatio >= 0 && playbackRatio <= 1) {
        const playbackX = playbackRatio * width;
        context.strokeStyle = 'rgba(76, 201, 240, 0.85)';
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(playbackX, 0);
        context.lineTo(playbackX, height);
        context.stroke();

        context.fillStyle = 'rgba(76, 201, 240, 0.85)';
        context.beginPath();
        context.arc(playbackX, Math.max(8, height * 0.08), 3, 0, Math.PI * 2);
        context.fill();

        context.lineWidth = 1;
      }
    }

    // Draw time indicators showing remaining time on left and right
    context.font = '12px "Consolas", "Monaco", monospace';
    context.fillStyle = 'rgba(255, 255, 255, 0.8)';
    context.textBaseline = 'top';
    
    // Left indicator - time before viewport start
    if (viewportStart > 0) {
      const leftTimeText = '◀ ' + formatTimecode(viewportStart);
      context.textAlign = 'left';
      context.fillStyle = 'rgba(0, 0, 0, 0.6)';
      context.fillRect(4, 4, context.measureText(leftTimeText).width + 8, 20);
      context.fillStyle = 'rgba(255, 255, 255, 0.9)';
      context.fillText(leftTimeText, 8, 8);
    }
    
    // Right indicator - time after viewport end
    const timeRemaining = durationMs - viewportEnd;
    if (timeRemaining > 0) {
      const rightTimeText = formatTimecode(timeRemaining) + ' ▶';
      const rightTextWidth = context.measureText(rightTimeText).width;
      context.textAlign = 'right';
      context.fillStyle = 'rgba(0, 0, 0, 0.6)';
      context.fillRect(width - rightTextWidth - 12, 4, rightTextWidth + 8, 20);
      context.fillStyle = 'rgba(255, 255, 255, 0.9)';
      context.fillText(rightTimeText, width - 8, 8);
    }

    // Draw cursor line (hide when draft selection is active)
    const showCursor = cursorX !== null && cursorMs !== null && !draftSelection;
    
    if (showCursor) {
      context.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(cursorX, 0);
      context.lineTo(cursorX, height);
      context.stroke();

      // Draw cursor timestamp
      const cursorTimeText = formatTimecode(cursorMs);
      const cursorTextWidth = context.measureText(cursorTimeText).width;
      const cursorLabelX = Math.max(4, Math.min(width - cursorTextWidth - 12, cursorX - cursorTextWidth / 2 - 4));
      
      context.fillStyle = 'rgba(0, 0, 0, 0.6)';
      context.fillRect(cursorLabelX, 28, cursorTextWidth + 8, 20);
      context.fillStyle = 'rgba(255, 255, 255, 0.9)';
      context.textAlign = 'left';
      context.fillText(cursorTimeText, cursorLabelX + 4, 32);
    }
  }, [samples, segments, selectedSegmentId, samplesPerMs, durationMs, viewportVersion, draftSelection, cursorX, cursorMs, hoveredSegmentId, playbackCursorMs]);

  const resolveClientToMs = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return 0;
    }
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = Math.min(Math.max(x / rect.width, 0), 1);
    const viewport = viewportRef.current;
    return viewport.startMs + ratio * viewport.durationMs;
  };

  const resolvePointerMs = (event: ReactPointerEvent<HTMLCanvasElement>): number => {
    return resolveClientToMs(event.clientX);
  };

  // Smoothly interpolate viewport transitions for zoom and pan actions.
  const animateViewport = () => {
    const current = viewportRef.current;
    const target = targetViewportRef.current;
    const startDelta = target.startMs - current.startMs;
    const durationDelta = target.durationMs - current.durationMs;
    const maxDelta = Math.max(Math.abs(startDelta), Math.abs(durationDelta));

    if (maxDelta < 0.5) {
      if (maxDelta > 0) {
        viewportRef.current = {
          startMs: target.startMs,
          durationMs: target.durationMs
        };
        setViewportVersion((value) => value + 1);
      }
      viewportAnimationFrameRef.current = null;
      return;
    }

    viewportRef.current = {
      startMs: current.startMs + startDelta * VIEWPORT_EASING,
      durationMs: current.durationMs + durationDelta * VIEWPORT_EASING
    };
    setViewportVersion((value) => value + 1);
    viewportAnimationFrameRef.current = requestAnimationFrame(animateViewport);
  };

  const updateViewport = (nextStart: number, nextDuration: number) => {
    const clampedDuration = clamp(nextDuration, MIN_VIEWPORT_MS, Math.min(MAX_VIEWPORT_MS, durationMs));
    const maxStart = Math.max(0, durationMs - clampedDuration);
    const clampedStart = clamp(nextStart, 0, Math.max(0, maxStart));

    const pointerDelta = Math.max(
      Math.abs(clampedStart - targetViewportRef.current.startMs),
      Math.abs(clampedDuration - targetViewportRef.current.durationMs)
    );
    if (pointerDelta < 0.01) {
      return;
    }

    targetViewportRef.current = {
      startMs: clampedStart,
      durationMs: clampedDuration
    };

    if (viewportAnimationFrameRef.current === null) {
      viewportAnimationFrameRef.current = requestAnimationFrame(animateViewport);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    // Middle click - reset zoom to full view
    if (event.button === 1) {
      event.preventDefault();
      updateViewport(0, durationMs);
      return;
    }
    
    if (event.button === 2) {
      clickContextRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.setPointerCapture(event.pointerId);
      }
      dragStateRef.current = {
        type: 'panning',
        startViewportMs: viewportRef.current.startMs,
        pointerStartX: event.clientX
      };
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const pointerMs = resolvePointerMs(event);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.setPointerCapture(event.pointerId);
    }
    clickContextRef.current = { startMs: pointerMs, insideSegmentId: null };

    const viewport = viewportRef.current;
    const toleranceMs = viewport.durationMs * (HANDLE_WIDTH_PX / Math.max(canvas?.clientWidth ?? 1, 1));
    
    // Check for fade handles first (higher priority)
    const rect = canvas?.getBoundingClientRect();
    const pointerY = rect ? event.clientY - rect.top : 0;
    const canvasWidth = canvas?.clientWidth ?? 1;
    const canvasHeight = canvas?.clientHeight ?? 1;
    const fadeHit = findFadeHandle(
      pointerMs, 
      pointerY, 
      segments, 
      viewport.startMs, 
      viewport.durationMs, 
      canvasWidth, 
      canvasHeight
    );
    if (fadeHit) {
      onSelectSegment(fadeHit.segmentId);
      const segment = segments.find((s) => s.id === fadeHit.segmentId);
      const initialMs = fadeHit.handle === 'fadeIn' 
        ? (segment?.fadeInMs ?? 0)
        : (segment?.fadeOutMs ?? 0);
      dragStateRef.current = { type: 'fade', segmentId: fadeHit.segmentId, handle: fadeHit.handle, initialMs };
      clickContextRef.current = null;
      return;
    }
    
    const hit = findSegmentHandle(pointerMs, segments, toleranceMs);

    if (hit) {
      onSelectSegment(hit.segmentId);
      dragStateRef.current = { type: 'resizing', segmentId: hit.segmentId, handle: hit.handle };
      clickContextRef.current = null;
      return;
    }

    const containing = pickSegmentAtMs(pointerMs, segments);
    if (containing) {
      onSelectSegment(containing.id);
      dragStateRef.current = { type: 'none' };
      clickContextRef.current = { startMs: pointerMs, insideSegmentId: containing.id };
      return;
    }

    dragStateRef.current = { type: 'creating', anchorMs: pointerMs, pointerMs };
    setDraftSelection({ startMs: pointerMs, endMs: pointerMs });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;
    
    // Update cursor position for display (works during drag too)
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const ms = resolveClientToMs(event.clientX);
      targetCursorXRef.current = x;
      targetCursorMsRef.current = ms;
      setCursorX(x);
      setCursorMs(ms);
      
      if (animationFrameRef.current === null) {
        const animate = () => {
          const targetX = targetCursorXRef.current;
          const targetMs = targetCursorMsRef.current;
          
          if (targetX === null || targetMs === null) {
            setCursorX(null);
            setCursorMs(null);
            animationFrameRef.current = null;
            return;
          }

          let needsUpdate = false;

          setCursorX((currentX) => {
            if (currentX === null) {
              needsUpdate = true;
              return targetX;
            }
            const delta = targetX - currentX;
            const distance = Math.abs(delta);
            
            const progress = 1 - (distance / 200);
            const easedProgress = Math.max(0, Math.min(1, progress));
            const speed = 0.08 + (easedProgress * easedProgress * easedProgress) * 0.25;
            const newX = currentX + delta * speed;
            
            if (Math.abs(targetX - newX) < 0.5) {
              return targetX;
            }
            needsUpdate = true;
            return newX;
          });

          setCursorMs((currentMs) => {
            if (currentMs === null) {
              return targetMs;
            }
            const delta = targetMs - currentMs;
            const distance = Math.abs(delta);
            
            const progress = 1 - (distance / 300);
            const easedProgress = Math.max(0, Math.min(1, progress));
            const speed = 0.08 + (easedProgress * easedProgress * easedProgress) * 0.25;
            const newMs = currentMs + delta * speed;
            
            if (Math.abs(targetMs - newMs) < 0.5) {
              return targetMs;
            }
            return newMs;
          });

          if (needsUpdate || targetCursorXRef.current !== null) {
            animationFrameRef.current = requestAnimationFrame(animate);
          } else {
            animationFrameRef.current = null;
          }
        };
        
        animationFrameRef.current = requestAnimationFrame(animate);
      }
      
      // Check segment hover
      const overlapping = segments.filter((segment) => ms >= segment.startMs && ms <= segment.endMs);
      const hovered = pickSegmentAtMs(ms, segments);
      setHoveredSegmentId(hovered ? hovered.id : null);
    }
    
    if (state.type === 'none') {
      return;
    }
    if (state.type === 'panning') {
      const viewport = viewportRef.current;
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const deltaX = event.clientX - state.pointerStartX;
      const ratio = deltaX / Math.max(canvas.clientWidth, 1);
      const deltaMs = -ratio * viewport.durationMs;
      updateViewport(state.startViewportMs + deltaMs, viewport.durationMs);
      return;
    }

    const pointerMs = resolvePointerMs(event);
    if (state.type === 'creating') {
      dragStateRef.current = { ...state, pointerMs };
      const start = Math.min(state.anchorMs, pointerMs);
      const end = Math.max(state.anchorMs, pointerMs);
      setDraftSelection({ startMs: start, endMs: end });
      return;
    }

    if (state.type === 'resizing') {
      const segment = segments.find((entry) => entry.id === state.segmentId);
      if (!segment) {
        return;
      }
      const minEnd = segment.startMs + MIN_SEGMENT_MS;
      const minStart = segment.endMs - MIN_SEGMENT_MS;
      if (state.handle === 'start') {
        const nextStart = clamp(pointerMs, 0, Math.min(minStart, segment.endMs - 1));
        onResizeSegment(segment.id, nextStart, segment.endMs);
      } else {
        const nextEnd = clamp(pointerMs, Math.max(minEnd, segment.startMs + MIN_SEGMENT_MS), durationMs);
        onResizeSegment(segment.id, segment.startMs, nextEnd);
      }
      return;
    }
    
    if (state.type === 'fade') {
      const segment = segments.find((entry) => entry.id === state.segmentId);
      if (!segment) {
        return;
      }
      const segmentDurationMs = segment.endMs - segment.startMs;
      const maxFade = segmentDurationMs / 2;
      
      if (state.handle === 'fadeIn') {
        const fadeInMs = clamp(pointerMs - segment.startMs, 0, maxFade);
        onUpdateFade(segment.id, fadeInMs, segment.fadeOutMs);
      } else {
        const fadeOutMs = clamp(segment.endMs - pointerMs, 0, maxFade);
        onUpdateFade(segment.id, segment.fadeInMs, fadeOutMs);
      }
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }

    const state = dragStateRef.current;
    dragStateRef.current = { type: 'none' };

    if (state.type === 'creating') {
      const pointerMs = resolvePointerMs(event);
      const start = Math.min(state.anchorMs, pointerMs);
      const end = Math.max(state.anchorMs, pointerMs);
      setDraftSelection(null);
      const delta = Math.abs(end - start);
      if (delta >= MIN_SEGMENT_MS) {
        onCreateSegment(start, end);
        clickContextRef.current = null;
        return;
      }
      // If drag was too small, treat as a click to play from cursor
      const clickContext = clickContextRef.current;
      clickContextRef.current = null;
      if (clickContext) {
        onPlayFromCursor(clickContext.startMs);
      }
      return;
    }

    if (state.type === 'panning') {
      return;
    }

    if (state.type === 'resizing') {
      // Final adjustment already applied during move.
      return;
    }

    const clickContext = clickContextRef.current;
    clickContextRef.current = null;
    if (state.type === 'none' && clickContext && !clickContext.insideSegmentId) {
      const pointerMs = resolvePointerMs(event);
      const delta = Math.abs(pointerMs - clickContext.startMs);
      const viewport = viewportRef.current;
      const toleranceMs = Math.max(CLICK_TOLERANCE_MS, viewport.durationMs * 0.002);
      if (delta <= toleranceMs) {
        if (event.detail > 1) {
          return;
        }
        onPlayFromCursor(clickContext.startMs);
      }
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    if (durationMs <= 0) {
      return;
    }
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    const anchor = viewport.startMs + ratio * viewport.durationMs;
    const zoomFactor = event.deltaY > 0 ? 1.1 : 0.9;
    const nextDuration = clamp(viewport.durationMs * zoomFactor, MIN_VIEWPORT_MS, durationMs);
    const nextStart = clamp(anchor - ratio * nextDuration, 0, Math.max(0, durationMs - nextDuration));
    updateViewport(nextStart, nextDuration);
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const pointerMs = resolveClientToMs(event.clientX);
    const targetSegment = pickSegmentAtMs(pointerMs, segments);
    if (targetSegment) {
      const segmentSpan = Math.max(targetSegment.endMs - targetSegment.startMs, 1);
      const paddedSpan = clamp(segmentSpan * 1.1, MIN_VIEWPORT_MS, durationMs);
      const padding = Math.max(0, (paddedSpan - segmentSpan) / 2);
      let nextStart = targetSegment.startMs - padding;
      let nextDuration = paddedSpan;
      if (nextStart < 0) {
        nextStart = 0;
      }
      if (nextStart + nextDuration > durationMs) {
        nextStart = Math.max(0, durationMs - nextDuration);
      }
      updateViewport(nextStart, nextDuration);
      return;
    }

    const viewport = viewportRef.current;
    const windowSpan = viewport.durationMs * 0.25;
    const nextDuration = clamp(windowSpan, MIN_VIEWPORT_MS, durationMs);
    const nextStart = clamp(pointerMs - nextDuration / 2, 0, Math.max(0, durationMs - nextDuration));
    updateViewport(nextStart, nextDuration);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ms = resolveClientToMs(event.clientX);
    
    // Set target values for smooth animation
    targetCursorXRef.current = x;
    targetCursorMsRef.current = ms;
    setCursorX(x);
    setCursorMs(ms);
    setCursorX(x);
    setCursorMs(ms);
    
    // Start animation if not already running
    if (animationFrameRef.current === null) {
      const animate = () => {
        const targetX = targetCursorXRef.current;
        const targetMs = targetCursorMsRef.current;
        
        if (targetX === null || targetMs === null) {
          setCursorX(null);
          setCursorMs(null);
          animationFrameRef.current = null;
          return;
        }

        let needsUpdate = false;

        setCursorX((currentX) => {
          if (currentX === null) {
            needsUpdate = true;
            return targetX;
          }
          const delta = targetX - currentX;
          const distance = Math.abs(delta);
          
          // Ease-in cubic for tape acceleration feel (starts slow, speeds up)
          const progress = 1 - (distance / 200); // Normalize distance
          const easedProgress = Math.max(0, Math.min(1, progress));
          const speed = 0.08 + (easedProgress * easedProgress * easedProgress) * 0.25;
          const newX = currentX + delta * speed;
          
          if (Math.abs(targetX - newX) < 0.5) {
            return targetX;
          }
          needsUpdate = true;
          return newX;
        });

        setCursorMs((currentMs) => {
          if (currentMs === null) {
            return targetMs;
          }
          const delta = targetMs - currentMs;
          const distance = Math.abs(delta);
          
          // Ease-in cubic for tape acceleration feel
          const progress = 1 - (distance / 300);
          const easedProgress = Math.max(0, Math.min(1, progress));
          const speed = 0.08 + (easedProgress * easedProgress * easedProgress) * 0.25;
          const newMs = currentMs + delta * speed;
          
          if (Math.abs(targetMs - newMs) < 0.5) {
            return targetMs;
          }
          return newMs;
        });

        if (needsUpdate || targetCursorXRef.current !== null) {
          animationFrameRef.current = requestAnimationFrame(animate);
        } else {
          animationFrameRef.current = null;
        }
      };
      
      animationFrameRef.current = requestAnimationFrame(animate);
    }

    // Check if hovering over a segment, prefer the one whose center is closest to pointer
    const hovered = pickSegmentAtMs(ms, segments);
    setHoveredSegmentId(hovered ? hovered.id : null);
  };

  const handleMouseLeave = () => {
    targetCursorXRef.current = null;
    targetCursorMsRef.current = null;
    setCursorX(null);
    setCursorMs(null);
    setHoveredSegmentId(null);
    clickContextRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (viewportAnimationFrameRef.current !== null) {
        cancelAnimationFrame(viewportAnimationFrameRef.current);
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="edit-waveform-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function pickGridSpacing(windowMs: number): number {
  const candidates = [10, 20, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 60000];
  for (const candidate of candidates) {
    if (windowMs / candidate <= 12) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1];
}

function findSegmentHandle(
  pointerMs: number,
  segments: SegmentDraft[],
  toleranceMs: number
): { segmentId: string; handle: 'start' | 'end' } | null {
  for (const segment of segments) {
    if (Math.abs(pointerMs - segment.startMs) <= toleranceMs) {
      return { segmentId: segment.id, handle: 'start' };
    }
    if (Math.abs(pointerMs - segment.endMs) <= toleranceMs) {
      return { segmentId: segment.id, handle: 'end' };
    }
  }
  return null;
}

/**
 * Detects if the pointer is over a corner fade handle for a segment.
 * Corner handles are triangular regions at the top-left and top-right of segments.
 *
 * @param pointerMs - Absolute timestamp within the audio file to test.
 * @param pointerY - Y coordinate of the pointer in canvas pixels.
 * @param segments - Segment collection to evaluate.
 * @param viewportStartMs - Start of the current viewport.
 * @param viewportDurationMs - Duration of the current viewport.
 * @param canvasWidth - Width of the canvas in pixels.
 * @param canvasHeight - Height of the canvas in pixels.
 * @returns Fade handle information or null if no corner handle is under the pointer.
 */
function findFadeHandle(
  pointerMs: number,
  pointerY: number,
  segments: SegmentDraft[],
  viewportStartMs: number,
  viewportDurationMs: number,
  canvasWidth: number,
  canvasHeight: number
): { segmentId: string; handle: 'fadeIn' | 'fadeOut' } | null {
  const cornerHandleSize = 12;
  const maxCornerY = 25; // Extended hit area
  
  for (const segment of segments) {
    const startRatio = (segment.startMs - viewportStartMs) / viewportDurationMs;
    const endRatio = (segment.endMs - viewportStartMs) / viewportDurationMs;
    const startX = Math.max(0, Math.min(canvasWidth, startRatio * canvasWidth));
    const endX = Math.max(0, Math.min(canvasWidth, endRatio * canvasWidth));
    
    if (endX <= startX) {
      continue;
    }
    
    // Check if pointer is in the segment vertically
    if (pointerMs < segment.startMs || pointerMs > segment.endMs) {
      continue;
    }
    
    // Convert pointerMs to X coordinate
    const pointerRatio = (pointerMs - viewportStartMs) / viewportDurationMs;
    const pointerX = pointerRatio * canvasWidth;
    
    // Check top-left corner (fade in)
    if (pointerY <= maxCornerY && pointerX >= startX && pointerX <= startX + cornerHandleSize * 2) {
      // Triangle hit test: point is in triangle if it's above the diagonal line
      const relX = pointerX - startX;
      const relY = pointerY;
      if (relX + relY <= cornerHandleSize * 1.5) {
        return { segmentId: segment.id, handle: 'fadeIn' };
      }
    }
    
    // Check top-right corner (fade out)
    if (pointerY <= maxCornerY && pointerX <= endX && pointerX >= endX - cornerHandleSize * 2) {
      // Triangle hit test: point is in triangle if it's above the diagonal line
      const relX = endX - pointerX;
      const relY = pointerY;
      if (relX + relY <= cornerHandleSize * 1.5) {
        return { segmentId: segment.id, handle: 'fadeOut' };
      }
    }
  }
  return null;
}

/**
 * Determine which segment should be chosen for interaction at the supplied timestamp.
 * Prefers the segment whose midpoint is closest to the pointer when multiple segments overlap.
 *
 * @param pointerMs - Absolute timestamp within the audio file to test.
 * @param segments - Segment collection to evaluate.
 * @returns The best matching segment or null when no segments cover the timestamp.
 */
function pickSegmentAtMs(pointerMs: number, segments: SegmentDraft[]): SegmentDraft | null {
  const overlapping = segments.filter((segment) => pointerMs >= segment.startMs && pointerMs <= segment.endMs);
  if (overlapping.length === 0) {
    return null;
  }
  let best = overlapping[0];
  let bestDistance = Math.abs(pointerMs - ((best.startMs + best.endMs) / 2));
  for (let index = 1; index < overlapping.length; index += 1) {
    const candidate = overlapping[index];
    const candidateCenter = (candidate.startMs + candidate.endMs) / 2;
    const candidateDistance = Math.abs(pointerMs - candidateCenter);
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  return best;
}

function formatTimecode(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '00:00.000';
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor(ms % 1000);
  return `${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

export default WaveformEditorCanvas;
