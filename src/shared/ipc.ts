/** Enumerates IPC channels shared between renderer and main. */
export const IPC_CHANNELS = {
  settingsGet: 'settings:get',
  settingsSetLibrary: 'settings:set-library',
  dialogSelectLibrary: 'dialog:select-library',
  libraryScan: 'library:scan',
  libraryList: 'library:list',
  libraryDuplicates: 'library:duplicates',
  libraryRename: 'library:rename',
  libraryMove: 'library:move',
  libraryOrganize: 'library:organize',
  libraryCustomName: 'library:custom-name',
  libraryOpenFolder: 'library:open-folder',
  libraryDelete: 'library:delete',
  libraryBuffer: 'library:buffer',
  libraryMetadata: 'library:metadata',
  libraryMetadataSuggestions: 'library:metadata-suggestions',
  libraryUpdateMetadata: 'library:update-metadata',
  libraryWaveformPreview: 'library:waveform-preview',
  tagsUpdate: 'tags:update',
  categoriesList: 'categories:list',
  searchQuery: 'search:query'
} as const;

export type IpcChannelKeys = keyof typeof IPC_CHANNELS;

/**
 * API surface exposed to the renderer through the preload script.
 */
export interface RendererApi {
  /** Retrieves the persisted settings object. */
  getSettings(): Promise<import('./models').AppSettings>;
  /** Opens a dialog to select a new library path, returning the chosen directory or null. */
  selectLibraryDirectory(): Promise<string | null>;
  /** Persists the given library path. */
  setLibraryPath(path: string): Promise<import('./models').AppSettings>;
  /** Triggers a manual rescan of the library. */
  rescanLibrary(): Promise<import('./models').LibraryScanSummary>;
  /** Fetches the current list of audio files. */
  listAudioFiles(): Promise<import('./models').AudioFileSummary[]>;
  /** Fetches groups of duplicate files based on checksum. */
  listDuplicates(): Promise<{ checksum: string; files: import('./models').AudioFileSummary[] }[]>;
  /** Requests a rename for the target file. */
  renameFile(fileId: number, newFileName: string): Promise<import('./models').AudioFileSummary>;
  /** Moves a file to another subdirectory under the library root. */
  moveFile(fileId: number, targetRelativeDirectory: string): Promise<import('./models').AudioFileSummary>;
  /** Automatically organizes a file based on its categories. */
  organizeFile(fileId: number, metadata: { customName?: string; author?: string; copyright?: string; rating?: number }): Promise<import('./models').AudioFileSummary>;
  /** Updates the custom name for a file. */
  updateCustomName(fileId: number, customName: string | null): Promise<import('./models').AudioFileSummary>;
  /** Opens the file's containing folder in the system file explorer. */
  openFileFolder(fileId: number): Promise<void>;
  /** Deletes files from disk and database. */
  deleteFiles(fileIds: number[]): Promise<void>;
  /** Fetches the binary data required for playback. */
  getAudioBuffer(fileId: number): Promise<import('./models').AudioBufferPayload>;
  /** Returns a lightweight waveform preview for rendering list backgrounds. */
  getWaveformPreview(fileId: number, pointCount?: number): Promise<{ samples: number[]; rms: number }>;
  /** Updates free-form tags and UCS categories. */
  updateTagging(payload: import('./models').TagUpdatePayload): Promise<import('./models').AudioFileSummary>;
  /** Returns the catalog of UCS categories. */
  listCategories(): Promise<import('./models').CategoryRecord[]>;
  /** Runs fuzzy search returning ranked results. */
  search(query: string): Promise<import('./models').AudioFileSummary[]>;
  /** Reads embedded metadata from a WAV file. */
  readFileMetadata(fileId: number): Promise<{ author?: string; copyright?: string; title?: string; rating?: number }>;
  /** Lists distinct metadata values gathered from the library for quick suggestions. */
  listMetadataSuggestions(): Promise<{ authors: string[]; copyrights: string[] }>;
  /** Updates metadata (author, copyright, rating) without organizing the file. */
  updateFileMetadata(fileId: number, metadata: { author?: string; copyright?: string; rating?: number }): Promise<void>;
  /** Listens for menu actions from the main process. Returns a cleanup function. */
  onMenuAction(channel: string, callback: () => void): () => void;
}

declare global {
  interface Window {
    /** Bridge API injected by the preload script. */
    api: RendererApi;
  }
}
