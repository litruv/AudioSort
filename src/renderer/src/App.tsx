import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import FileList from './components/FileList';
import FileDetailPanel from './components/FileDetailPanel';
import MultiFileEditor from './components/MultiFileEditor';
import CategorySidebar from './components/CategorySidebar';
import AudioPlayer from './components/AudioPlayer';
import SettingsDialog from './components/SettingsDialog';
import DuplicateComparisonDialog from './components/DuplicateComparisonDialog';
import EditModePanel from './components/edit/EditModePanel';
import { useLibrarySnapshot } from './hooks/useLibrarySnapshot';
import { loadPlayerFile, usePlayerSnapshot } from './hooks/usePlayerSnapshot';
import { libraryStore, type CategoryFilterValue } from './stores/LibraryStore';
import type { AudioFileSummary, LibraryImportResult } from '../../shared/models';

type RightPanelTab = 'listen' | 'edit';

/**
 * Root renderer component orchestrating layout and interactions.
 */
function App(): JSX.Element {
  const library = useLibrarySnapshot();
  const player = usePlayerSnapshot();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<{ checksum: string; files: AudioFileSummary[] }[] | null>(null);
  const [showStatusMessage, setShowStatusMessage] = useState(false);
  const [statusFadingOut, setStatusFadingOut] = useState(false);
  const [activeTab, setActiveTab] = useState<RightPanelTab>('listen');
  const [importMessage, setImportMessage] = useState<string | null>(null);
  
  const statusMessage = useMemo(() => {
    if (importMessage) {
      return importMessage;
    }
    if (!library.lastScan) {
      return null;
    }
    const { added, updated, removed } = library.lastScan;
    return `Scan complete: +${added} updated ${updated} removed ${removed}`;
  }, [importMessage, library.lastScan]);

  useEffect(() => {
    if (statusMessage) {
      setShowStatusMessage(true);
      setStatusFadingOut(false);
      const fadeTimer = setTimeout(() => {
        setStatusFadingOut(true);
      }, 4500);
      const hideTimer = setTimeout(() => {
        setShowStatusMessage(false);
        setStatusFadingOut(false);
        setImportMessage((current) => (current === statusMessage ? null : current));
      }, 5000);
      return () => {
        clearTimeout(fadeTimer);
        clearTimeout(hideTimer);
      };
    }
  }, [statusMessage]);

  const selectedFile = useMemo(
    () => library.files.find((file) => file.id === library.selectedFileId) ?? null,
    [library.files, library.selectedFileId]
  );

  const parentFileFromStore = useMemo(() => {
    const parentId = selectedFile?.parentFileId ?? null;
    if (parentId === null) {
      return null;
    }
    return library.files.find((file) => file.id === parentId) ?? null;
  }, [library.files, selectedFile?.parentFileId]);

  const [resolvedParentFile, setResolvedParentFile] = useState<AudioFileSummary | null>(parentFileFromStore);

  useEffect(() => {
    const parentId = selectedFile?.parentFileId ?? null;
    if (parentId === null) {
      setResolvedParentFile(null);
      return;
    }
    if (parentFileFromStore) {
      setResolvedParentFile(parentFileFromStore);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const fetched = await window.api.getAudioFileById(parentId);
        if (!cancelled) {
          setResolvedParentFile(fetched ?? null);
        }
      } catch (error) {
        console.warn('Unable to resolve parent file details', { parentId, error });
        if (!cancelled) {
          setResolvedParentFile(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [parentFileFromStore, selectedFile?.parentFileId]);

  const selectedFiles = useMemo(
    () => library.files.filter((file) => library.selectedFileIds.has(file.id)),
    [library.files, library.selectedFileIds]
  );

  const isMultiSelect = selectedFiles.length > 1;

  useEffect(() => {
    if (!isMultiSelect) {
      loadPlayerFile(selectedFile, false);
    }
  }, [selectedFile?.id, isMultiSelect]);

  useEffect(() => {
    const handleArrowNavigation = (event: KeyboardEvent) => {
      if (event.code !== 'ArrowUp' && event.code !== 'ArrowDown') {
        return;
      }
      if (event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target) {
        const tagName = target.tagName;
        const isEditable = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target.isContentEditable;
        if (isEditable) {
          return;
        }
      }

      event.preventDefault();
      libraryStore.selectAdjacent(event.code === 'ArrowUp' ? -1 : 1);
    };

    window.addEventListener('keydown', handleArrowNavigation);
    return () => {
      window.removeEventListener('keydown', handleArrowNavigation);
    };
  }, []);

  const handleSearch = (value: string) => {
    void libraryStore.search(value);
  };

  const handleRescan = useCallback(async () => {
    await libraryStore.rescan();
  }, []);

  const handleFindDuplicates = useCallback(async () => {
    const duplicates = await window.api.listDuplicates();
    setDuplicateGroups(duplicates);
  }, []);

  const summariseImportResult = useCallback((result: LibraryImportResult): string => {
    const parts: string[] = [`${result.imported.length} added`];
    if (result.skipped.length > 0) {
      parts.push(`${result.skipped.length} skipped`);
    }
    if (result.failed.length > 0) {
      parts.push(`${result.failed.length} failed`);
    }
    return `Import complete: ${parts.join(', ')}`;
  }, []);

  const notifyImportSuccess = useCallback((result: LibraryImportResult) => {
    setImportMessage(summariseImportResult(result));
  }, [summariseImportResult]);

  const notifyImportFailure = useCallback(() => {
    setImportMessage('Import failed. Check logs for details.');
  }, []);

  const handleImportFromFolder = useCallback(async () => {
    try {
      const result = await libraryStore.importFromFolder();
      if (!result) {
        return;
      }
      notifyImportSuccess(result);
    } catch (error) {
      console.error('Import failed', error);
      notifyImportFailure();
    }
  }, [notifyImportFailure, notifyImportSuccess]);

  const handleImportFromDrive = useCallback(async (drive: string) => {
    try {
      const result = await libraryStore.importFromDrive(drive);
      notifyImportSuccess(result);
    } catch (error) {
      console.error('Import failed', error);
      notifyImportFailure();
    }
  }, [notifyImportFailure, notifyImportSuccess]);

  useEffect(() => {
    const cleanup1 = window.api.onMenuAction('open-settings', () => setSettingsOpen(true));
    const cleanup2 = window.api.onMenuAction('rescan-library', () => {
      void handleRescan();
    });
    const cleanup3 = window.api.onMenuAction('find-duplicates', () => {
      void handleFindDuplicates();
    });
    const cleanup4 = window.api.onMenuAction('import-from-folder', () => {
      void handleImportFromFolder();
    });
    const cleanup5 = window.api.onMenuAction('import-from-drive', (drive) => {
      if (typeof drive === 'string') {
        void handleImportFromDrive(drive);
      }
    });

    return () => {
      cleanup1();
      cleanup2();
      cleanup3();
      cleanup4();
      cleanup5();
    };
  }, [handleFindDuplicates, handleImportFromFolder, handleImportFromDrive, handleRescan]);

  const handleKeepDuplicate = async (fileIdToKeep: number, fileIdsToDelete: number[]) => {
    await window.api.deleteFiles(fileIdsToDelete);
    await libraryStore.bootstrap();
  };

  const handleCloseDuplicates = () => {
    setDuplicateGroups(null);
  };

  const handleSelectFile = (fileId: number, options?: { multi?: boolean; range?: boolean }) => {
    libraryStore.selectFile(fileId, options);
  };

  const handlePlayFile = (file: AudioFileSummary) => {
    loadPlayerFile(file, true);
  };

  const handleCategorySelect = (filter: CategoryFilterValue) => {
    libraryStore.setCategoryFilter(filter);
  };

  const handleRename = async (newName: string) => {
    if (!selectedFile) {
      return;
    }
    await libraryStore.renameFile(selectedFile.id, newName);
  };

  const handleMove = async (targetDirectory: string) => {
    if (!selectedFile) {
      return;
    }
    await libraryStore.moveFile(selectedFile.id, targetDirectory);
  };

  const handleOrganize = async (metadata: { customName?: string; author?: string; copyright?: string; rating?: number }) => {
    if (!selectedFile) {
      return;
    }
    await libraryStore.organizeFile(selectedFile.id, metadata);
    
    // Scroll the file into view after organizing (filename may have changed)
    setTimeout(() => {
      const element = document.querySelector(`[data-file-id="${selectedFile.id}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 5000);
  };

  const handleUpdateCustomName = async (customName: string | null) => {
    if (!selectedFile) {
      return;
    }
    await libraryStore.updateCustomName(selectedFile.id, customName);
  };

  const handleTagUpdate = async (categories: string[]) => {
    if (!selectedFile) {
      return;
    }
    await libraryStore.updateTagging({ fileId: selectedFile.id, categories });
  };

  const handleOpenParent = (parentId: number) => {
    void libraryStore.focusOnFile(parentId);
    setActiveTab('listen');
  };

  const handleMultiFileTagUpdate = async (fileId: number, categories: string[]) => {
    await libraryStore.updateTagging({ fileId, categories });
  };

  const handleMultiFileCustomName = async (fileId: number, customName: string | null) => {
    await libraryStore.updateCustomName(fileId, customName);
  };

  const handleMultiFileOrganize = async (fileId: number, metadata: { customName?: string; author?: string; copyright?: string; rating?: number }) => {
    await libraryStore.organizeFile(fileId, metadata);
  };

  const handleMultiFileUpdateMetadata = async (fileId: number, metadata: { author?: string; copyright?: string; rating?: number }) => {
    await libraryStore.updateFileMetadata(fileId, metadata);
  };

  const handleDropFilesToCategory = async (fileIds: number[], categoryId: string) => {
    for (const fileId of fileIds) {
      const file = library.files.find((f) => f.id === fileId);
      if (!file) continue;
      
      const existingCategories = file.categories;
      if (existingCategories.includes(categoryId)) continue;
      
      const newCategories = [...existingCategories, categoryId];
      await libraryStore.updateTagging({
        fileId,
        categories: newCategories
      });
    }
  };

  const handleLibraryPath = async (path: string) => {
    await libraryStore.setLibraryPath(path);
    setSettingsOpen(false);
  };

  const handleEditModeClose = () => {
    setActiveTab('listen');
  };

  const handleEditModeSplitComplete = (created: AudioFileSummary[]) => {
    setActiveTab('listen');
    if (created.length > 0) {
      libraryStore.selectFile(created[0].id);
    }
  };

  return (
    <div className="app-root">
      {showStatusMessage && statusMessage && (
        <div className={`status-banner ${statusFadingOut ? 'fade-out' : ''}`}>
          {statusMessage}
        </div>
      )}
      <main className="app-body">
        <CategorySidebar
          categories={library.categories}
          files={library.files}
          activeFilter={library.categoryFilter}
          justSplitIds={library.justSplitFileIds}
          onSelect={handleCategorySelect}
          onDropFiles={handleDropFilesToCategory}
        />
        <FileList 
          files={library.visibleFiles} 
          selectedId={library.selectedFileId}
          selectedIds={library.selectedFileIds}
          onSelect={handleSelectFile}
          onPlay={handlePlayFile}
          searchValue={library.searchQuery}
          onSearchChange={handleSearch}
        />
        <div className="app-details">
          {isMultiSelect ? (
            <MultiFileEditor
              files={selectedFiles}
              categories={library.categories}
              onUpdateTags={handleMultiFileTagUpdate}
              onUpdateCustomName={handleMultiFileCustomName}
              onOrganize={handleMultiFileOrganize}
              onUpdateMetadata={handleMultiFileUpdateMetadata}
              metadataSuggestionsVersion={library.metadataSuggestionsVersion}
            />
          ) : (
            <>
              <div className="detail-tabs">
                <button
                  type="button"
                  className={activeTab === 'listen' ? 'detail-tab detail-tab--active' : 'detail-tab'}
                  onClick={() => setActiveTab('listen')}
                >
                  Listen
                </button>
                <button
                  type="button"
                  className={activeTab === 'edit' ? 'detail-tab detail-tab--active' : 'detail-tab'}
                  onClick={() => setActiveTab('edit')}
                  disabled={!selectedFile}
                >
                  Edit
                </button>
              </div>
              {activeTab === 'listen' ? (
                <>
                  <FileDetailPanel
                    file={selectedFile}
                    parentFile={resolvedParentFile}
                    categories={library.categories}
                    onRename={handleRename}
                    onMove={handleMove}
                    onOrganize={handleOrganize}
                    onUpdateTags={handleTagUpdate}
                    onUpdateCustomName={handleUpdateCustomName}
                    onOpenParent={handleOpenParent}
                    metadataSuggestionsVersion={library.metadataSuggestionsVersion}
                  />
                  <AudioPlayer snapshot={player} />
                </>
              ) : selectedFile ? (
                <EditModePanel
                  file={selectedFile}
                  categories={library.categories}
                  onClose={handleEditModeClose}
                  onSplitComplete={handleEditModeSplitComplete}
                />
              ) : null}
            </>
          )}
        </div>
      </main>
      <SettingsDialog
        open={settingsOpen}
        currentPath={library.settings.libraryPath}
        onClose={() => setSettingsOpen(false)}
        onSelectDirectory={handleLibraryPath}
      />
      {duplicateGroups && (
        <DuplicateComparisonDialog
          duplicateGroups={duplicateGroups}
          onKeepFile={handleKeepDuplicate}
          onClose={handleCloseDuplicates}
        />
      )}
    </div>
  );
}

export default App;
