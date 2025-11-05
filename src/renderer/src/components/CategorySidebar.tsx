import { useMemo } from 'react';
import type { AudioFileSummary, CategoryRecord } from '../../../shared/models';
import { CATEGORY_FILTER_UNTAGGED, type CategoryFilterValue } from '../stores/LibraryStore';
import {
  buildCategorySwatch,
  createCategoryStyleVars,
  formatCategoryLabel
} from '../utils/categoryColors';

export interface CategorySidebarProps {
  categories: CategoryRecord[];
  files: AudioFileSummary[];
  activeFilter: CategoryFilterValue;
  onSelect(filter: CategoryFilterValue): void;
  onDropFiles?(fileIds: number[], categoryId: string): void;
}

function deriveCounts(files: AudioFileSummary[]): {
  total: number;
  untagged: number;
  categoryCounts: Map<string, number>;
} {
  const categoryCounts = new Map<string, number>();
  let untagged = 0;
  for (const file of files) {
    if (file.categories.length === 0) {
      untagged += 1;
    }
    for (const categoryId of file.categories) {
      categoryCounts.set(categoryId, (categoryCounts.get(categoryId) ?? 0) + 1);
    }
  }
  return {
    total: files.length,
    untagged,
    categoryCounts
  };
}

export function CategorySidebar({ categories, files, activeFilter, onSelect, onDropFiles }: CategorySidebarProps): JSX.Element {
  const { total, untagged, categoryCounts } = deriveCounts(files);
  const swatchMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildCategorySwatch>>();
    for (const record of categories) {
      const existing = map.get(record.category) ?? buildCategorySwatch(record.category);
      map.set(record.category, existing);
      map.set(record.id, existing);
    }
    return map;
  }, [categories]);
  const grouped = new Map<string, CategoryRecord[]>();
  for (const record of categories) {
    grouped.set(record.category, [...(grouped.get(record.category) ?? []), record]);
  }

  const sortedGroups = Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b));

  const handleSelect = (filter: CategoryFilterValue) => {
    onSelect(filter);
  };

  const handleDragOver = (event: React.DragEvent) => {
    if (event.dataTransfer.types.includes('application/audiosort-file')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDrop = (event: React.DragEvent, categoryId: string) => {
    event.preventDefault();
    const data = event.dataTransfer.getData('application/audiosort-file');
    if (!data || !onDropFiles) return;
    
    try {
      const { selectedIds } = JSON.parse(data) as { fileId: number; selectedIds: number[] };
      const fileIds = selectedIds.length > 0 ? selectedIds : [];
      if (fileIds.length > 0) {
        onDropFiles(fileIds, categoryId);
      }
    } catch (error) {
      console.error('Failed to parse drag data:', error);
    }
  };

  return (
    <aside className="category-sidebar">
      <div className="category-sidebar__section">
        <button
          type="button"
          className="category-sidebar__item"
          data-active={activeFilter === null}
          onClick={() => handleSelect(null)}
        >
          <span className="category-sidebar__label">All Files</span>
          <span className="category-sidebar__count">{total}</span>
        </button>
        <button
          type="button"
          className="category-sidebar__item"
          data-active={activeFilter === CATEGORY_FILTER_UNTAGGED}
          onClick={() => handleSelect(CATEGORY_FILTER_UNTAGGED)}
        >
          <span className="category-sidebar__label">TO TAG</span>
          <span className="category-sidebar__count">{untagged}</span>
        </button>
      </div>
      {sortedGroups.map(([groupName, records]) => {
        const sortedRecords = records
          .slice()
          .sort((a, b) => a.subCategory.localeCompare(b.subCategory, undefined, { sensitivity: 'base' }));
        const hasVisible = sortedRecords.some((record) => (categoryCounts.get(record.id) ?? 0) > 0);
        if (!hasVisible) {
          return null;
        }
        return (
          <div className="category-sidebar__section" key={groupName}>
            <div className="category-sidebar__group">{formatCategoryLabel(groupName)}</div>
            {sortedRecords.map((record) => {
              const count = categoryCounts.get(record.id) ?? 0;
              if (count === 0) {
                return null;
              }
              const styleVars = createCategoryStyleVars(swatchMap.get(record.id));
              return (
                <button
                  type="button"
                  key={record.id}
                  className="category-sidebar__item category-sidebar__item--child"
                  data-active={activeFilter === record.id}
                  onClick={() => handleSelect(record.id)}
                  onDragOver={handleDragOver}
                  onDrop={(event) => handleDrop(event, record.id)}
                  style={styleVars}
                >
                  <span className="category-sidebar__label">{formatCategoryLabel(record.subCategory)}</span>
                  <span className="category-sidebar__count">{count}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}

export default CategorySidebar;
