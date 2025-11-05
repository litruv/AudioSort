import { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback, type UIEvent } from 'react';
import type { AudioFileSummary, CategoryRecord } from '../../../shared/models';
import { getMultiEditorScrollTop, setMultiEditorScrollTop } from '../stores/CategoryUIState';
import { TagEditor } from './TagEditor';

export interface MultiFileEditorProps {
  files: AudioFileSummary[];
  categories: CategoryRecord[];
  onUpdateTags(fileId: number, data: { tags: string[]; categories: string[] }): Promise<void>;
  onUpdateCustomName(fileId: number, customName: string | null): Promise<void>;
  onOrganize(fileId: number, metadata: { customName?: string | null; author?: string | null; rating?: number }): Promise<void>;
  onUpdateMetadata(fileId: number, metadata: { author?: string | null; rating?: number }): Promise<void>;
  metadataSuggestionsVersion: number;
}

/**
 * Multi-file tag editor that shows aggregated metadata and allows batch editing.
 */
export function MultiFileEditor({ files, categories, onUpdateTags, onUpdateCustomName, onOrganize, onUpdateMetadata, metadataSuggestionsVersion }: MultiFileEditorProps): JSX.Element {
  const [sharedCustomName, setSharedCustomName] = useState('');
  const [sharedAuthor, setSharedAuthor] = useState('');
  const [sharedRating, setSharedRating] = useState(0);
  const [suggestions, setSuggestions] = useState<{ authors: string[] }>({ authors: [] });
  const [isTagSectionExpanded, setIsTagSectionExpanded] = useState(true);

  // Compute aggregated tags and categories for TagEditor
  const aggregatedTags = useMemo(() => {
    const tagCounts = new Map<string, number>();
    for (const file of files) {
      for (const tag of file.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    // Only show tags that appear in all files
    return Array.from(tagCounts.entries())
      .filter(([, count]) => count === files.length)
      .map(([tag]) => tag);
  }, [files]);

  const aggregatedCategories = useMemo(() => {
    const categoryCounts = new Map<string, number>();
    for (const file of files) {
      for (const category of file.categories) {
        categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      }
    }
    // Only show categories that appear in all files
    return Array.from(categoryCounts.entries())
      .filter(([, count]) => count === files.length)
      .map(([category]) => category);
  }, [files]);

  const listRef = useRef<HTMLDivElement>(null);

  type SuggestionKey = 'authors';

  const appendSuggestion = useCallback((value: string, key: SuggestionKey) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    setSuggestions((previous) => {
      if (previous[key].some((entry) => entry.localeCompare(trimmed, undefined, { sensitivity: 'accent' }) === 0)) {
        return previous;
      }
      const nextList = [...previous[key], trimmed].sort((a, b) => a.localeCompare(b));
      return {
        ...previous,
        [key]: nextList
      };
    });
  }, []);

  const filteredAuthorSuggestions = useMemo(() => {
    if (suggestions.authors.length === 0) {
      return [] as string[];
    }
    const query = sharedAuthor.trim().toLowerCase();
    const base = suggestions.authors.filter((entry) => entry.toLowerCase() !== query);
    if (query.length === 0) {
      return base.slice(0, 5);
    }
    return base.filter((entry) => entry.toLowerCase().includes(query)).slice(0, 5);
  }, [sharedAuthor, suggestions.authors]);

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

  useLayoutEffect(() => {
    const node = listRef.current;
    if (node) {
      node.scrollTop = getMultiEditorScrollTop();
    }
  }, [files]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setMultiEditorScrollTop(event.currentTarget.scrollTop);
  };

  const handleSharedCustomNameBlur = async () => {
    const normalized = sharedCustomName.trim().length > 0 ? sharedCustomName.trim() : null;
    
    if (!normalized) return;
    
    try {
      let failureCount = 0;
      for (const file of files) {
        try {
          if (file.categories.length > 0) {
            await onOrganize(file.id, { customName: normalized });
          } else {
            await onUpdateCustomName(file.id, normalized);
          }
        } catch (error) {
          failureCount += 1;
          console.error(`Failed to update custom name for file ${file.id} (${file.fileName}):`, error);
        }
      }
      if (failureCount > 0) {
        console.error(`${failureCount} file(s) failed to update`);
      }
    } catch (error) {
      console.error('Failed to update custom names:', error);
    }
  };

  const handleSharedAuthorBlur = async () => {
    const normalized = sharedAuthor.trim();
    const authorPayload = normalized.length > 0 ? normalized : null;

    try {
      let failureCount = 0;
      for (const file of files) {
        try {
          if (file.categories.length > 0) {
            await onOrganize(file.id, { author: authorPayload });
          } else {
            await onUpdateMetadata(file.id, { author: authorPayload });
          }
        } catch (error) {
          failureCount += 1;
          console.error(`Failed to update author for file ${file.id} (${file.fileName}):`, error);
        }
      }
      if (failureCount > 0) {
        console.error(`${failureCount} file(s) failed to update author`);
      }
      
      if (authorPayload && authorPayload.length > 0) {
        appendSuggestion(authorPayload, 'authors');
      }
    } catch (error) {
      console.error('Failed to update author:', error);
    }
  };

  const handleSharedRatingChange = async (rating: number) => {
    setSharedRating(rating);
    
    try {
      let failureCount = 0;
      for (const file of files) {
        try {
          if (file.categories.length > 0) {
            await onOrganize(file.id, { rating });
          } else {
            await onUpdateMetadata(file.id, { rating });
          }
        } catch (error) {
          failureCount += 1;
          console.error(`Failed to update rating for file ${file.id} (${file.fileName}):`, error);
        }
      }
      if (failureCount > 0) {
        console.error(`${failureCount} file(s) failed to update rating`);
      }
    } catch (error) {
      console.error('Failed to update rating:', error);
    }
  };

  const handleTagSave = async (data: { tags: string[]; categories: string[] }) => {
    try {
      let failureCount = 0;
      for (const file of files) {
        try {
          await onUpdateTags(file.id, data);
        } catch (error) {
          failureCount += 1;
          console.error(`Failed to update tags for file ${file.id} (${file.fileName}):`, error);
        }
      }
      if (failureCount > 0) {
        console.error(`${failureCount} file(s) failed to update tags`);
      }
    } catch (error) {
      console.error('Failed to update tags:', error);
    }
  };

  const toggleTagSection = () => {
    setIsTagSectionExpanded((value) => !value);
  };

  return (
    <section className="multi-file-editor">
      <header className="multi-file-editor-header">
        <h2>Editing {files.length} files</h2>
      </header>

      <div className="multi-file-editor-body" ref={listRef} onScroll={handleScroll}>
        <div className="multi-file-metadata-section">
          <h3>Shared Metadata</h3>
          <div className="multi-file-metadata-grid">
            <label>
              <span>Name</span>
              <input
                type="text"
                value={sharedCustomName}
                onChange={(e) => setSharedCustomName(e.target.value)}
                onBlur={handleSharedCustomNameBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Custom name for all selected files"
              />
            </label>
            <label>
              <span>Author</span>
              <input
                type="text"
                value={sharedAuthor}
                onChange={(e) => setSharedAuthor(e.target.value)}
                onBlur={handleSharedAuthorBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Artist or creator name"
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
                        setSharedAuthor(option);
                        void handleSharedAuthorBlur();
                      }}
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
                    className={sharedRating >= star ? 'star star--filled' : 'star'}
                    onClick={() => {
                      const nextValue = sharedRating === star ? 0 : star;
                      void handleSharedRatingChange(nextValue);
                    }}
                    aria-label={`${star} star${star > 1 ? 's' : ''}`}
                  >
                    ★
                  </button>
                ))}
              </div>
            </label>
          </div>
        </div>

        <section className="tag-editor-pane">
          <button
            type="button"
            className="tag-editor-toggle"
            onClick={toggleTagSection}
            aria-expanded={isTagSectionExpanded}
          >
            <span className="tag-editor-toggle-label">Tags</span>
            <span className="tag-editor-toggle-icon" aria-hidden="true">
              {isTagSectionExpanded ? 'v' : '>'}
            </span>
          </button>
          <div className={isTagSectionExpanded ? 'tag-editor-content tag-editor-content--open' : 'tag-editor-content'} aria-hidden={!isTagSectionExpanded}>
            <TagEditor
              tags={aggregatedTags}
              categories={aggregatedCategories}
              availableCategories={categories}
              onSave={handleTagSave}
              showHeading={false}
            />
          </div>
        </section>
      </div>
    </section>
  );
}

export default MultiFileEditor;
