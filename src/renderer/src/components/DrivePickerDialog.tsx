import type { JSX } from 'react';

export interface DrivePickerDialogProps {
  drives: string[];
  loading: boolean;
  importing: boolean;
  error: string | null;
  onRefresh(): void;
  onSelect(drivePath: string): void;
  onClose(): void;
}

/**
 * Modal dialog that lists available system drives for import selection.
 */
export function DrivePickerDialog({
  drives,
  loading,
  importing,
  error,
  onRefresh,
  onSelect,
  onClose
}: DrivePickerDialogProps): JSX.Element {
  const handleBackdropClick = () => {
    if (!importing && !loading) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal-content drive-picker" onClick={(event) => event.stopPropagation()}>
        <header className="drive-picker__header">
          <h2>Import From Drive</h2>
          <p>Select a drive to copy new WAV files into your library.</p>
        </header>

        {error ? <div className="drive-picker__error">{error}</div> : null}

        <div className="drive-picker__body">
          {loading ? (
            <p className="drive-picker__status">Loading available drives…</p>
          ) : drives.length === 0 ? (
            <p className="drive-picker__status">No drives were detected.</p>
          ) : (
            <ul className="drive-picker__list">
              {drives.map((drive) => (
                <li key={drive}>
                  <button
                    type="button"
                    className="drive-picker__drive"
                    onClick={() => onSelect(drive)}
                    disabled={importing}
                  >
                    <span className="drive-picker__drive-label">{drive}</span>
                    <span className="drive-picker__drive-hint">Press Enter to import from this drive</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="drive-picker__footer">
          <button type="button" className="ghost-button" onClick={onRefresh} disabled={loading || importing}>
            Refresh Drives
          </button>
          <button type="button" className="ghost-button" onClick={onClose} disabled={importing}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

export default DrivePickerDialog;
