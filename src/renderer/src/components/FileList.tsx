import { useEffect, useReducer, useRef } from 'react';
import type { AudioFileSummary } from '../../../shared/models';

export interface FileListProps {
  files: AudioFileSummary[];
  selectedId: number | null;
  selectedIds: Set<number>;
  onSelect(fileId: number, options: { multi?: boolean; range?: boolean }): void;
  onPlay?(file: AudioFileSummary): void;
  searchValue: string;
  onSearchChange(value: string): void;
  /**
   * Invoked when the user requests to select every visible file (Ctrl+A).
   */
  onSelectAll?(): void;
}

/**
 * Vertical list of WAV files with highlighting for the active selection.
 */
export function FileList({ files, selectedId, selectedIds, onSelect, onPlay, searchValue, onSearchChange, onSelectAll }: FileListProps): JSX.Element {
  const buttonRefs = useRef(new Map<number, HTMLButtonElement>());
  const waveformCacheRef = useRef<Record<number, WaveformVisual>>({});
  const [, forceWaveformUpdate] = useReducer((value: number) => value + 1, 0);
  const dragGhostRef = useRef<HTMLElement | null>(null);
  const dragRotation = useRef<number>(0);
  const lastDragX = useRef<number>(0);
  const dropTargetPosition = useRef<{ x: number; y: number } | null>(null);
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragStartTime = useRef<number>(0);
  const listContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selectedId === null) {
      return;
    }
    const button = buttonRefs.current.get(selectedId);
    if (!button || document.activeElement === button) {
      return;
    }
    const activeElement = document.activeElement as HTMLElement | null;
    const isTypingContext = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
    const isEditable = activeElement?.getAttribute?.('contenteditable') === 'true';
    if (isTypingContext || isEditable) {
      return;
    }
    // Keep keyboard focus aligned with the active selection.
    button.focus();
  }, [selectedId]);

  useEffect(() => {
    if (!window.api?.getWaveformPreview) {
      return;
    }

    const visibleIds = new Set(files.map((file) => file.id));
    for (const cachedId of Object.keys(waveformCacheRef.current)) {
      const numericId = Number.parseInt(cachedId, 10);
      if (!visibleIds.has(numericId)) {
        delete waveformCacheRef.current[numericId];
      }
    }

    let cancelled = false;
    const loadPreviews = async () => {
      for (const file of files) {
        if (waveformCacheRef.current[file.id]) {
          continue;
        }
        try {
          const preview = await window.api.getWaveformPreview(file.id, WAVEFORM_POINT_COUNT);
          if (cancelled) {
            return;
          }
          const seed = file.checksum ?? file.absolutePath;
          waveformCacheRef.current[file.id] = buildWaveformVisual(seed, preview.samples, preview.rms);
          forceWaveformUpdate();
        } catch (error) {
          if (cancelled) {
            return;
          }
          console.error(`Failed to load waveform preview for file ${file.id} (${file.fileName}):`, error);
          const seed = file.checksum ?? file.absolutePath;
          waveformCacheRef.current[file.id] = buildWaveformVisual(seed, null, null);
          forceWaveformUpdate();
        }
      }
    };

    void loadPreviews();
    return () => {
      cancelled = true;
    };
  }, [files]);

  useEffect(() => {
    if (!onSelectAll) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      if (event.key !== 'a' && event.key !== 'A') {
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      if (!activeElement) {
        return;
      }
      const isTypingContext = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
      const isEditable = activeElement.getAttribute('contenteditable') === 'true';
      if (isTypingContext || isEditable) {
        return;
      }

      if (listContainerRef.current && !listContainerRef.current.contains(activeElement)) {
        return;
      }

      event.preventDefault();
      onSelectAll();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onSelectAll]);

  const handleClick = (fileId: number, event: React.MouseEvent) => {
    onSelect(fileId, {
      multi: event.ctrlKey || event.metaKey,
      range: event.shiftKey
    });
  };

  const handleDoubleClick = (file: AudioFileSummary) => {
    if (onPlay) {
      onPlay(file);
    }
  };

  const stripExtension = (filename: string): string => {
    const lastDot = filename.lastIndexOf('.');
    return lastDot > 0 ? filename.slice(0, lastDot) : filename;
  };

  const formatTooltip = (file: AudioFileSummary): string => {
    const customLabel = file.customName?.trim();
    const title = customLabel && customLabel.length > 0 ? customLabel : file.displayName;
    const sampleRate = file.sampleRate ? `${(file.sampleRate / 1000).toFixed(1)}kHz` : 'Unknown';
    const bitDepth = file.bitDepth ? `${file.bitDepth}-bit` : 'Unknown';
    const size = formatBytes(file.size);
    return `${title}\n${sampleRate} • ${bitDepth} • ${size}\n${file.relativePath}`;
  };

  return (
    <section className="file-list">
      <div className="file-list-search">
        <input
          className="search-input"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search files..."
        />
      </div>
  <div className="file-list-items" ref={listContainerRef}>
      {files.map((file) => {
        const isActive = file.id === selectedId;
        const isSelected = selectedIds.has(file.id);
        const className = isActive
          ? 'file-item file-item--active'
          : isSelected
            ? 'file-item file-item--selected'
            : 'file-item';
        const customLabel = file.customName?.trim();
        const primaryLabel = customLabel && customLabel.length > 0 ? customLabel : file.displayName;
        const seed = file.checksum ?? file.absolutePath;
        const gradientId = `waveGradient-${file.id}`;
  const wave = waveformCacheRef.current[file.id] ?? buildWaveformVisual(seed, null, null);
        return (
          <button
            key={file.id}
            type="button"
            className={className}
            draggable={true}
            ref={(node) => {
              if (node) {
                buttonRefs.current.set(file.id, node);
              } else {
                buttonRefs.current.delete(file.id);
              }
            }}
            onClick={(event) => handleClick(file.id, event)}
            onDoubleClick={() => handleDoubleClick(file)}
            onDragStart={(event) => {
              // If dragging an unselected item, only drag that item
              // If dragging a selected item, drag all selected items
              const draggedIds = selectedIds.has(file.id) ? Array.from(selectedIds) : [file.id];
              
              event.dataTransfer.setData('application/audiosort-file', JSON.stringify({
                fileId: file.id,
                selectedIds: draggedIds
              }));
              event.dataTransfer.effectAllowed = 'copy';
              
              // Create transparent drag image to hide the default
              const transparent = document.createElement('div');
              transparent.style.width = '1px';
              transparent.style.height = '1px';
              transparent.style.opacity = '0';
              document.body.appendChild(transparent);
              event.dataTransfer.setDragImage(transparent, 0, 0);
              setTimeout(() => transparent.remove(), 0);
              
              // Calculate offset from click position to element center
              const sourceElement = event.currentTarget as HTMLElement;
              const rect = sourceElement.getBoundingClientRect();
              const elementCenterX = rect.left + rect.width / 2;
              const elementCenterY = rect.top + rect.height / 2;
              dragOffset.current = {
                x: elementCenterX - event.clientX,
                y: elementCenterY - event.clientY
              };
              
              // Calculate transition duration based on offset distance
              const offsetDistance = Math.sqrt(
                dragOffset.current.x * dragOffset.current.x + 
                dragOffset.current.y * dragOffset.current.y
              );
              const maxDistance = Math.sqrt(rect.width * rect.width + rect.height * rect.height) / 2;
              const normalizedDistance = Math.min(offsetDistance / maxDistance, 1);
              const transitionDuration = 0.1 + normalizedDistance * 0.2; // 0.1s to 0.3s
              
              dragStartTime.current = Date.now();
              
              // Clone the current element for custom floating preview
              const ghost = sourceElement.cloneNode(true) as HTMLElement;
              
              // Create a wrapper for rotation that doesn't affect position transition
              const rotationWrapper = document.createElement('div');
              rotationWrapper.style.position = 'fixed';
              rotationWrapper.style.top = `${event.clientY}px`;
              rotationWrapper.style.left = `${event.clientX}px`;
              rotationWrapper.style.width = '0';
              rotationWrapper.style.height = '0';
              rotationWrapper.style.pointerEvents = 'none';
              rotationWrapper.style.zIndex = '10000';
              rotationWrapper.style.willChange = 'transform';
              
              ghost.style.position = 'absolute';
              ghost.style.top = '0';
              ghost.style.left = '0';
              ghost.style.width = `${sourceElement.offsetWidth}px`;
              ghost.style.height = `${sourceElement.offsetHeight}px`;
              ghost.style.opacity = '0.9';
              ghost.style.contain = 'layout style paint';
              ghost.style.transform = `translate(${-rect.width / 2 + dragOffset.current.x}px, ${-rect.height / 2 + dragOffset.current.y}px)`;
              ghost.style.transition = `transform ${transitionDuration}s cubic-bezier(0.25, 0.1, 0.25, 1)`;
              
              rotationWrapper.appendChild(ghost);
              document.body.appendChild(rotationWrapper);
              
              // Trigger the offset transition to center
              requestAnimationFrame(() => {
                if (ghost.parentNode) {
                  ghost.style.transform = `translate(-50%, -50%)`;
                }
              });
              
              dragGhostRef.current = rotationWrapper;
              lastDragX.current = event.clientX;
              dragRotation.current = 0;
            }}
            onDrag={(event) => {
              if (!dragGhostRef.current || (event.clientX === 0 && event.clientY === 0)) return;
              
              const deltaX = event.clientX - lastDragX.current;
              lastDragX.current = event.clientX;
              
              const impulse = deltaX * 0.9;
              const blended = dragRotation.current * 0.75 + impulse;
              const clamped = Math.max(-12, Math.min(12, blended));
              dragRotation.current = clamped;
              
              // Update wrapper position (no rotation here)
              dragGhostRef.current.style.top = `${event.clientY}px`;
              dragGhostRef.current.style.left = `${event.clientX}px`;
              
              // Apply rotation directly to wrapper without transition
              dragGhostRef.current.style.transform = `rotate(${clamped}deg)`;
              
              // Track position for potential drop animation
              dropTargetPosition.current = { x: event.clientX, y: event.clientY };
            }}
            onDragEnd={(event) => {
              const wrapper = dragGhostRef.current;
              if (!wrapper) return;
              
              // Check if this was a successful drop (dropEffect will be 'copy' if accepted)
              const wasDropped = event.dataTransfer.dropEffect === 'copy';
              
              if (wasDropped && dropTargetPosition.current) {
                // Animate shrink into drop position
                wrapper.style.transition = 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
                wrapper.style.transform = `rotate(0deg) scale(0)`;
                wrapper.style.opacity = '0';
                
                setTimeout(() => {
                  wrapper.remove();
                  dragGhostRef.current = null;
                }, 300);
              } else {
                // No drop or cancelled - remove immediately
                wrapper.remove();
                dragGhostRef.current = null;
              }
              
              dragRotation.current = 0;
              dropTargetPosition.current = null;
            }}
            title={formatTooltip(file)}
          >
            <svg
              className="file-waveform"
              viewBox={`0 0 ${WAVEFORM_WIDTH} ${WAVEFORM_HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor={wave.gradientStart} />
                  <stop offset="100%" stopColor={wave.gradientEnd} />
                </linearGradient>
              </defs>
              <path d={wave.path} fill={`url(#${gradientId})`} stroke={wave.stroke} strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <div className="file-item-content">
              <span className="file-label">
                <span className="file-label-primary">{primaryLabel}</span>
                <span className="file-label-secondary">{stripExtension(file.fileName)}</span>
              </span>
              <span className="file-meta">{formatDuration(file.durationMs)}</span>
            </div>
          </button>
        );
      })}
      {files.length === 0 && <div className="file-empty">No files matched the current filters.</div>}
      </div>
    </section>
  );
}

const WAVEFORM_WIDTH = 240;
const WAVEFORM_HEIGHT = 68;
const WAVEFORM_POINT_COUNT = 160;

const RMS_DB_MIN = -24;
const RMS_DB_MAX = 0;
const MIN_RMS_VALUE = 1e-4;

const RMS_COLOR_STOPS: ReadonlyArray<{ value: number; hue: number; saturation: number; lightness: number }> = [
  { value: 0, hue: 210, saturation: 70, lightness: 56 },
  { value: 0.33, hue: 150, saturation: 72, lightness: 52 },
  { value: 0.66, hue: 48, saturation: 76, lightness: 50 },
  { value: 1, hue: 8, saturation: 82, lightness: 46 }
] as const;

interface WaveformVisual {
  path: string;
  stroke: string;
  gradientStart: string;
  gradientEnd: string;
  rms: number;
}

function buildWaveformVisual(seedValue: string, samples: number[] | null, rms: number | null): WaveformVisual {
  const dataset = samples && samples.length > 1 ? samples : createFallbackSamples(seedValue);
  const resolvedRms = clampRms(typeof rms === 'number' ? rms : computeRms(dataset));
  const colorLevel = mapRmsToColorLevel(resolvedRms);
  const palette = deriveWaveformPalette(seedValue, colorLevel);
  const path = buildWaveformPath(dataset);
  return {
    path,
    stroke: palette.stroke,
    gradientStart: palette.gradientStart,
    gradientEnd: palette.gradientEnd,
    rms: resolvedRms
  };
}

function buildWaveformPath(samples: number[]): string {
  if (samples.length === 0) {
    const baseline = WAVEFORM_HEIGHT / 2;
    return `M 0 ${baseline.toFixed(2)} L ${WAVEFORM_WIDTH.toFixed(2)} ${baseline.toFixed(2)}`;
  }

  const baseline = WAVEFORM_HEIGHT / 2;
  const amplitudeScale = WAVEFORM_HEIGHT * 0.48;
  const step = samples.length > 1 ? WAVEFORM_WIDTH / (samples.length - 1) : WAVEFORM_WIDTH;
  const topSegments: string[] = [];
  const bottomSegments: string[] = [];

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(0, Math.min(1, samples[index] ?? 0));
    const x = step * index;
    const amplitude = sample * amplitudeScale;
    const topY = baseline - amplitude;
    const bottomY = baseline + amplitude;
    topSegments.push(`L ${x.toFixed(2)} ${topY.toFixed(2)}`);
    bottomSegments.push(`L ${x.toFixed(2)} ${bottomY.toFixed(2)}`);
  }

  let path = `M 0 ${baseline.toFixed(2)}`;
  if (topSegments.length > 0) {
    path += ` ${topSegments.join(' ')}`;
  }
  if (bottomSegments.length > 0) {
    for (let index = bottomSegments.length - 1; index >= 0; index -= 1) {
      path += ` ${bottomSegments[index]}`;
    }
  }
  path += ' Z';
  return path;
}

function createFallbackSamples(seedValue: string): number[] {
  const rng = mulberry32(hashString(`${seedValue}-fallback`));
  const samples: number[] = [];
  for (let index = 0; index < WAVEFORM_POINT_COUNT; index += 1) {
    const t = index / Math.max(WAVEFORM_POINT_COUNT - 1, 1);
    const envelope = Math.sin(t * Math.PI);
    const jitter = (rng() - 0.5) * 0.25;
    const value = Math.min(1, Math.max(0, 0.18 + envelope * (0.55 + jitter)));
    samples.push(value);
  }
  return samples;
}

function deriveWaveformPalette(seedValue: string, level: number): Pick<WaveformVisual, 'gradientStart' | 'gradientEnd' | 'stroke'> {
  const normalized = clamp(level, 0, 1);
  const baseColor = interpolateColorStops(RMS_COLOR_STOPS, normalized);
  const jitterSeed = hashString(`${seedValue}-palette`);
  const hueJitter = ((jitterSeed % 19) - 9) * 0.6;
  const saturationJitter = (((jitterSeed >> 4) % 17) - 8) * 0.5;
  const lightnessJitter = (((jitterSeed >> 9) % 15) - 7) * 0.6;

  const baseHue = wrapHue(baseColor.hue + hueJitter);
  const saturation = clamp(baseColor.saturation + saturationJitter, 42, 90);
  const baseLightness = clamp(baseColor.lightness + lightnessJitter, 28, 64);
  const accentHue = wrapHue(baseHue + 18);
  const strokeHue = wrapHue(baseHue + 8);
  const gradientStartLightness = clamp(baseLightness + 6, 32, 74);
  const gradientEndLightness = clamp(baseLightness - 6, 20, 60);
  const strokeLightness = clamp(baseLightness - 10, 18, 58);
  const strokeAlpha = clamp(0.44 + normalized * 0.4, 0.32, 0.86);

  return {
    gradientStart: `hsla(${Math.round(baseHue)}, ${Math.round(saturation)}%, ${Math.round(gradientStartLightness)}%, 0.32)`,
    gradientEnd: `hsla(${Math.round(accentHue)}, ${Math.round(saturation + 6)}%, ${Math.round(gradientEndLightness)}%, 0.24)`,
    stroke: `hsla(${Math.round(strokeHue)}, ${Math.round(saturation + 4)}%, ${Math.round(strokeLightness)}%, ${strokeAlpha.toFixed(2)})`
  };
}

/**
 * Converts an RMS value into a 0..1 interpolation level using a decibel scale.
 */
function mapRmsToColorLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) {
    return 0;
  }
  const safeRms = clamp(rms, MIN_RMS_VALUE, 1);
  const db = 20 * Math.log10(safeRms);
  const clampedDb = clamp(db, RMS_DB_MIN, RMS_DB_MAX);
  return (clampedDb - RMS_DB_MIN) / (RMS_DB_MAX - RMS_DB_MIN);
}

/**
 * Performs linear interpolation across color stops for the provided interpolation value (0..1).
 */
function interpolateColorStops(
  stops: ReadonlyArray<{ value: number; hue: number; saturation: number; lightness: number }>,
  value: number
): { hue: number; saturation: number; lightness: number } {
  if (stops.length === 0) {
    return { hue: 0, saturation: 60, lightness: 50 };
  }
  if (value <= stops[0].value) {
    const { hue, saturation, lightness } = stops[0];
    return { hue, saturation, lightness };
  }
  if (value >= stops[stops.length - 1].value) {
    const { hue, saturation, lightness } = stops[stops.length - 1];
    return { hue, saturation, lightness };
  }

  for (let index = 0; index < stops.length - 1; index += 1) {
    const start = stops[index];
    const end = stops[index + 1];
    if (value >= start.value && value <= end.value) {
      const range = end.value - start.value;
      const t = range > 0 ? (value - start.value) / range : 0;
      return {
        hue: start.hue + (end.hue - start.hue) * t,
        saturation: start.saturation + (end.saturation - start.saturation) * t,
        lightness: start.lightness + (end.lightness - start.lightness) * t
      };
    }
  }

  const { hue, saturation, lightness } = stops[stops.length - 1];
  return { hue, saturation, lightness };
}

function computeRms(samples: number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = clamp(samples[index] ?? 0, 0, 1);
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function clampRms(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wrapHue(value: number): number {
  const modulo = value % 360;
  return modulo < 0 ? modulo + 360 : modulo;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formatDuration(durationMs: number | null): string {
  if (!durationMs || Number.isNaN(durationMs)) {
    return '–';
  }
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export default FileList;
