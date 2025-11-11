import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AudioFileSummary, CategoryRecord } from '../../../shared/models';
import { TagEditor } from './TagEditor';

/**
 * Normalizes path separators to backslashes for consistent display on Windows.
 */
function normalizePathDisplay(path: string): string {
  return path.replace(/\//g, '\\');
}

/**
 * Props for FileDetailPanel component.
 */
export interface FileDetailPanelProps {
  file: AudioFileSummary | null;
  /** Optional summary of the parent file when this entry was generated from another file. */
  parentFile: AudioFileSummary | null;
  categories: CategoryRecord[];
  onRename(newName: string): Promise<void>;
  onMove(targetRelativeDirectory: string): Promise<void>;
  /** Organizes a file with optional metadata fields (customName, author, copyright, rating 1-5). */
  onOrganize(metadata: { customName?: string; author?: string; copyright?: string; rating?: number }): Promise<void>;
  onUpdateTags(categories: string[]): Promise<void>;
  onUpdateCustomName(customName: string | null): Promise<void>;
  /** Invoked when the user requests to open the parent file. */
  onOpenParent?(parentId: number): void;
  metadataSuggestionsVersion: number;
}

/**
 * Displays metadata for the selected file with rename, move, and tagging controls.
 */
export function FileDetailPanel({ file, parentFile, categories, onRename, onMove, onOrganize, onUpdateTags, onUpdateCustomName, onOpenParent, metadataSuggestionsVersion }: FileDetailPanelProps): JSX.Element {
  const [isEditingCustomName, setIsEditingCustomName] = useState(false);
  const [moveDraft, setMoveDraft] = useState('');
  const [customNameDraft, setCustomNameDraft] = useState('');
  const [authorDraft, setAuthorDraft] = useState('');
  const [ratingDraft, setRatingDraft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [isTagSectionExpanded, setIsTagSectionExpanded] = useState(true);
  const [suggestions, setSuggestions] = useState<{ authors: string[] }>({ authors: [] });
  const initialMetadataRef = useRef<{ author: string; copyright: string; rating: number; customName: string }>({
    author: '',
    copyright: '',
    rating: 0,
    customName: ''
  });

  const appendSuggestion = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    setSuggestions((previous) => {
      if (previous.authors.some((entry) => entry.localeCompare(trimmed, undefined, { sensitivity: 'accent' }) === 0)) {
        return previous;
      }
      const nextList = [...previous.authors, trimmed].sort((a, b) => a.localeCompare(b));
      return {
        authors: nextList
      };
    });
  }, []);

  const filteredAuthorSuggestions = useMemo(() => {
    if (suggestions.authors.length === 0) {
      return [] as string[];
    }
    const query = authorDraft.trim().toLowerCase();
    const base = suggestions.authors.filter((entry) => entry.toLowerCase() !== query);
    if (query.length === 0) {
      return base.slice(0, 5);
    }
    return base.filter((entry) => entry.toLowerCase().includes(query)).slice(0, 5);
  }, [authorDraft, suggestions.authors]);

  useEffect(() => {
    let cancelled = false;
    setSuggestions({ authors: [] });
    void (async () => {
      try {
        const result = await window.api.listMetadataSuggestions();
        if (cancelled) {
          return;
        }
        setSuggestions({
          authors: result.authors
        });
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load metadata suggestions:', error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metadataSuggestionsVersion]);

  useEffect(() => {
    if (!file) {
      setMoveDraft('');
      setCustomNameDraft('');
      setAuthorDraft('');
      setRatingDraft(0);
      setIsEditingCustomName(false);
      initialMetadataRef.current = { author: '', copyright: '', rating: 0, customName: '' };
      return;
    }

    setMoveDraft(getParentDirectory(file.relativePath));
    setCustomNameDraft(file.customName ?? '');
    setIsEditingCustomName(false);
    const baseCustomName = (file.customName ?? '').trim();
    initialMetadataRef.current = { author: '', copyright: '', rating: 0, customName: baseCustomName };

    void (async () => {
      try {
        const metadata = await window.api.readFileMetadata(file.id);
        let customNameValue = baseCustomName;
        if (metadata.title && metadata.title.trim().length > 0) {
          customNameValue = metadata.title.trim();
          setCustomNameDraft(customNameValue);
        }
        const authorValue = metadata.author?.trim() ?? '';
        const ratingValue = metadata.rating ?? 0;
        setAuthorDraft(authorValue);
        setRatingDraft(ratingValue);
        initialMetadataRef.current = {
          author: authorValue,
          copyright: '',
          rating: ratingValue,
          customName: customNameValue
        };
        if (authorValue.length > 0) {
          appendSuggestion(authorValue);
        }
      } catch (error) {
        console.error('Failed to read file metadata:', error);
        setAuthorDraft('');
        setRatingDraft(0);
        initialMetadataRef.current = { author: '', copyright: '', rating: 0, customName: baseCustomName };
      }
    })();
  }, [appendSuggestion, file?.id]);

  if (!file) {
    return <section className="file-detail empty">Select a file to view its details.</section>;
  }

  const handleStartCustomNameEdit = () => {
    setIsEditingCustomName(true);
  };

  const handleCustomNameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      setIsEditingCustomName(false);
      if (file) {
        setCustomNameDraft(file.customName ?? '');
      }
    }
  };

  const handleMove = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onMove(moveDraft.trim());
    } finally {
      setBusy(false);
    }
  };

  const handleCustomNameBlur = async () => {
    if (!file) return;
    
    setIsEditingCustomName(false);
    
    const normalizedValue = customNameDraft.trim();
    const previousValue = file.customName?.trim() ?? '';
    if (normalizedValue === previousValue) {
      return;
    }

    const payload = normalizedValue.length > 0 ? normalizedValue : null;
    let updateSucceeded = false;
    setBusy(true);
    try {
      await onUpdateCustomName(payload);
      updateSucceeded = true;
    } catch (error) {
      console.error('Failed to update custom name:', error);
      setCustomNameDraft(file.customName ?? '');
    } finally {
      setBusy(false);
    }

    if (updateSucceeded) {
      await triggerOrganize({ customName: normalizedValue });
    }
  };

  const triggerOrganize = async (overrides?: { author?: string; rating?: number; customName?: string | null }, force = false) => {
    if (!file) {
      return;
    }

    const nextAuthorRaw = overrides?.author !== undefined ? overrides.author : authorDraft;
    const nextRatingValue = overrides?.rating !== undefined ? overrides.rating : ratingDraft;
    const nextCustomNameRaw =
      overrides?.customName !== undefined ? overrides.customName ?? '' : customNameDraft;

    const trimmedAuthor = nextAuthorRaw.trim();
    const trimmedCustomName = (nextCustomNameRaw ?? '').toString().trim();
    const comparisonState = {
      author: trimmedAuthor,
      copyright: '',
      rating: nextRatingValue,
      customName: trimmedCustomName
    };

    const previous = initialMetadataRef.current;
    if (
      !force &&
      previous &&
      previous.author === comparisonState.author &&
      previous.copyright === comparisonState.copyright &&
      previous.rating === comparisonState.rating &&
      previous.customName === comparisonState.customName
    ) {
      return;
    }

    setBusy(true);
    try {
      if (file.categories.length === 0) {
        // No categories - just save metadata without organizing
        await window.api.updateFileMetadata(file.id, {
          author: trimmedAuthor.length > 0 ? trimmedAuthor : undefined,
          rating: comparisonState.rating > 0 ? comparisonState.rating : undefined
        });
      } else {
        // Has categories - organize the file
        await onOrganize({
          customName: trimmedCustomName.length > 0 ? trimmedCustomName : undefined,
          author: trimmedAuthor.length > 0 ? trimmedAuthor : undefined,
          rating: comparisonState.rating > 0 ? comparisonState.rating : undefined
        });
      }
      
      initialMetadataRef.current = comparisonState;
      if (trimmedAuthor.length > 0) {
        appendSuggestion(trimmedAuthor);
      }
    } catch (error) {
      console.error('Failed to save metadata:', error);
    } finally {
      setBusy(false);
    }
  };

  const handleCategorySave = async (selectedCategories: string[]) => {
    setBusy(true);
    try {
      await onUpdateTags(selectedCategories);
    } catch (error) {
      console.error('Failed to update categories', error);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenFolder = async () => {
    if (!file) return;
    try {
      await window.api.openFileFolder(file.id);
    } catch (error) {
      console.error('Failed to open folder:', error);
    }
  };

  const handleOpenParent = () => {
    if (!file || file.parentFileId === null || !onOpenParent) {
      return;
    }
    onOpenParent(file.parentFileId);
  };

  const toggleTagSection = () => {
    setIsTagSectionExpanded((value) => !value);
  };

  return (
    <section className="file-detail">
      <header className="file-detail-header">
        <div>
          {isEditingCustomName ? (
            <input
              className="file-name-input"
              value={customNameDraft}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setCustomNameDraft(event.target.value)}
              onBlur={handleCustomNameBlur}
              onKeyDown={handleCustomNameKeyDown}
              disabled={busy}
              placeholder="Enter custom name"
              autoFocus
            />
          ) : (
            <h1 className="file-name-editable" onClick={handleStartCustomNameEdit} title="Click to edit name">
              {file.customName || file.displayName}
            </h1>
          )}
          <div 
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            onMouseEnter={(e) => {
              const btn = e.currentTarget.querySelector('.file-regenerate-name') as HTMLElement;
              if (btn) btn.style.opacity = '1';
            }}
            onMouseLeave={(e) => {
              const btn = e.currentTarget.querySelector('.file-regenerate-name') as HTMLElement;
              if (btn) btn.style.opacity = '0';
            }}
          >
            <p 
              onClick={handleOpenFolder}
              style={{ cursor: 'pointer', opacity: 0.7, transition: 'opacity 0.2s ease', margin: 0 }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
              onMouseLeave={(e) => e.currentTarget.style.opacity = '0.7'}
              title="Click to open in folder"
            >
              {normalizePathDisplay(file.relativePath)}
            </p>
            <button
              type="button"
              className="file-regenerate-name"
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                setBusy(true);
                try {
                  await triggerOrganize({}, true);
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              title="Regenerate filename based on current metadata"
              style={{ 
                padding: '4px 8px',
                fontSize: '18px',
                opacity: 0,
                transition: 'opacity 0.2s ease',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'inherit'
              }}
            >
              ↻
            </button>
          </div>
          {file.parentFileId !== null && onOpenParent ? (
            <button
              type="button"
              className="file-parent-link"
              onClick={handleOpenParent}
              title={parentFile ? `Open source file ${parentFile.displayName}` : 'Open source file'}
            >
              🔗 {parentFile ? parentFile.customName || parentFile.displayName : `Source missing (#${file.parentFileId})`}
            </button>
          ) : null}
        </div>
        <div className="file-meta-grid">
          <div>{formatBytes(file.size)}</div>
          <div>{formatDuration(file.durationMs)}</div>
          <div>{file.sampleRate ? `${(file.sampleRate / 1000).toFixed(1)}kHz` : 'Unknown'}</div>
          <div>{file.bitDepth ? `${file.bitDepth}-bit` : 'Unknown'}</div>
        </div>
      </header>

      <form className="file-actions" onSubmit={(event) => event.preventDefault()}>
        <div className="file-actions-grid">
          <label>
            <span>Author</span>
            <input 
              value={authorDraft} 
              onChange={(event: ChangeEvent<HTMLInputElement>) => setAuthorDraft(event.target.value)}
              onBlur={(event) => {
                void triggerOrganize({ author: event.currentTarget.value });
              }}
              placeholder="Artist or creator name"
              disabled={busy}
            />
            {filteredAuthorSuggestions.length > 0 && (
              <div className="metadata-suggestion-list" role="listbox" aria-label="Author suggestions">
                {filteredAuthorSuggestions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="metadata-suggestion"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setAuthorDraft(option);
                      void triggerOrganize({ author: option });
                    }}
                    disabled={busy}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
          </label>
          <label>
            <span>Rating</span>
            <div className="star-rating">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  className={ratingDraft >= star ? 'star star--filled' : 'star'}
                  onClick={() => {
                    const nextValue = ratingDraft === star ? 0 : star;
                    setRatingDraft(nextValue);
                    void triggerOrganize({ rating: nextValue });
                  }}
                  disabled={busy}
                  aria-label={`${star} star${star > 1 ? 's' : ''}`}
                >
                  ★
                </button>
              ))}
            </div>
          </label>
        </div>
      </form>

      <section className="tag-editor-pane">
        <button
          type="button"
          className="tag-editor-toggle"
          onClick={toggleTagSection}
          aria-expanded={isTagSectionExpanded}
        >
          <span className="tag-editor-toggle-label">Categories</span>
          <span className="tag-editor-toggle-icon" aria-hidden="true">
            {isTagSectionExpanded ? 'v' : '>'}
          </span>
        </button>
        <div className={isTagSectionExpanded ? 'tag-editor-content tag-editor-content--open' : 'tag-editor-content'} aria-hidden={!isTagSectionExpanded}>
          <TagEditor
            categories={file.categories}
            availableCategories={categories}
            onSave={handleCategorySave}
            showHeading={false}
          />
        </div>
      </section>
    </section>
  );
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

function getParentDirectory(relativePath: string): string {
  if (!relativePath || !relativePath.includes(pathSeparator())) {
    return '';
  }
  const segments = relativePath.split(pathSeparator());
  segments.pop();
  return segments.join(pathSeparator());
}

function pathSeparator(): string {
  return typeof window !== 'undefined' && navigator.platform.startsWith('Win') ? '\\' : '/';
}

export default FileDetailPanel;
