import { useEffect, useMemo, useState } from 'react';
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
    if (durationMs !== null) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const payload = await window.api.getAudioBuffer(file.id);
        const AudioContextCtor = (window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext
          ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) {
          if (!cancelled) {
            setDurationMs(file.durationMs ?? null);
          }
          return;
        }
        const context = new AudioContextCtor();
        try {
          const buffer = await context.decodeAudioData(payload.buffer.slice(0));
          if (!cancelled) {
            setDurationMs(Math.round(buffer.duration * 1000));
          }
        } finally {
          await context.close();
        }
      } catch (error) {
        console.error('Failed to decode audio buffer for duration', error);
        if (!cancelled) {
          setDurationMs(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.id, durationMs]);

  const selectedSegment = useMemo(
    () => segments.find((segment) => segment.id === selectedSegmentId) ?? null,
    [segments, selectedSegmentId]
  );

  const isWaveformReady = waveformSamples !== null && durationMs !== null;
  const effectiveDuration = durationMs ?? 0;

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
      metadata: buildDefaultMetadata(file, baseMetadata)
    };
    setSegments((current) => {
      const next = [...current, newSegment].sort((a, b) => a.startMs - b.startMs);
      return next;
    });
    setSelectedSegmentId(newSegment.id);
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

  const handleSelectSegment = (segmentId: string | null) => {
    setSelectedSegmentId(segmentId);
  };

  const handleUpdateLabel = (segmentId: string, label: string) => {
    setSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, label }
          : segment
      )
    );
  };

  const handleRemoveSegment = (segmentId: string) => {
    setSegments((current) => current.filter((segment) => segment.id !== segmentId));
    if (selectedSegmentId === segmentId) {
      setSelectedSegmentId(null);
    }
  };

  const handleMetadataPatch = (segmentId: string, patch: Partial<SegmentMetadataDraft>) => {
    setSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, metadata: { ...segment.metadata, ...patch } }
          : segment
      )
    );
  };

  const handleTagSave = (segmentId: string, data: { tags: string[]; categories: string[] }) => {
    handleMetadataPatch(segmentId, {
      tags: data.tags,
      categories: data.categories
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
      onClose();
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
            <button type="button" className="ghost-button" onClick={onClose}>Close</button>
          </div>
        </header>
        <div className="edit-mode-body">
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
              />
            )}
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
                      <button
                        type="button"
                        className="segment-item-select"
                        onClick={() => handleSelectSegment(segment.id)}
                        aria-pressed={segment.id === selectedSegmentId}
                      >
                        <span className="segment-item-time">{formatTimecode(segment.startMs)} – {formatTimecode(segment.endMs)}</span>
                      </button>
                      <input
                        type="text"
                        value={segment.label}
                        onChange={(event) => handleUpdateLabel(segment.id, event.target.value)}
                        placeholder="Label"
                      />
                      <button type="button" className="ghost-button segment-item-remove" onClick={() => handleRemoveSegment(segment.id)}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="segment-metadata">
              <h2>Metadata</h2>
              {selectedSegment ? (
                <>
                  <label className="segment-field">
                    <span>Custom Name</span>
                    <input
                      type="text"
                      value={selectedSegment.metadata.customName ?? ''}
                      onChange={(event) => handleMetadataPatch(selectedSegment.id, { customName: normaliseText(event.target.value) })}
                      placeholder="Optional custom title"
                    />
                  </label>
                  <label className="segment-field">
                    <span>Author</span>
                    <input
                      type="text"
                      value={selectedSegment.metadata.author ?? ''}
                      onChange={(event) => handleMetadataPatch(selectedSegment.id, { author: normaliseText(event.target.value) })}
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
                          className={selectedSegment.metadata.rating !== null && selectedSegment.metadata.rating >= star ? 'star star--filled' : 'star'}
                          onClick={() => handleMetadataPatch(selectedSegment.id, {
                            rating:
                              selectedSegment.metadata.rating === star ? null : star
                          })}
                          aria-label={`${star} star${star > 1 ? 's' : ''}`}
                        >
                          ★
                        </button>
                      ))}
                    </div>
                  </div>
                  <TagEditor
                    tags={selectedSegment.metadata.tags}
                    categories={selectedSegment.metadata.categories}
                    availableCategories={categories}
                    onSave={(data) => handleTagSave(selectedSegment.id, data)}
                    showHeading={false}
                  />
                </>
              ) : (
                <p className="segment-metadata-empty">Select a segment to edit its metadata.</p>
              )}
            </section>
          </aside>
        </div>
        <footer className="edit-mode-footer">
          {submitError && <span className="edit-mode-error">{submitError}</span>}
          <div className="edit-mode-footer-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={isSaving}>Cancel</button>
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

function buildDefaultMetadata(
  file: AudioFileSummary,
  baseMetadata: { author: string | null; rating: number | null }
): SegmentMetadataDraft {
  return {
    customName: file.customName ?? null,
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
