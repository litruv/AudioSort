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
  /** Identifier of the source file this entry originated from, if any. */
  parentFileId: number | null;
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

/** Enumerates reasons why an import candidate might be skipped. */
export type ImportSkipReason = 'duplicate' | 'checksum' | 'unsupported' | 'inside-library';

/** Describes a source entry that was skipped during an import run. */
export interface ImportSkipEntry {
  /** Absolute path of the skipped file. */
  path: string;
  /** Reason the file did not qualify for import. */
  reason: ImportSkipReason;
}

/** Records a failure encountered while processing an import candidate. */
export interface ImportFailureEntry {
  /** Absolute path of the problematic file or directory. */
  path: string;
  /** Human-readable message explaining the failure. */
  message: string;
}

/** Summary returned after importing external audio sources. */
export interface LibraryImportResult {
  /** Files successfully copied into the library. */
  imported: AudioFileSummary[];
  /** Candidates that were skipped with a known reason. */
  skipped: ImportSkipEntry[];
  /** Candidates that failed due to unexpected errors. */
  failed: ImportFailureEntry[];
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
  /** Optional free-form tag collection. When omitted, existing tags are preserved. */
  tags?: string[];
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

/**
 * Optional metadata overrides applied while creating split segments.
 */
export interface SegmentMetadataInput {
  /** Overrides the custom name embedded into the segment (null clears it). */
  customName?: string | null;
  /** Overrides the author/creator metadata. */
  author?: string | null;
  /** Overrides the rating metadata (1-5). */
  rating?: number;
  /** Overrides the applied free-form tags. */
  tags?: string[];
  /** Overrides the applied UCS categories. */
  categories?: string[];
}

/**
 * Describes a region that should be extracted as a new audio segment.
 */
export interface SplitSegmentRequest {
  /** Inclusive start offset in milliseconds. */
  startMs: number;
  /** Exclusive end offset in milliseconds. */
  endMs: number;
  /** Optional display label used for segment naming. */
  label?: string;
  /** Metadata overrides to apply to the generated file. */
  metadata?: SegmentMetadataInput;
  /** Fade in duration in milliseconds. */
  fadeInMs?: number;
  /** Fade out duration in milliseconds. */
  fadeOutMs?: number;
}
