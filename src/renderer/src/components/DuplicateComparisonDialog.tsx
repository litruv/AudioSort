import { useEffect, useMemo, useRef, useState } from 'react';
import type { AudioFileSummary } from '../../../shared/models';
import Waveform from './Waveform';

type DifferenceFlags = {
  fileName: boolean;
  directory: boolean;
  sampleRate: boolean;
  bitDepth: boolean;
  duration: boolean;
  size: boolean;
};

export interface DuplicateComparisonDialogProps {
  duplicateGroups: { checksum: string; files: AudioFileSummary[] }[];
  onKeepFile(fileIdToKeep: number, fileIdsToDelete: number[]): Promise<void>;
  onClose(): void;
}

/**
 * Dialog for comparing and managing duplicate files.
 */
export function DuplicateComparisonDialog({ duplicateGroups, onKeepFile, onClose }: DuplicateComparisonDialogProps): JSX.Element {
  const [currentGroupIndex, setCurrentGroupIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waveformUrls, setWaveformUrls] = useState<Record<number, string>>({});
  const waveformPoolRef = useRef<string[]>([]);

  if (duplicateGroups.length === 0) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content duplicate-dialog" onClick={(e) => e.stopPropagation()}>
          <h2>No Duplicates Found</h2>
          <p>No duplicate files were found in your library.</p>
          <div className="modal-actions">
            <button type="button" onClick={onClose} className="primary-button">
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const currentGroup = duplicateGroups[currentGroupIndex];
  const referenceFile = currentGroup.files[0] ?? null;

  useEffect(() => {
    waveformPoolRef.current.forEach((url) => URL.revokeObjectURL(url));
    waveformPoolRef.current = [];
    setWaveformUrls({});

    let cancelled = false;

    const loadWaveforms = async () => {
      const next: Record<number, string> = {};
      await Promise.all(
        currentGroup.files.map(async (file) => {
          try {
            const payload = await window.api.getAudioBuffer(file.id);
            const blob = new Blob([payload.buffer], { type: payload.mimeType });
            const url = URL.createObjectURL(blob);
            waveformPoolRef.current.push(url);
            next[file.id] = url;
          } catch (error) {
            console.warn('Failed to prepare waveform for duplicate file', file.id, error);
          }
        })
      );

      if (!cancelled) {
        setWaveformUrls(next);
      } else {
        Object.values(next).forEach((url) => URL.revokeObjectURL(url));
      }
    };

    void loadWaveforms();

    return () => {
      cancelled = true;
    };
  }, [currentGroup]);

  useEffect(() => {
    return () => {
      waveformPoolRef.current.forEach((url) => URL.revokeObjectURL(url));
      waveformPoolRef.current = [];
    };
  }, []);

  const differences = useMemo(() => {
    if (!referenceFile) {
      return {} as Record<number, DifferenceFlags>;
    }
    const referenceDirectory = getDirectory(referenceFile);
    return currentGroup.files.reduce((acc, file) => {
      const directory = getDirectory(file);
      acc[file.id] = {
        fileName: file.fileName !== referenceFile.fileName,
        directory: directory !== referenceDirectory,
        sampleRate: file.sampleRate !== referenceFile.sampleRate,
        bitDepth: file.bitDepth !== referenceFile.bitDepth,
        duration: file.durationMs !== referenceFile.durationMs,
        size: file.size !== referenceFile.size
      };
      return acc;
    }, {} as Record<number, DifferenceFlags>);
  }, [currentGroup.files, referenceFile]);

  const handleKeep = async (file: AudioFileSummary) => {
    setBusy(true);
    try {
      const idsToDelete = currentGroup.files.filter((candidate) => candidate.id !== file.id).map((candidate) => candidate.id);
      await onKeepFile(file.id, idsToDelete);

      if (currentGroupIndex < duplicateGroups.length - 1) {
        setCurrentGroupIndex((index) => index + 1);
      } else {
        onClose();
      }
    } catch (error) {
      alert(`Failed to delete duplicates: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = () => {
    if (currentGroupIndex < duplicateGroups.length - 1) {
      setCurrentGroupIndex(currentGroupIndex + 1);
    } else {
      onClose();
    }
  };

  const handlePrevGroup = () => {
    if (currentGroupIndex > 0) {
      setCurrentGroupIndex(currentGroupIndex - 1);
    }
  };

  const handleNextGroup = () => {
    if (currentGroupIndex < duplicateGroups.length - 1) {
      setCurrentGroupIndex(currentGroupIndex + 1);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content duplicate-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="duplicate-header">
          <button
            type="button"
            className="ghost-button duplicate-nav-button"
            onClick={handlePrevGroup}
            disabled={busy || currentGroupIndex === 0}
          >
            ← Prev
          </button>
          <div className="duplicate-header-summary">
            <h2>Duplicate Group {currentGroupIndex + 1} / {duplicateGroups.length}</h2>
            <p>Checksum {currentGroup.checksum.slice(0, 10)}… · {currentGroup.files.length} files match</p>
          </div>
          <button
            type="button"
            className="ghost-button duplicate-nav-button"
            onClick={handleNextGroup}
            disabled={busy || currentGroupIndex === duplicateGroups.length - 1}
          >
            Next →
          </button>
        </div>
        <p className="duplicate-tip">Scroll to review every duplicate. Differences from the first file are highlighted.</p>
        <div className="duplicate-card-scroll">
          <div className="duplicate-card-list">
            {currentGroup.files.map((file) => {
              const directory = getDirectory(file);
              const diff = differences[file.id] ?? {};
              const waveformUrl = waveformUrls[file.id] ?? null;
              const durationSeconds = (file.durationMs ?? 0) / 1000;

              return (
                <div key={file.id} className="duplicate-column duplicate-column--scroll">
                  <div className="duplicate-card">
                    <header className="duplicate-card-header">
                      <div>
                        <h3>{file.displayName}</h3>
                        <p>{directory}</p>
                      </div>
                    </header>
                    <div className="duplicate-waveform">
                      {waveformUrl ? (
                        <Waveform
                          audioUrl={waveformUrl}
                          currentTime={0}
                          duration={durationSeconds}
                          className="duplicate-waveform-canvas"
                        />
                      ) : (
                        <div className="duplicate-waveform-placeholder">Preparing waveform…</div>
                      )}
                    </div>
                    <dl className="duplicate-details">
                      <div className={diff.fileName ? 'duplicate-detail-row duplicate-detail-row--diff' : 'duplicate-detail-row'}>
                        <dt>Filename</dt>
                        <dd>{file.fileName}</dd>
                      </div>
                      <div className={diff.directory ? 'duplicate-detail-row duplicate-detail-row--diff' : 'duplicate-detail-row'}>
                        <dt>Directory</dt>
                        <dd>{directory}</dd>
                      </div>
                      <div className={diff.sampleRate ? 'duplicate-detail-row duplicate-detail-row--diff' : 'duplicate-detail-row'}>
                        <dt>Sample Rate</dt>
                        <dd>{file.sampleRate ? `${file.sampleRate} Hz` : 'Unknown'}</dd>
                      </div>
                      <div className={diff.bitDepth ? 'duplicate-detail-row duplicate-detail-row--diff' : 'duplicate-detail-row'}>
                        <dt>Bit Depth</dt>
                        <dd>{file.bitDepth ?? 'Unknown'}</dd>
                      </div>
                      <div className={diff.duration ? 'duplicate-detail-row duplicate-detail-row--diff' : 'duplicate-detail-row'}>
                        <dt>Duration</dt>
                        <dd>{formatDuration(file.durationMs)}</dd>
                      </div>
                      <div className={diff.size ? 'duplicate-detail-row duplicate-detail-row--diff' : 'duplicate-detail-row'}>
                        <dt>Size</dt>
                        <dd>{formatBytes(file.size)}</dd>
                      </div>
                    </dl>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleKeep(file)}
                    disabled={busy}
                    className="primary-button"
                  >
                    Keep This File
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={handleSkip} className="ghost-button" disabled={busy}>
            Skip This Group
          </button>
          <button type="button" onClick={onClose} className="ghost-button" disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function getDirectory(file: AudioFileSummary): string {
  return file.relativePath.replace(file.fileName, '') || '(root)';
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(durationMs: number | null): string {
  if (!durationMs) {
    return 'Unknown';
  }
  const totalSeconds = durationMs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor(durationMs % 1000);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

export default DuplicateComparisonDialog;
