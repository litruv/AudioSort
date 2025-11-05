/**
 * Represents a summarized view of an audio file for list displays and searches.
 */
export interface AudioFileSummary {
  /** Unique identifier inside the database. */
  id: number;
  /** Filename with extension. */
  fileName: string;
  /** User-friendly display name (no extension). */
  displayName: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Path relative to the configured library root. */
  relativePath: string;
  /** Last modified timestamp (epoch milliseconds). */
  modifiedAt: number;
  /** File creation timestamp (epoch milliseconds) if available. */
  createdAt: number | null;
  /** File size in bytes. */
  size: number;
  /** Duration in milliseconds if known. */
  durationMs: number | null;
  /** Sample rate in Hz if known. */
  sampleRate: number | null;
  /** Bit depth if known. */
  bitDepth: number | null;
  /** Content checksum used for duplicate detection. */
  checksum: string | null;
  /** Applied descriptive tags. */
  tags: string[];
  /** Associated UCS categories. */
  categories: string[];
  /** Custom name for file organization. */
  customName: string | null;
}

/**
 * Represents a group of files that share the same checksum.
 */
export interface DuplicateGroup {
  /** MD5 checksum shared by all files in the group. */
  checksum: string;
  /** Files that have identical content. */
  files: AudioFileSummary[];
}

/**
 * Structure describing a UCS category.
 */
export interface CategoryRecord {
  /** Category identifier (CatID from UCS). */
  id: string;
  /** High level category name. */
  category: string;
  /** Sub-category label. */
  subCategory: string;
  /** Short hand for the category. */
  shortCode: string;
  /** Human readable explanation. */
  explanation: string;
  /** List of synonym keywords. */
  synonyms: string[];
}

/**
 * Summary report for a library scan run.
 */
export interface LibraryScanSummary {
  /** Number of newly discovered files. */
  added: number;
  /** Number of existing records refreshed. */
  updated: number;
  /** Number of database records removed because the files disappeared. */
  removed: number;
  /** Total records after the scan. */
  total: number;
}

/**
 * Shape of persisted application settings.
 */
export interface AppSettings {
  /** Current library root path. */
  libraryPath: string | null;
}

/**
 * Payload for tag updates flowing from the renderer to the main process.
 */
export interface TagUpdatePayload {
  /** Target audio file id. */
  fileId: number;
  /** Free-form tag collection. */
  tags: string[];
  /** UCS category identifiers to attach. */
  categories: string[];
}

/**
 * Response for playback requests containing file binary data.
 */
export interface AudioBufferPayload {
  /** Original file id to trace usage. */
  fileId: number;
  /** Raw audio data. */
  buffer: ArrayBuffer;
  /** MIME type for the audio data. */
  mimeType: string;
}
