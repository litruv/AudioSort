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
}

interface DraftSelection {
  startMs: number;
  endMs: number;
}

type DragState =
  | { type: 'none' }
  | { type: 'creating'; anchorMs: number; pointerMs: number }
  | { type: 'resizing'; segmentId: string; handle: 'start' | 'end' }
  | { type: 'panning'; startViewportMs: number; pointerStartX: number };

const MIN_SEGMENT_MS = 50;
const MIN_VIEWPORT_MS = 200;
const MAX_VIEWPORT_MS = Number.POSITIVE_INFINITY;
const HANDLE_WIDTH_PX = 6;

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
  onResizeSegment
}: WaveformEditorCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<DragState>({ type: 'none' });
  const viewportRef = useRef<{ startMs: number; durationMs: number }>({ startMs: 0, durationMs });
  const [viewportVersion, setViewportVersion] = useState(0);
  const [draftSelection, setDraftSelection] = useState<DraftSelection | null>(null);

  useEffect(() => {
    viewportRef.current = {
      startMs: 0,
      durationMs
    };
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
      context.fillStyle = isSelected ? 'rgba(255, 204, 0, 0.25)' : 'rgba(255, 255, 255, 0.18)';
      context.fillRect(startX, 0, endX - startX, height);
      context.fillStyle = isSelected ? '#ffcc00' : 'rgba(255, 255, 255, 0.45)';
      context.fillRect(startX - HANDLE_WIDTH_PX / 2, 0, HANDLE_WIDTH_PX, height);
      context.fillRect(endX - HANDLE_WIDTH_PX / 2, 0, HANDLE_WIDTH_PX, height);
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
      }
    }
  }, [samples, segments, selectedSegmentId, samplesPerMs, durationMs, viewportVersion, draftSelection]);

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

  const updateViewport = (nextStart: number, nextDuration: number) => {
    const clampedDuration = clamp(nextDuration, MIN_VIEWPORT_MS, Math.min(MAX_VIEWPORT_MS, durationMs));
    const maxStart = Math.max(0, durationMs - clampedDuration);
    const clampedStart = clamp(nextStart, 0, Math.max(0, maxStart));
    viewportRef.current = {
      startMs: clampedStart,
      durationMs: clampedDuration
    };
    setViewportVersion((value) => value + 1);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2) {
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

    const viewport = viewportRef.current;
    const toleranceMs = viewport.durationMs * (HANDLE_WIDTH_PX / Math.max(canvas?.clientWidth ?? 1, 1));
    const hit = findSegmentHandle(pointerMs, segments, toleranceMs);

    if (hit) {
      onSelectSegment(hit.segmentId);
      dragStateRef.current = { type: 'resizing', segmentId: hit.segmentId, handle: hit.handle };
      return;
    }

    const containing = segments.find((segment) => pointerMs >= segment.startMs && pointerMs <= segment.endMs);
    if (containing) {
      onSelectSegment(containing.id);
      dragStateRef.current = { type: 'none' };
      return;
    }

    dragStateRef.current = { type: 'creating', anchorMs: pointerMs, pointerMs };
    setDraftSelection({ startMs: pointerMs, endMs: pointerMs });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;
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
      if (end - start >= MIN_SEGMENT_MS) {
        onCreateSegment(start, end);
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
    const viewport = viewportRef.current;
    const windowSpan = viewport.durationMs * 0.25;
    const nextDuration = clamp(windowSpan, MIN_VIEWPORT_MS, durationMs);
    const nextStart = clamp(pointerMs - nextDuration / 2, 0, Math.max(0, durationMs - nextDuration));
    updateViewport(nextStart, nextDuration);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
  };

  return (
    <canvas
      ref={canvasRef}
      className="edit-waveform-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
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

export default WaveformEditorCanvas;
