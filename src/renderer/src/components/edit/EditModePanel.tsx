import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioFileSummary, CategoryRecord } from '../../../../shared/models';
import { TagEditor } from '../TagEditor';
import WaveformEditorCanvas from './WaveformEditorCanvas';
import { libraryStore } from '../../stores/LibraryStore';
import { toSplitRequest, type SegmentDraft, type SegmentMetadataDraft } from './types';

export interface EditModePanelProps {
  /** File currently being edited. */
  file: AudioFileSummary;
  /** Available category catalog used by the tag editor. */
  categories: CategoryRecord[];
  /** Invoked after the panel should be closed without committing. */
  onClose(): void;
  /** Invoked after a successful split with the newly created files. */
  onSplitComplete(created: AudioFileSummary[]): void;
}

const MIN_SEGMENT_MS = 50;

type PlaybackMode = 'segment' | 'cursor';

interface PlaybackInfo {
  mode: PlaybackMode;
  startMs: number;
  endMs: number | null;
  label: string;
  segmentId: string | null;
  pausedOffsetMs: number;
}

interface PlaybackUiState {
  mode: PlaybackMode;
  label: string;
  startMs: number;
  endMs: number | null;
  isPlaying: boolean;
}

/**
 * Full-screen overlay that enables waveform driven segment editing and metadata assignment before splitting.
 */
export function EditModePanel({ file, categories, onClose, onSplitComplete }: EditModePanelProps): JSX.Element {
  const [waveformSamples, setWaveformSamples] = useState<number[] | null>(null);
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(file.durationMs ?? null);
  const [segments, setSegments] = useState<SegmentDraft[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [baseMetadata, setBaseMetadata] = useState<{ author: string | null; rating: number | null }>(
    () => ({ author: null, rating: null })
  );
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const audioBufferPromiseRef = useRef<Promise<AudioBuffer | null> | null>(null);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playbackStartTimeRef = useRef<number | null>(null);
  const playbackInfoRef = useRef<PlaybackInfo | null>(null);
  const activePlaybackIdRef = useRef<string | null>(null);
  const lastSegmentPlayRef = useRef<{ segmentId: string; timestamp: number } | null>(null);
  const playbackCursorFrameRef = useRef<number | null>(null);
  const [playbackCursorMs, setPlaybackCursorMs] = useState<number | null>(null);
  const [playbackUi, setPlaybackUi] = useState<PlaybackUiState | null>(null);

  const ensureAudioContext = useCallback((): AudioContext | null => {
    if (audioContextRef.current) {
      return audioContextRef.current;
    }
    const globalWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
    const AudioContextCtor = globalWindow.AudioContext ?? globalWindow.webkitAudioContext;
    if (!AudioContextCtor) {
      setWaveformError((current) => current ?? 'Audio playback is not supported in this environment.');
      return null;
    }
    audioContextRef.current = new AudioContextCtor();
    return audioContextRef.current;
  }, []);

  const stopActiveSource = useCallback(() => {
    const source = activeSourceRef.current;
    if (!source) {
      return;
    }
    source.onended = null;
    try {
      source.stop();
    } catch (error) {
      // Ignore errors when the source has already completed playback.
    }
    source.disconnect();
    activeSourceRef.current = null;
  }, []);

  const stopPlaybackCursorTracking = useCallback((options?: { preservePosition?: boolean }) => {
    if (playbackCursorFrameRef.current !== null) {
      cancelAnimationFrame(playbackCursorFrameRef.current);
      playbackCursorFrameRef.current = null;
    }
    if (!options?.preservePosition) {
      setPlaybackCursorMs(null);
    }
  }, []);

  const schedulePlaybackCursorUpdate = useCallback(() => {
    const context = audioContextRef.current;
    const info = playbackInfoRef.current;
    if (!context || !info || playbackStartTimeRef.current === null) {
      stopPlaybackCursorTracking();
      return;
    }

    const elapsedMs = Math.max(0, (context.currentTime - playbackStartTimeRef.current) * 1000);
    const buffer = audioBufferRef.current;
    const bufferDurationMs = buffer ? buffer.duration * 1000 : Number.POSITIVE_INFINITY;
    const absoluteEndMs = info.endMs ?? bufferDurationMs;
    const position = info.startMs + info.pausedOffsetMs + elapsedMs;
    const clampedPosition = Math.min(position, absoluteEndMs);
    setPlaybackCursorMs(clampedPosition);

    if (position >= absoluteEndMs) {
      stopPlaybackCursorTracking({ preservePosition: true });
      return;
    }

    playbackCursorFrameRef.current = window.requestAnimationFrame(schedulePlaybackCursorUpdate);
  }, [stopPlaybackCursorTracking]);

  const cancelPlayback = useCallback(() => {
    stopActiveSource();
    activePlaybackIdRef.current = null;
    playbackStartTimeRef.current = null;
    playbackInfoRef.current = null;
    stopPlaybackCursorTracking();
    setPlaybackUi(null);
  }, [stopActiveSource, stopPlaybackCursorTracking]);

  const loadAudioBuffer = useCallback(async (): Promise<AudioBuffer | null> => {
    if (audioBufferRef.current) {
      return audioBufferRef.current;
    }
    if (audioBufferPromiseRef.current) {
      return audioBufferPromiseRef.current;
    }
    const context = ensureAudioContext();
    if (!context) {
      return null;
    }
    const promise = (async () => {
      try {
  const payload = await window.api.getAudioBuffer(file.id);
  const buffer = await context.decodeAudioData(payload.buffer.slice(0));
  audioBufferRef.current = buffer;
  return buffer;
      } catch (error) {
        console.error('Failed to decode audio buffer for playback', error);
        return null;
      } finally {
        audioBufferPromiseRef.current = null;
      }
    })();
    audioBufferPromiseRef.current = promise;
    return promise;
  }, [ensureAudioContext, file.id]);

  const beginPlayback = useCallback(
    async (request: PlaybackInfo) => {
      try {
        const buffer = await loadAudioBuffer();
        if (!buffer) {
          return;
        }
        const context = ensureAudioContext();
        if (!context) {
          return;
        }
        await context.resume();

        stopActiveSource();

        const bufferDurationMs = buffer.duration * 1000;
        const absoluteEndMs = request.endMs ?? bufferDurationMs;
        const playbackStartMs = request.startMs + request.pausedOffsetMs;
        if (playbackStartMs >= absoluteEndMs) {
          return;
        }

        const id = generatePlaybackId();
        const playbackLengthMs = absoluteEndMs - playbackStartMs;
        const source = context.createBufferSource();
        source.buffer = buffer;
        
        // Create a gain node for fade control
        const gainNode = context.createGain();
        source.connect(gainNode);
        gainNode.connect(context.destination);
        
        // Apply fade in/out if playing a segment
        if (request.mode === 'segment' && request.segmentId) {
          const segment = segments.find((s) => s.id === request.segmentId);
          if (segment) {
            const fadeInMs = Math.min(segment.fadeInMs, playbackLengthMs / 2);
            const fadeOutMs = Math.min(segment.fadeOutMs, playbackLengthMs / 2);
            const currentTime = context.currentTime;
            
            // Set initial gain
            gainNode.gain.setValueAtTime(fadeInMs > 0 ? 0 : 1, currentTime);
            
            // Apply fade in
            if (fadeInMs > 0) {
              const fadeInEndTime = currentTime + (fadeInMs / 1000);
              gainNode.gain.linearRampToValueAtTime(1, fadeInEndTime);
            }
            
            // Apply fade out
            if (fadeOutMs > 0) {
              const fadeOutStartTime = currentTime + ((playbackLengthMs - fadeOutMs) / 1000);
              const fadeOutEndTime = currentTime + (playbackLengthMs / 1000);
              gainNode.gain.setValueAtTime(1, fadeOutStartTime);
              gainNode.gain.linearRampToValueAtTime(0, fadeOutEndTime);
            }
          }
        }
        
        source.start(0, playbackStartMs / 1000, playbackLengthMs / 1000);

        playbackInfoRef.current = { ...request };
        activePlaybackIdRef.current = id;
        playbackStartTimeRef.current = context.currentTime;
        activeSourceRef.current = source;
        stopPlaybackCursorTracking({ preservePosition: true });
        setPlaybackCursorMs(request.startMs + request.pausedOffsetMs);
        schedulePlaybackCursorUpdate();
        
        setPlaybackUi({
          mode: request.mode,
          label: request.label,
          startMs: request.startMs,
          endMs: request.endMs,
          isPlaying: true
        });

        source.onended = () => {
          if (activePlaybackIdRef.current === id) {
            const infoSnapshot = playbackInfoRef.current;
            const buffer = audioBufferRef.current;
            const bufferDurationMs = buffer ? buffer.duration * 1000 : Number.POSITIVE_INFINITY;
            const finalPosition = infoSnapshot ? (infoSnapshot.endMs ?? bufferDurationMs) : null;
            if (finalPosition !== null && Number.isFinite(finalPosition)) {
              setPlaybackCursorMs(finalPosition);
            }
            stopPlaybackCursorTracking({ preservePosition: true });
            activePlaybackIdRef.current = null;
            playbackStartTimeRef.current = null;
            playbackInfoRef.current = null;
            activeSourceRef.current = null;
            setPlaybackUi(null);
          }
        };
      } catch (error) {
        console.error('Playback start failed', error);
        stopPlaybackCursorTracking();
      }
    },
    [ensureAudioContext, loadAudioBuffer, stopActiveSource, schedulePlaybackCursorUpdate, stopPlaybackCursorTracking, segments]
  );

  const pausePlayback = useCallback(() => {
    const info = playbackInfoRef.current;
    const context = audioContextRef.current;
    if (!info || !context) {
      return;
    }
    if (activePlaybackIdRef.current === null || playbackStartTimeRef.current === null) {
      return;
    }
    const elapsedMs = (context.currentTime - playbackStartTimeRef.current) * 1000;
    const bufferDurationMs = audioBufferRef.current ? audioBufferRef.current.duration * 1000 : Number.POSITIVE_INFINITY;
    const absoluteEndMs = info.endMs ?? bufferDurationMs;
    const nextOffset = Math.min(absoluteEndMs - info.startMs, info.pausedOffsetMs + elapsedMs);
    const absolutePosition = info.startMs + nextOffset;
    playbackInfoRef.current = { ...info, pausedOffsetMs: nextOffset };
    activePlaybackIdRef.current = null;
    playbackStartTimeRef.current = null;
    stopActiveSource();
    stopPlaybackCursorTracking({ preservePosition: true });
    setPlaybackCursorMs(absolutePosition);
    setPlaybackUi((current) => (current ? { ...current, isPlaying: false } : current));
  }, [stopActiveSource, stopPlaybackCursorTracking]);

  const resumePlayback = useCallback(() => {
    const info = playbackInfoRef.current;
    if (!info) {
      return;
    }
    beginPlayback(info);
  }, [beginPlayback]);

  const togglePlayback = useCallback(() => {
    if (activePlaybackIdRef.current) {
      pausePlayback();
      return;
    }
    if (playbackInfoRef.current) {
      resumePlayback();
    }
  }, [pausePlayback, resumePlayback]);

  useEffect(() => {
    let cancelled = false;
    setWaveformSamples(null);
    setWaveformError(null);
    (async () => {
      try {
        const preview = await window.api.getWaveformPreview(file.id, 8192);
        if (!cancelled) {
          setWaveformSamples(preview.samples);
        }
      } catch (error) {
        console.error('Failed to load waveform preview', error);
        if (!cancelled) {
          setWaveformSamples([]);
          setWaveformError('Failed to load waveform preview for this file.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  useEffect(() => {
    let cancelled = false;
    setSegments([]);
    setSelectedSegmentId(null);
    (async () => {
      try {
        const metadata = await window.api.readFileMetadata(file.id);
        if (!cancelled) {
          setBaseMetadata({
            author: metadata.author?.trim() ?? null,
            rating: metadata.rating ?? null
          });
        }
      } catch (error) {
        console.warn('Failed to read metadata for edit mode', error);
        if (!cancelled) {
          setBaseMetadata({ author: null, rating: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const buffer = await loadAudioBuffer();
      if (cancelled || !buffer) {
        return;
      }
      setDurationMs((current) => (current === null ? Math.round(buffer.duration * 1000) : current));
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAudioBuffer]);

  useEffect(() => {
    return () => {
      cancelPlayback();
      const context = audioContextRef.current;
      if (context) {
        context.close().catch(() => undefined);
        audioContextRef.current = null;
      }
    };
  }, [cancelPlayback]);

  const selectedSegment = useMemo(
    () => segments.find((segment) => segment.id === selectedSegmentId) ?? null,
    [segments, selectedSegmentId]
  );

  const isWaveformReady = waveformSamples !== null && durationMs !== null;
  const effectiveDuration = durationMs ?? 0;

  const playSegment = useCallback(
    (segment: SegmentDraft) => {
      const trimmedLabel = segment.label.trim();
      const label = trimmedLabel.length > 0
        ? trimmedLabel
        : `${formatTimecode(segment.startMs)} → ${formatTimecode(segment.endMs)}`;
      beginPlayback({
        mode: 'segment',
        startMs: segment.startMs,
        endMs: segment.endMs,
        label,
        segmentId: segment.id,
        pausedOffsetMs: 0
      });
    },
    [beginPlayback]
  );

  const playFromCursor = useCallback(
    (startMs: number) => {
      beginPlayback({
        mode: 'cursor',
        startMs,
        endMs: null,
        label: `From ${formatTimecode(startMs)}`,
        segmentId: null,
        pausedOffsetMs: 0
      });
    },
    [beginPlayback]
  );

  const handleClose = useCallback(() => {
    cancelPlayback();
    onClose();
  }, [cancelPlayback, onClose]);

  const handleCreateSegment = (rawStart: number, rawEnd: number) => {
    if (!isWaveformReady) {
      return;
    }
    const { start, end } = normaliseRange(rawStart, rawEnd, effectiveDuration);
    const newSegment: SegmentDraft = {
      id: generateSegmentId(),
      startMs: start,
      endMs: end,
      label: `Segment ${segments.length + 1}`,
      metadata: buildDefaultMetadata(file, baseMetadata),
      color: generateSegmentColor(segments.length),
      fadeInMs: 0,
      fadeOutMs: 0
    };
    setSegments((current) => {
      const next = [...current, newSegment].sort((a, b) => a.startMs - b.startMs);
      return next;
    });
    setSelectedSegmentId(newSegment.id);
    playSegment(newSegment);
  };

  const handleResizeSegment = (segmentId: string, rawStart: number, rawEnd: number) => {
    if (!isWaveformReady) {
      return;
    }
    const { start, end } = normaliseRange(rawStart, rawEnd, effectiveDuration);
    setSegments((current) => {
      const next = current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, startMs: start, endMs: end }
          : segment
      );
      next.sort((a, b) => a.startMs - b.startMs);
      return next;
    });
  };

  const handleSelectSegment = useCallback((segmentId: string | null) => {
    setSelectedSegmentId(segmentId);
    if (!segmentId) {
      return;
    }
    const segment = segments.find((entry) => entry.id === segmentId);
    if (segment) {
      const now = performance.now();
      const lastPlay = lastSegmentPlayRef.current;
      const recentlyStartedSameSegment =
        lastPlay &&
        lastPlay.segmentId === segmentId &&
        now - lastPlay.timestamp < 500;
      
      if (!recentlyStartedSameSegment) {
        playSegment(segment);
        lastSegmentPlayRef.current = {
          segmentId,
          timestamp: now
        };
      }
    }
  }, [segments, playSegment]);

  const handleUpdateLabel = (segmentId: string, label: string) => {
    setSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, label }
          : segment
      )
    );
  };

  const handleUpdateFade = useCallback((segmentId: string, fadeInMs: number, fadeOutMs: number) => {
    setSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, fadeInMs, fadeOutMs }
          : segment
      )
    );
  }, []);

  const handleRemoveSegment = useCallback((segmentId: string) => {
    setSegments((current) => current.filter((segment) => segment.id !== segmentId));
    setSelectedSegmentId((current) => (current === segmentId ? null : current));
    if (playbackInfoRef.current?.segmentId === segmentId) {
      cancelPlayback();
    }
  }, [cancelPlayback]);

  const handleMetadataPatch = (segmentId: string, patch: Partial<SegmentMetadataDraft>) => {
    setSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, metadata: { ...segment.metadata, ...patch } }
          : segment
      )
    );
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeElement = document.activeElement;
      if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.getAttribute('contenteditable') === 'true')) {
        return;
      }

      if (event.key === 'Delete') {
        if (selectedSegmentId) {
          event.preventDefault();
          handleRemoveSegment(selectedSegmentId);
        }
        return;
      }

      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault();
        if (playbackInfoRef.current) {
          togglePlayback();
        } else if (selectedSegmentId) {
          const segment = segments.find((seg) => seg.id === selectedSegmentId);
          if (segment) {
            playSegment(segment);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedSegmentId, segments, handleRemoveSegment, togglePlayback, playSegment]);

  const handleCategorySave = (segmentId: string, categories: string[]) => {
    handleMetadataPatch(segmentId, {
      categories
    });
  };

  const handleCommit = async () => {
    if (segments.length === 0 || !isWaveformReady) {
      return;
    }
    setSubmitError(null);
    setIsSaving(true);
    try {
      const payload = segments.map((segment) => toSplitRequest(segment));
      const created = await libraryStore.splitFile(file.id, payload);
      onSplitComplete(created);
      handleClose();
    } catch (error) {
      console.error('Split operation failed', error);
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="edit-mode-overlay" role="dialog" aria-modal="true">
      <div className="edit-mode-panel">
        <header className="edit-mode-header">
          <div>
            <h1>{file.customName || file.displayName}</h1>
            <p>{file.relativePath}</p>
          </div>
          <div className="edit-mode-header-actions">
            <button type="button" className="ghost-button" onClick={handleClose}>Close</button>
          </div>
        </header>
        <div className="edit-mode-body">
          <div className="edit-mode-waveform-container">
            <div className="edit-mode-waveform">
              {waveformError && <div className="edit-mode-error">{waveformError}</div>}
              {!waveformError && !isWaveformReady && (
                <div className="edit-mode-placeholder">Loading waveform…</div>
              )}
              {!waveformError && isWaveformReady && waveformSamples && (
                <WaveformEditorCanvas
                  samples={waveformSamples}
                  durationMs={effectiveDuration}
                  segments={segments}
                  selectedSegmentId={selectedSegmentId}
                  onSelectSegment={handleSelectSegment}
                  onCreateSegment={handleCreateSegment}
                  onResizeSegment={handleResizeSegment}
                  onPlayFromCursor={playFromCursor}
                  playbackCursorMs={playbackCursorMs}
                  onUpdateFade={handleUpdateFade}
                />
              )}
            </div>
            <div className="edit-mode-playback-controls">
              {playbackUi ? (
                <>
                  <button
                    type="button"
                    className="ghost-button edit-mode-playback-toggle"
                    onClick={togglePlayback}
                  >
                    {playbackUi.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                  </button>
                  <div className="edit-mode-playback-details">
                    <span className="edit-mode-playback-title">{playbackUi.label}</span>
                    <span className="edit-mode-playback-range">
                      {formatTimecode(playbackUi.startMs)}
                      {' → '}
                      {formatTimecode(playbackUi.endMs ?? effectiveDuration)}
                      {playbackUi.endMs === null ? ' (end)' : ''}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  {selectedSegment ? (
                    <>
                      <button
                        type="button"
                        className="ghost-button edit-mode-playback-toggle"
                        onClick={() => playSegment(selectedSegment)}
                      >
                        Play (Space)
                      </button>
                      <div className="edit-mode-playback-details">
                        <span className="edit-mode-playback-title">
                          {selectedSegment.label.trim() || `${formatTimecode(selectedSegment.startMs)} → ${formatTimecode(selectedSegment.endMs)}`}
                        </span>
                        <span className="edit-mode-playback-range">
                          {formatTimecode(selectedSegment.startMs)}
                          {' → '}
                          {formatTimecode(selectedSegment.endMs)}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="edit-mode-playback-idle">No segment selected</div>
                  )}
                </>
              )}
            </div>
          </div>
          <aside className="edit-mode-sidebar">
            <section className="segment-list">
              <header className="segment-list-header">
                <h2>Segments</h2>
                <span>{segments.length}</span>
              </header>
              {segments.length === 0 ? (
                <p className="segment-list-empty">Drag on the waveform to create segments.</p>
              ) : (
                <ul>
                  {segments.map((segment) => (
                    <li key={segment.id} className={segment.id === selectedSegmentId ? 'segment-item segment-item--selected' : 'segment-item'}>
                      <span className="segment-color-indicator" style={{ backgroundColor: segment.color }} />
                      <button
                        type="button"
                        className="segment-item-select"
                        onClick={() => handleSelectSegment(segment.id)}
                        aria-pressed={segment.id === selectedSegmentId}
                      >
                        <span className="segment-item-time">{formatTimecode(segment.startMs)} – {formatTimecode(segment.endMs)}</span>
                      </button>
                      <div className="segment-item-label-row">
                        <input
                          type="text"
                          value={segment.label}
                          onChange={(event) => handleUpdateLabel(segment.id, event.target.value)}
                          placeholder="Segment Name"
                        />
                        {segment.id === selectedSegmentId && (
                          <button
                            type="button"
                            className="segment-item-delete"
                            onClick={() => handleRemoveSegment(segment.id)}
                            aria-label="Delete segment"
                            title="Delete segment"
                          >
                            🗑️
                          </button>
                        )}
                      </div>
                      {segment.id === selectedSegmentId && (
                        <div className="segment-item-metadata">
                          <label className="segment-field">
                            <span>Author</span>
                            <input
                              type="text"
                              value={segment.metadata.author ?? ''}
                              onChange={(event) => handleMetadataPatch(segment.id, { author: normaliseText(event.target.value) })}
                              placeholder="Artist or creator"
                            />
                          </label>
                          <div className="segment-field">
                            <span>Rating</span>
                            <div className="star-rating">
                              {[1, 2, 3, 4, 5].map((star) => (
                                <button
                                  key={star}
                                  type="button"
                                  className={segment.metadata.rating !== null && segment.metadata.rating >= star ? 'star star--filled' : 'star'}
                                  onClick={() => handleMetadataPatch(segment.id, {
                                    rating: segment.metadata.rating === star ? null : star
                                  })}
                                  aria-label={`${star} star${star > 1 ? 's' : ''}`}
                                >
                                  ★
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="segment-field">
                            <span>Categories</span>
                            <TagEditor
                              categories={segment.metadata.categories}
                              availableCategories={categories}
                              onSave={(nextCategories) => handleCategorySave(segment.id, nextCategories)}
                              showHeading={false}
                            />
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="segment-metadata">
              <h2>Metadata</h2>
              {selectedSegment ? (
                <p className="segment-metadata-helper">Edit segment metadata in the segment list above.</p>
              ) : (
                <p className="segment-metadata-empty">Select a segment to edit its metadata.</p>
              )}
            </section>
          </aside>
        </div>
        <footer className="edit-mode-footer">
          {submitError && <span className="edit-mode-error">{submitError}</span>}
          <div className="edit-mode-footer-actions">
            <button type="button" className="ghost-button" onClick={handleClose} disabled={isSaving}>Cancel</button>
            <button
              type="button"
              className="primary-button"
              onClick={handleCommit}
              disabled={isSaving || segments.length === 0 || !isWaveformReady}
            >
              {isSaving ? 'Splitting…' : `Create ${segments.length} segment${segments.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function normaliseRange(start: number, end: number, duration: number): { start: number; end: number } {
  let safeStart = Math.max(0, Math.min(start, duration - MIN_SEGMENT_MS));
  let safeEnd = Math.max(safeStart + MIN_SEGMENT_MS, Math.min(end, duration));
  if (safeEnd > duration) {
    safeEnd = duration;
    safeStart = Math.max(0, safeEnd - MIN_SEGMENT_MS);
  }
  return { start: safeStart, end: safeEnd };
}

function generatePlaybackId(): string {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `playback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildDefaultMetadata(
  file: AudioFileSummary,
  baseMetadata: { author: string | null; rating: number | null }
): SegmentMetadataDraft {
  return {
    customName: null,
    author: baseMetadata.author,
    rating: baseMetadata.rating,
    tags: file.tags.slice(),
    categories: file.categories.slice()
  };
}

function generateSegmentId(): string {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `segment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function generateSegmentColor(index: number): string {
  // Use 36-degree spacing on hue wheel (360/36 = 10 unique colors per cycle)
  const hue = (index * 36) % 360;
  const saturation = 70;
  const lightness = 65;
  return hslToHex(hue, saturation, lightness);
}

function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  
  if (h >= 0 && h < 60) {
    r = c; g = x; b = 0;
  } else if (h >= 60 && h < 120) {
    r = x; g = c; b = 0;
  } else if (h >= 120 && h < 180) {
    r = 0; g = c; b = x;
  } else if (h >= 180 && h < 240) {
    r = 0; g = x; b = c;
  } else if (h >= 240 && h < 300) {
    r = x; g = 0; b = c;
  } else if (h >= 300 && h < 360) {
    r = c; g = 0; b = x;
  }
  
  const toHex = (n: number) => {
    const hex = Math.round((n + m) * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function normaliseText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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

export default EditModePanel;
