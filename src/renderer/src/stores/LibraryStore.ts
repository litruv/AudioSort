import type {
  AppSettings,
  AudioFileSummary,
  CategoryRecord,
  LibraryScanSummary,
  SplitSegmentRequest,
  TagUpdatePayload
} from '../../../shared/models';

type ChangeListener = () => void;

export const CATEGORY_FILTER_UNTAGGED = 'untagged' as const;
export type CategoryFilterValue = string | typeof CATEGORY_FILTER_UNTAGGED | null;

export interface LibrarySnapshot {
  initialized: boolean;
  files: AudioFileSummary[];
  visibleFiles: AudioFileSummary[];
  selectedFileId: number | null;
  selectedFileIds: Set<number>;
  focusedFile: AudioFileSummary | null;
  categories: CategoryRecord[];
  settings: AppSettings;
  searchQuery: string;
  categoryFilter: CategoryFilterValue;
  lastScan: LibraryScanSummary | null;
  metadataSuggestionsVersion: number;
}

/**
 * Centralises renderer-side library state management with a subscription mechanism for React hooks.
 */
export class LibraryStore extends EventTarget {
  private snapshot: LibrarySnapshot = {
    initialized: false,
    files: [],
    visibleFiles: [],
    selectedFileId: null,
    selectedFileIds: new Set(),
    focusedFile: null,
    categories: [],
    settings: { libraryPath: null },
    searchQuery: '',
    categoryFilter: null,
    lastScan: null,
    metadataSuggestionsVersion: 0
  };

  /**
   * Bootstraps the store by loading settings, categories, and the current file list.
   */
  public async bootstrap(): Promise<void> {
    const [settings, categories, files] = await Promise.all([
      window.api.getSettings(),
      window.api.listCategories(),
      window.api.listAudioFiles()
    ]);
    const firstFileId = files.at(0)?.id ?? null;
    const firstFile = files.at(0) ?? null;
    const nextVersion = this.snapshot.metadataSuggestionsVersion + 1;
    this.snapshot = {
      initialized: true,
      files,
      visibleFiles: [],
      categories,
      settings,
      selectedFileId: firstFileId,
      selectedFileIds: firstFileId !== null ? new Set([firstFileId]) : new Set(),
      focusedFile: firstFile,
      searchQuery: '',
      categoryFilter: null,
      lastScan: null,
      metadataSuggestionsVersion: nextVersion
    };
    this.refreshVisibleFiles(this.snapshot.selectedFileId ?? null);
  }

  /**
   * React friendly subscription helper.
   */
  public subscribe(listener: ChangeListener): () => void {
    const handler = () => listener();
    this.addEventListener('change', handler as EventListener);
    return () => this.removeEventListener('change', handler as EventListener);
  }

  /**
   * Snapshot getter used by hooks.
   */
  public getSnapshot(): LibrarySnapshot {
    return this.snapshot;
  }

  /**
   * Updates the selected file id (single selection or multi-select toggle).
   */
  public selectFile(fileId: number | null, options: { multi?: boolean; range?: boolean } = {}): void {
    const previousFocused = this.snapshot.focusedFile;
    if (fileId !== null && !this.snapshot.visibleFiles.some((file) => file.id === fileId)) {
      return;
    }

    if (options.multi) {
      const newSelection = new Set(this.snapshot.selectedFileIds);
      if (fileId !== null) {
        if (newSelection.has(fileId)) {
          newSelection.delete(fileId);
        } else {
          newSelection.add(fileId);
        }
      }
      this.snapshot = {
        ...this.snapshot,
        selectedFileId: fileId,
        selectedFileIds: newSelection,
        focusedFile:
          fileId !== null
            ? this.snapshot.files.find((file) => file.id === fileId) ?? (previousFocused?.id === fileId ? previousFocused : null)
            : previousFocused
      };
    } else if (options.range && fileId !== null && this.snapshot.selectedFileId !== null) {
      const visibleIds = this.snapshot.visibleFiles.map((f) => f.id);
      const currentIndex = visibleIds.indexOf(this.snapshot.selectedFileId);
      const targetIndex = visibleIds.indexOf(fileId);
      if (currentIndex !== -1 && targetIndex !== -1) {
        const start = Math.min(currentIndex, targetIndex);
        const end = Math.max(currentIndex, targetIndex);
        const rangeIds = visibleIds.slice(start, end + 1);
        this.snapshot = {
          ...this.snapshot,
          selectedFileId: fileId,
          selectedFileIds: new Set(rangeIds),
          focusedFile:
            this.snapshot.files.find((file) => file.id === fileId) ?? (previousFocused?.id === fileId ? previousFocused : null)
        };
      }
    } else {
      this.snapshot = {
        ...this.snapshot,
        selectedFileId: fileId,
        selectedFileIds: fileId !== null ? new Set([fileId]) : new Set(),
        focusedFile:
          fileId !== null
            ? this.snapshot.files.find((file) => file.id === fileId) ?? (previousFocused?.id === fileId ? previousFocused : null)
            : null
      };
    }
    this.emitChange();
  }

  /**
   * Selects every file currently visible in the library view.
   */
  public selectAllVisibleFiles(): void {
    if (this.snapshot.visibleFiles.length === 0) {
      return;
    }

    const visibleIds = this.snapshot.visibleFiles.map((file) => file.id);
    const primaryId = this.snapshot.selectedFileId !== null && visibleIds.includes(this.snapshot.selectedFileId)
      ? this.snapshot.selectedFileId
      : visibleIds[0];

    const previousFocused = this.snapshot.focusedFile;
    const nextFocused = this.snapshot.files.find((file) => file.id === primaryId) ?? (previousFocused?.id === primaryId ? previousFocused : null);

    this.snapshot = {
      ...this.snapshot,
      selectedFileId: primaryId,
      selectedFileIds: new Set(visibleIds),
      focusedFile: nextFocused
    };

    this.emitChange();
  }

  /**
   * Steps the selection forwards or backwards within the visible file list.
   */
  public selectAdjacent(offset: number): void {
    if (!Number.isFinite(offset) || offset === 0 || this.snapshot.visibleFiles.length === 0) {
      return;
    }

    const visibleIds = this.snapshot.visibleFiles.map((file) => file.id);
    const currentIndex = this.snapshot.selectedFileId !== null
      ? visibleIds.indexOf(this.snapshot.selectedFileId)
      : -1;

    const fallbackIndex = offset > 0 ? 0 : visibleIds.length - 1;
    const baseIndex = currentIndex === -1 ? fallbackIndex : currentIndex + offset;
    const nextIndex = Math.min(Math.max(baseIndex, 0), visibleIds.length - 1);
    const nextId = visibleIds[nextIndex];

    if (nextId === this.snapshot.selectedFileId) {
      return;
    }

    const previousFocused = this.snapshot.focusedFile;
    this.snapshot = {
      ...this.snapshot,
      selectedFileId: nextId,
      selectedFileIds: new Set([nextId]),
      focusedFile:
        this.snapshot.files.find((file) => file.id === nextId) ?? (previousFocused?.id === nextId ? previousFocused : null)
    };
    this.emitChange();
  }

  /**
   * Executes a fuzzy search request.
   */
  public async search(query: string): Promise<void> {
    const results = query.trim().length === 0 ? await window.api.listAudioFiles() : await window.api.search(query);
    this.snapshot = {
      ...this.snapshot,
      files: results,
      searchQuery: query,
      selectedFileId: results.at(0)?.id ?? null,
      focusedFile: this.snapshot.focusedFile
    };
    this.refreshVisibleFiles(this.snapshot.selectedFileId ?? null);
  }

  public setCategoryFilter(filter: CategoryFilterValue): void {
    if (this.snapshot.categoryFilter === filter) {
      return;
    }
    const { files, selectedFileId, focusedFile } = this.snapshot;
    this.snapshot = {
      ...this.snapshot,
      categoryFilter: filter
    };
    
    let visible: AudioFileSummary[];
    if (filter === CATEGORY_FILTER_UNTAGGED) {
      visible = files.filter((file) => file.categories.length === 0);
    } else if (filter) {
      visible = files.filter((file) => file.categories.includes(filter));
    } else {
      visible = files.slice();
    }
    
    this.snapshot = {
      ...this.snapshot,
      visibleFiles: visible,
      selectedFileId,
      focusedFile
    };
    this.emitChange();
  }

  /**
   * Requests a full library rescan and updates cached files accordingly.
   */
  public async rescan(): Promise<LibraryScanSummary> {
    const summary = await window.api.rescanLibrary();
    const files = await window.api.listAudioFiles();
    this.snapshot = {
      ...this.snapshot,
      files,
      selectedFileId: files.at(0)?.id ?? null,
      lastScan: summary,
      focusedFile: this.snapshot.focusedFile,
      metadataSuggestionsVersion: this.snapshot.metadataSuggestionsVersion + 1
    };
    this.refreshVisibleFiles(this.snapshot.selectedFileId ?? null);
    return summary;
  }

  /**
   * Applies tag mutations to both the backend and the cached snapshot.
   */
  public async updateTagging(payload: TagUpdatePayload): Promise<AudioFileSummary> {
    const updated = await window.api.updateTagging(payload);
    this.applyFilePatch(updated);
    return updated;
  }

  /**
   * Renames a file and replaces it inside the store.
   */
  public async renameFile(fileId: number, newName: string): Promise<AudioFileSummary> {
    const updated = await window.api.renameFile(fileId, newName);
    this.applyFilePatch(updated);
    return updated;
  }

  /**
   * Moves a file to another relative directory within the library.
   */
  public async moveFile(fileId: number, targetRelativeDirectory: string): Promise<AudioFileSummary> {
    const updated = await window.api.moveFile(fileId, targetRelativeDirectory);
    this.applyFilePatch(updated);
    return updated;
  }

  /**
   * Automatically organizes a file based on its categories.
   */
  public async organizeFile(fileId: number, metadata: { customName?: string | null; author?: string | null; rating?: number }): Promise<AudioFileSummary> {
    const currentSelection = this.snapshot.selectedFileId;
    const currentFocused = this.snapshot.focusedFile;
    const updated = await window.api.organizeFile(fileId, metadata);
    const files = await window.api.listAudioFiles();
    
    const { categoryFilter } = this.snapshot;
    let visible: AudioFileSummary[];
    if (categoryFilter === CATEGORY_FILTER_UNTAGGED) {
      visible = files.filter((file) => file.categories.length === 0);
    } else if (categoryFilter) {
      visible = files.filter((file) => file.categories.includes(categoryFilter));
    } else {
      visible = files.slice();
    }
    
    this.snapshot = {
      ...this.snapshot,
      files,
      visibleFiles: visible,
      selectedFileId: currentSelection,
      focusedFile: currentFocused,
      metadataSuggestionsVersion: this.snapshot.metadataSuggestionsVersion + 1
    };
    this.emitChange();
    return updated;
  }

  /**
   * Updates the custom name for a file without moving it.
   */
  public async updateCustomName(fileId: number, customName: string | null): Promise<AudioFileSummary> {
    const updated = await window.api.updateCustomName(fileId, customName);
    this.applyFilePatch(updated);
    return updated;
  }

  /**
   * Updates metadata (author, rating) for a file without organizing it.
   */
  public async updateFileMetadata(fileId: number, metadata: { author?: string | null; rating?: number }): Promise<void> {
    await window.api.updateFileMetadata(fileId, metadata);
    
    // Refresh the file list to get updated metadata
    const files = await window.api.listAudioFiles();
    const { categoryFilter } = this.snapshot;
    let visible: AudioFileSummary[];
    if (categoryFilter === CATEGORY_FILTER_UNTAGGED) {
      visible = files.filter((file) => file.categories.length === 0);
    } else if (categoryFilter) {
      visible = files.filter((file) => file.categories.includes(categoryFilter));
    } else {
      visible = files.slice();
    }
    
    this.snapshot = {
      ...this.snapshot,
      files,
      visibleFiles: visible,
      metadataSuggestionsVersion: this.snapshot.metadataSuggestionsVersion + 1
    };
    this.emitChange();
  }

  /**
   * Splits a file into multiple segments and refreshes the library snapshot.
   */
  public async splitFile(fileId: number, segments: SplitSegmentRequest[]): Promise<AudioFileSummary[]> {
    const created = await window.api.splitFile(fileId, segments);
    const files = await window.api.listAudioFiles();
    const { categoryFilter } = this.snapshot;
    let visible: AudioFileSummary[];
    if (categoryFilter === CATEGORY_FILTER_UNTAGGED) {
      visible = files.filter((file) => file.categories.length === 0);
    } else if (categoryFilter) {
      visible = files.filter((file) => file.categories.includes(categoryFilter));
    } else {
      visible = files.slice();
    }

    this.snapshot = {
      ...this.snapshot,
      files,
      visibleFiles: visible,
      metadataSuggestionsVersion: this.snapshot.metadataSuggestionsVersion + 1
    };
    this.emitChange();
    return created;
  }

  /**
   * Assigns a new library path and refreshes the cached settings + file list.
   */
  public async setLibraryPath(targetPath: string): Promise<void> {
    const settings = await window.api.setLibraryPath(targetPath);
    const files = await window.api.listAudioFiles();
    this.snapshot = {
      ...this.snapshot,
      settings,
      files,
      selectedFileId: files.at(0)?.id ?? null,
      categoryFilter: null,
      focusedFile: this.snapshot.focusedFile,
      metadataSuggestionsVersion: this.snapshot.metadataSuggestionsVersion + 1
    };
    this.refreshVisibleFiles(this.snapshot.selectedFileId ?? null);
  }

  /**
   * Returns the currently selected file object.
   */
  public getSelectedFile(): AudioFileSummary | null {
    if (!this.snapshot.selectedFileId) {
      return null;
    }
    return this.snapshot.files.find((file) => file.id === this.snapshot.selectedFileId) ?? null;
  }

  /**
   * Convenience for retrieving the current settings.
   */
  public getSettings(): AppSettings {
    return this.snapshot.settings;
  }

  /**
   * Emits a change event for subscribers.
   */
  private emitChange(): void {
    this.dispatchEvent(new Event('change'));
  }

  private refreshVisibleFiles(preferredId?: number | null, emit = true): void {
    const { files, categoryFilter } = this.snapshot;
    let visible: AudioFileSummary[];
    if (categoryFilter === CATEGORY_FILTER_UNTAGGED) {
      visible = files.filter((file) => file.categories.length === 0);
    } else if (categoryFilter) {
      visible = files.filter((file) => file.categories.includes(categoryFilter));
    } else {
      visible = files.slice();
    }

    const desiredId = preferredId !== undefined ? preferredId : this.snapshot.selectedFileId;
    const enforceVisible = preferredId !== undefined;
    const nextSelected = this.resolveSelectedId(visible, desiredId, enforceVisible);

    const nextSelectionSet = new Set<number>();
    if (enforceVisible) {
      const visibleIds = new Set(visible.map((file) => file.id));
      for (const id of this.snapshot.selectedFileIds) {
        if (visibleIds.has(id)) {
          nextSelectionSet.add(id);
        }
      }
    } else {
      for (const id of this.snapshot.selectedFileIds) {
        nextSelectionSet.add(id);
      }
    }
    if (nextSelected !== null) {
      nextSelectionSet.add(nextSelected);
    }
    const previousFocused = this.snapshot.focusedFile;
    const nextFocused = nextSelected !== null
      ? this.snapshot.files.find((file) => file.id === nextSelected) ?? (previousFocused?.id === nextSelected ? previousFocused : null)
      : null;
    this.snapshot = {
      ...this.snapshot,
      visibleFiles: visible,
      selectedFileId: nextSelected,
      selectedFileIds: nextSelectionSet,
      focusedFile: nextFocused
    };

    if (emit) {
      this.emitChange();
    }
  }

  private resolveSelectedId(visible: AudioFileSummary[], desiredId: number | null, enforceVisible: boolean): number | null {
    if (desiredId !== null) {
      if (!enforceVisible) {
        return desiredId;
      }
      if (visible.some((file) => file.id === desiredId)) {
        return desiredId;
      }
    }
    if (enforceVisible) {
      return visible.at(0)?.id ?? null;
    }
    return desiredId;
  }

  /**
   * Replaces a single file entry within the cached collection.
   */
  private applyFilePatch(updated: AudioFileSummary): void {
    const nextFiles = this.snapshot.files.slice();
    const index = nextFiles.findIndex((file) => file.id === updated.id);
    const previous = index >= 0 ? nextFiles[index] : null;
    if (index >= 0) {
      nextFiles[index] = updated;
    } else {
      nextFiles.push(updated);
    }
    const shouldBumpSuggestions = previous !== null && (previous.fileName !== updated.fileName || previous.relativePath !== updated.relativePath);
    
    const { categoryFilter, selectedFileId, focusedFile } = this.snapshot;
    let visible: AudioFileSummary[];
    if (categoryFilter === CATEGORY_FILTER_UNTAGGED) {
      visible = nextFiles.filter((file) => file.categories.length === 0);
    } else if (categoryFilter) {
      visible = nextFiles.filter((file) => file.categories.includes(categoryFilter));
    } else {
      visible = nextFiles.slice();
    }
    
    this.snapshot = {
      ...this.snapshot,
      files: nextFiles,
      visibleFiles: visible,
      selectedFileId,
      focusedFile,
      metadataSuggestionsVersion: shouldBumpSuggestions
        ? this.snapshot.metadataSuggestionsVersion + 1
        : this.snapshot.metadataSuggestionsVersion
    };
    this.emitChange();
  }
}

export const libraryStore = new LibraryStore();
