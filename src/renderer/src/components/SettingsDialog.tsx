import { useEffect, useState, type ChangeEvent } from 'react';

export interface SettingsDialogProps {
  open: boolean;
  currentPath: string | null;
  onClose(): void;
  onSelectDirectory(path: string): void;
}

/**
 * Modal dialog for selecting or typing a new library path.
 */
export function SettingsDialog({ open, currentPath, onClose, onSelectDirectory }: SettingsDialogProps): JSX.Element | null {
  const [draftPath, setDraftPath] = useState(currentPath ?? '');

  useEffect(() => {
    setDraftPath(currentPath ?? '');
  }, [currentPath]);

  if (!open) {
    return null;
  }

  const pickDirectory = async () => {
    const directory = await window.api.selectLibraryDirectory();
    if (directory) {
      setDraftPath(directory);
      onSelectDirectory(directory);
    }
  };

  const save = () => {
    if (draftPath.trim().length > 0) {
      onSelectDirectory(draftPath.trim());
    }
    onClose();
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog">
        <h2>Library Settings</h2>
        <label className="dialog-section">
          <span>Library Location</span>
          <input
            value={draftPath}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftPath(event.target.value)}
            placeholder="Choose where your WAV library lives"
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={pickDirectory}>
            Browse…
          </button>
          <button type="button" className="primary-button" onClick={save}>
            Save
          </button>
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default SettingsDialog;
