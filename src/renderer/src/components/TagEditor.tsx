import { useEffect, useMemo, useState, useRef, useLayoutEffect, type UIEvent } from 'react';
import type { CategoryRecord } from '../../../shared/models';
import {
  getCollapsedGroups,
  initializeCollapsedGroups,
  setCollapsedGroups as setModuleCollapsedGroups,
  getTagEditorScrollTop,
  setTagEditorScrollTop
} from '../stores/CategoryUIState';
import {
  buildCategorySwatch,
  createCategoryStyleVars,
  formatCategoryLabel
} from '../utils/categoryColors';
import type { CategorySwatch } from '../utils/categoryColors';

export interface TagEditorProps {
  categories: string[];
  availableCategories: CategoryRecord[];
  onSave(categories: string[]): void | Promise<void>;
  /** If false the internal heading is omitted. Defaults to true. */
  showHeading?: boolean;
}

/**
 * Provides category selection controls without exposing free-form tag editing.
 */
export function TagEditor({ categories, availableCategories, onSave, showHeading = true }: TagEditorProps): JSX.Element {
  const [categoryFilter, setCategoryFilter] = useState('');
  const [selectedCategories, setSelectedCategories] = useState(new Set(categories));
  const [isCategoryListExpanded, setIsCategoryListExpanded] = useState(false);

  // Initialize module state if needed
  initializeCollapsedGroups(availableCategories.map((cat) => cat.category));
  
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    const moduleState = getCollapsedGroups();
    return new Set(moduleState!);
  });
  const listRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    setSelectedCategories(new Set(categories));
    
    if (!isFirstRender.current) {
      const moduleState = getCollapsedGroups();
      setCollapsedGroups(new Set(moduleState!));
    } else {
      isFirstRender.current = false;
    }
  }, [categories]);

  const { groupedCategories, filteredResults } = useMemo(() => {
    const filter = categoryFilter.trim().toLowerCase();
    const filtered = filter.length === 0
      ? availableCategories
      : availableCategories.filter((entry: CategoryRecord) => {
          const haystack = `${entry.category} ${entry.subCategory} ${entry.shortCode} ${entry.synonyms.join(' ')}`.toLowerCase();
          return haystack.includes(filter);
        });

    const grouped = filtered.reduce((acc, category) => {
      if (!acc[category.category]) {
        acc[category.category] = [];
      }
      acc[category.category].push(category);
      return acc;
    }, {} as Record<string, CategoryRecord[]>);
    return { groupedCategories: grouped, filteredResults: filtered };
  }, [availableCategories, categoryFilter]);

  const selectedCategoryRecords = useMemo(
    () => {
      // Preserve the order from the categories prop (first category is primary)
      const orderedRecords: CategoryRecord[] = [];
      for (const catId of categories) {
        const record = availableCategories.find((entry) => entry.id === catId);
        if (record && selectedCategories.has(catId)) {
          orderedRecords.push(record);
        }
      }
      return orderedRecords;
    },
    [availableCategories, selectedCategories, categories]
  );

  const categoryColorMap = useMemo(() => {
    const map = new Map<string, CategorySwatch>();
    availableCategories.forEach((entry) => {
      const existing = map.get(entry.category);
      const swatch = existing ?? buildCategorySwatch(entry.category);
      map.set(entry.category, swatch);
      map.set(entry.id, swatch);
    });
    return map;
  }, [availableCategories]);

  const filterSuggestions = useMemo(() => {
    if (categoryFilter.trim().length === 0) {
      return [] as CategoryRecord[];
    }
    return filteredResults.slice(0, 6);
  }, [categoryFilter, filteredResults]);

  useLayoutEffect(() => {
    const node = listRef.current;
    if (node) {
      node.scrollTop = getTagEditorScrollTop();
    }
  }, [groupedCategories, collapsedGroups]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setTagEditorScrollTop(event.currentTarget.scrollTop);
  };

  const toggleGroup = (groupName: string) => {
    const next = new Set(collapsedGroups);
    const moduleState = getCollapsedGroups()!;
    if (next.has(groupName)) {
      next.delete(groupName);
      moduleState.delete(groupName);
    } else {
      next.add(groupName);
      moduleState.add(groupName);
    }
    setModuleCollapsedGroups(moduleState);
    setCollapsedGroups(next);
  };

  const toggleCategory = (categoryId: string) => {
    const next = new Set(selectedCategories);
    if (next.has(categoryId)) {
      next.delete(categoryId);
    } else {
      next.add(categoryId);
    }
    setSelectedCategories(next);
    onSave(Array.from(next));
  };

  const handleSetPrimaryCategory = (categoryId: string) => {
    const currentList = Array.from(selectedCategories);
    // Remove the category from its current position
    const filteredList = currentList.filter((id) => id !== categoryId);
    // Add it to the front
    const reorderedList = [categoryId, ...filteredList];
    setSelectedCategories(new Set(reorderedList));
    void onSave(reorderedList);
  };

  const handleRemoveCategory = (categoryId: string) => {
    if (!selectedCategories.has(categoryId)) {
      return;
    }
    toggleCategory(categoryId);
  };

  const handleClearCategories = () => {
    if (selectedCategories.size === 0) {
      return;
    }
    setSelectedCategories(new Set());
    onSave([]);
  };

  const toggleCategoryList = () => {
    setIsCategoryListExpanded((value) => !value);
  };

  return (
    <section className="tag-editor">
      {showHeading && <h2>Categories</h2>}
      <div className="selected-categories">
        <div className="selected-category-chip-list">
          {selectedCategoryRecords.length === 0 && <span className="selected-category-empty">No categories selected</span>}
          {selectedCategoryRecords.map((entry, index) => {
            const categoryLabel = formatCategoryLabel(entry.category);
            const subCategoryLabel = formatCategoryLabel(entry.subCategory);
            const isPrimary = index === 0;
            return (
              <div
                key={entry.id}
                className="selected-category-chip"
                style={{ 
                  ...createCategoryStyleVars(categoryColorMap.get(entry.id)),
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  position: 'relative'
                }}
                onMouseEnter={(e) => {
                  const star = e.currentTarget.querySelector('.category-star-button') as HTMLElement;
                  if (star && !isPrimary) {
                    star.style.opacity = '1';
                    star.style.width = 'auto';
                    star.style.padding = '0 4px';
                  }
                  const removeBtn = e.currentTarget.querySelector('.selected-category-chip-remove-button') as HTMLElement;
                  if (removeBtn) {
                    removeBtn.style.opacity = '1';
                    removeBtn.style.width = 'auto';
                    removeBtn.style.padding = '0 4px';
                  }
                }}
                onMouseLeave={(e) => {
                  const star = e.currentTarget.querySelector('.category-star-button') as HTMLElement;
                  if (star && !isPrimary) {
                    star.style.opacity = '0';
                    star.style.width = '0';
                    star.style.padding = '0';
                  }
                  const removeBtn = e.currentTarget.querySelector('.selected-category-chip-remove-button') as HTMLElement;
                  if (removeBtn) {
                    removeBtn.style.opacity = '0';
                    removeBtn.style.width = '0';
                    removeBtn.style.padding = '0';
                  }
                }}
                title={isPrimary ? `${categoryLabel} ${subCategoryLabel} (Primary - used for organization)` : `${categoryLabel} ${subCategoryLabel}`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSetPrimaryCategory(entry.id);
                  }}
                  className="category-star-button"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: isPrimary ? '0 4px' : '0',
                    margin: 0,
                    cursor: 'pointer',
                    fontSize: '14px',
                    opacity: isPrimary ? 1 : 0,
                    width: isPrimary ? 'auto' : '0',
                    overflow: 'hidden',
                    transition: 'opacity 0.2s ease, width 0.2s ease, padding 0.2s ease',
                    color: isPrimary ? 'gold' : 'currentColor',
                    flexShrink: 0
                  }}
                  title={isPrimary ? 'Primary category' : 'Set as primary category'}
                  aria-label={isPrimary ? 'Primary category' : 'Set as primary category'}
                >
                  {isPrimary ? '★' : '☆'}
                </button>
                <span className="selected-category-chip-label">
                  <span className="category-label category-label--muted">{categoryLabel}</span>
                  <span className="category-label category-label--primary">{subCategoryLabel}</span>
                </span>
                <button
                  type="button"
                  className="selected-category-chip-remove-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveCategory(entry.id);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '0',
                    margin: 0,
                    cursor: 'pointer',
                    fontSize: '18px',
                    lineHeight: 1,
                    opacity: 0,
                    width: '0',
                    overflow: 'hidden',
                    transition: 'opacity 0.2s ease, width 0.2s ease, padding 0.2s ease',
                    flexShrink: 0
                  }}
                  aria-label="Remove category"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="ghost-button selected-category-clear"
          onClick={handleClearCategories}
          disabled={selectedCategories.size === 0}
        >
          Clear All
        </button>
      </div>
      <div className="category-filter">
        <input
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
          placeholder="Filter UCS categories"
        />
      </div>
      {categoryFilter.trim().length > 0 && (
        filterSuggestions.length > 0 ? (
          <div className="category-filter-suggestions">
            <span className="category-filter-suggestions-label">Suggestions</span>
            <div className="category-filter-suggestion-list">
              {filterSuggestions.map((entry) => {
                const selected = selectedCategories.has(entry.id);
                const colorStyle = createCategoryStyleVars(categoryColorMap.get(entry.id));
                const categoryLabel = formatCategoryLabel(entry.category);
                const subCategoryLabel = formatCategoryLabel(entry.subCategory);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={selected ? 'category-filter-suggestion category-filter-suggestion--selected' : 'category-filter-suggestion'}
                    onClick={() => toggleCategory(entry.id)}
                    style={colorStyle}
                    title={`${categoryLabel} ${subCategoryLabel}`}
                  >
                    <span className="category-filter-suggestion-name">
                      <span className="category-label category-label--muted">{categoryLabel}</span>
                      <span className="category-label category-label--primary">{subCategoryLabel}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="category-filter-empty">No categories match this filter.</div>
        )
      )}
      <div className="category-list-pane">
        <button
          type="button"
          className="category-list-toggle"
          onClick={toggleCategoryList}
          aria-expanded={isCategoryListExpanded}
        >
          <span className="category-list-toggle-label">All Categories</span>
          <span className="category-list-toggle-icon" aria-hidden="true">
            {isCategoryListExpanded ? 'v' : '>'}
          </span>
        </button>
        {isCategoryListExpanded && (
          <div className="category-list" ref={listRef} onScroll={handleScroll}>
            {Object.entries(groupedCategories).map(([groupName, groupCategories]) => {
              const isCollapsed = collapsedGroups.has(groupName);
              const displayGroupName = formatCategoryLabel(groupName);
              return (
                <div key={groupName} className="category-group">
                  <button
                    type="button"
                    className="category-group-header"
                    onClick={() => toggleGroup(groupName)}
                  >
                    <span className="category-group-arrow">{isCollapsed ? '▶' : '▼'}</span>
                    <span className="category-group-title">{displayGroupName}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="category-group-items">
                      {groupCategories.map((entry: CategoryRecord) => {
                        const selected = selectedCategories.has(entry.id);
                        const colorStyle = createCategoryStyleVars(categoryColorMap.get(entry.id));
                        const className = selected ? 'category-item category-item--selected' : 'category-item';
                        const categoryLabel = formatCategoryLabel(entry.category);
                        const subCategoryLabel = formatCategoryLabel(entry.subCategory);
                        return (
                          <label
                            key={entry.id}
                            className={className}
                            style={colorStyle}
                            title={`${categoryLabel} ${subCategoryLabel}`}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleCategory(entry.id)}
                            />
                            <span className="category-item-label">
                              <span className="category-label category-label--muted">{categoryLabel}</span>
                              <span className="category-label category-label--primary">{subCategoryLabel}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default TagEditor;
