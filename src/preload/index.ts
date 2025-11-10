import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type RendererApi } from '../shared/ipc';
import type {
  AppSettings,
  AudioBufferPayload,
  AudioFileSummary,
  CategoryRecord,
  LibraryScanSummary,
  SplitSegmentRequest,
  TagUpdatePayload
} from '../shared/models';

/**
 * Preload bridge exposing a curated API surface to the renderer process.
 */
const api: RendererApi = {
  async getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke(IPC_CHANNELS.settingsGet);
  },
  async selectLibraryDirectory(): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.dialogSelectLibrary);
  },
  async setLibraryPath(path: string): Promise<AppSettings> {
    return ipcRenderer.invoke(IPC_CHANNELS.settingsSetLibrary, path);
  },
  async rescanLibrary(): Promise<LibraryScanSummary> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryScan);
  },
  async listAudioFiles(): Promise<AudioFileSummary[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryList);
  },
  async listDuplicates(): Promise<{ checksum: string; files: AudioFileSummary[] }[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryDuplicates);
  },
  async renameFile(fileId: number, newFileName: string): Promise<AudioFileSummary> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryRename, fileId, newFileName);
  },
  async moveFile(fileId: number, targetRelativeDirectory: string): Promise<AudioFileSummary> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryMove, fileId, targetRelativeDirectory);
  },
  async organizeFile(
    fileId: number,
    metadata: { customName?: string | null; author?: string | null; copyright?: string | null; rating?: number }
  ): Promise<AudioFileSummary> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryOrganize, fileId, metadata);
  },
  async updateCustomName(fileId: number, customName: string | null): Promise<AudioFileSummary> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryCustomName, fileId, customName);
  },
  async openFileFolder(fileId: number): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryOpenFolder, fileId);
  },
  async deleteFiles(fileIds: number[]): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryDelete, fileIds);
  },
  async splitFile(fileId: number, segments: SplitSegmentRequest[]): Promise<AudioFileSummary[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.librarySplit, fileId, segments);
  },
  async getAudioBuffer(fileId: number): Promise<AudioBufferPayload> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryBuffer, fileId);
  },
  async getWaveformPreview(fileId: number, pointCount = 160): Promise<{ samples: number[]; rms: number }> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryWaveformPreview, fileId, pointCount);
  },
  async updateTagging(payload: TagUpdatePayload): Promise<AudioFileSummary> {
    return ipcRenderer.invoke(IPC_CHANNELS.tagsUpdate, payload);
  },
  async listCategories(): Promise<CategoryRecord[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.categoriesList);
  },
  async search(query: string): Promise<AudioFileSummary[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.searchQuery, query);
  },
  async readFileMetadata(fileId: number): Promise<{ author?: string; copyright?: string; title?: string; rating?: number }> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryMetadata, fileId);
  },
  async listMetadataSuggestions(): Promise<{ authors: string[]; copyrights: string[] }> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryMetadataSuggestions);
  },
  async updateFileMetadata(
    fileId: number,
    metadata: { author?: string | null; copyright?: string | null; rating?: number }
  ): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.libraryUpdateMetadata, fileId, metadata);
  },
  onMenuAction(channel: string, callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
};

contextBridge.exposeInMainWorld('api', api);
