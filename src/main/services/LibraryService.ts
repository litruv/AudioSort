import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fg from 'fast-glob';
import { parse } from 'csv-parse/sync';
import { AppSettings, AudioBufferPayload, AudioFileSummary, CategoryRecord, LibraryScanSummary, TagUpdatePayload } from '../../shared/models';
import { DatabaseService, FileRecordInput } from './DatabaseService';
import { SettingsService } from './SettingsService';
import { TagService } from './TagService';
import { SearchService } from './SearchService';
import { WaveFile } from 'wavefile';
import { OrganizationService } from './OrganizationService';

interface CsvCategoryRow {
  Category: string;
  SubCategory: string;
  CatID: string;
  CatShort: string;
  Explanations: string;
  'Synonyms - Comma Separated': string;
}

/**
 * Coordinates library scanning, categorisation, and file-level operations.
 */
export class LibraryService {
  private categoriesLoaded = false;
  private readonly metadataFailures = new Set<string>();
  private readonly checksumFailures = new Set<string>();
  private readonly organization: OrganizationService;
  private metadataSuggestionCache: { authors: Set<string>; copyrights: Set<string> } | null = null;
  private readonly waveformPreviewCache = new Map<number, { modifiedAt: number; pointCount: number; samples: number[]; rms: number }>();

  public constructor(
    private readonly database: DatabaseService,
    private readonly settings: SettingsService,
    private readonly tagService: TagService,
    private readonly search: SearchService
  ) {
    this.organization = new OrganizationService(database);
  }

  /**
   * Parses the UCS CSV catalog and stores the categories in the database once per session.
   */
  public async ensureCategoriesLoaded(csvAbsolutePath: string): Promise<void> {
    if (this.categoriesLoaded) {
      return;
    }
    const fileContent = await fs.readFile(csvAbsolutePath, 'utf-8');
      const rows = parse(fileContent, {
        columns: true,
        skip_empty_lines: true
      }) as CsvCategoryRow[];
    for (const row of rows) {
      const category: CategoryRecord = {
        id: row.CatID,
        category: row.Category,
        subCategory: row.SubCategory,
        shortCode: row.CatShort,
        explanation: row.Explanations,
        synonyms: row['Synonyms - Comma Separated']
          .split(',')
          .map((value: string) => value.trim())
          .filter((value: string) => value.length > 0)
      };
      this.database.upsertCategory(category);
    }
    this.categoriesLoaded = true;
  }

  /**
   * Returns the current settings snapshot (used to expose default paths to the renderer).
   */
  public getSettings(): AppSettings {
    return this.settings.getSettings();
  }

  /**
   * Triggers a library rescan and refreshes the search index.
   */
  public async scanLibrary(): Promise<LibraryScanSummary> {
    this.resetMetadataSuggestionsCache();
    this.waveformPreviewCache.clear();
    
    const cleanedTempFiles = await this.cleanupTempFiles();
    const libraryRoot = this.settings.ensureLibraryPath();
    const existing = this.database.listFiles();
    const existingByPath = new Map(existing.map((file) => [file.absolutePath, file] as const));
    const existingByChecksum = new Map(existing.filter((file) => file.checksum).map((file) => [file.checksum!, file] as const));

    const pattern = ['**/*.wav', '**/*.wave'];
    const absolutePaths = await fg(pattern, {
      cwd: libraryRoot,
      absolute: true,
      onlyFiles: true,
      suppressErrors: true,
      caseSensitiveMatch: false
    });

    let added = 0;
    let updated = 0;
    const seen = new Set<string>();

    for (const absolutePath of absolutePaths) {
      const stats = await fs.stat(absolutePath);
      const relativePath = path.relative(libraryRoot, absolutePath);
      const fileName = path.basename(absolutePath);
      const displayName = path.basename(fileName, path.extname(fileName));
      const metadata = await this.extractAudioMetadata(absolutePath);
      const createdAt = Number.isNaN(stats.birthtimeMs) ? null : stats.birthtimeMs;
      const checksum = await this.computeFileChecksum(absolutePath);
      
      const knownByPath = existingByPath.get(absolutePath);
      const knownByChecksum = checksum ? existingByChecksum.get(checksum) : null;
      const knownFile = knownByPath ?? knownByChecksum ?? null;
      const wasKnown = knownFile !== null;
      
      // Read embedded WAV metadata (author, copyright, rating, title)
      const embeddedMetadata = this.tagService.readMetadata(absolutePath);
      
      const record: FileRecordInput = {
        absolutePath,
        relativePath,
        fileName,
        displayName,
        modifiedAt: stats.mtimeMs,
        createdAt,
        size: stats.size,
        durationMs: metadata.durationMs,
        sampleRate: metadata.sampleRate,
        bitDepth: metadata.bitDepth,
        checksum,
        tags: metadata.tags.length > 0 ? metadata.tags : (knownFile?.tags ?? []),
        categories: metadata.categories.length > 0 ? metadata.categories : (knownFile?.categories ?? [])
      };
      const upserted = this.database.upsertFile(record);
      
      // Update custom name from embedded title if present, otherwise keep existing
      const customName = embeddedMetadata.title?.trim() || knownFile?.customName || null;
      if (customName !== upserted.customName) {
        this.database.updateCustomName(upserted.id, customName);
      }
      
      if (wasKnown) {
        updated += 1;
      } else {
        added += 1;
      }
      seen.add(absolutePath);
    }

    const removed = this.database.removeFilesOutside(seen);
    this.search.rebuildIndex();
  this.resetMetadataSuggestionsCache();
    const total = this.database.listFiles().length;

    return {
      added,
      updated,
      removed,
      total
    };
  }

  /**
   * Provides the current list of library entries (already sorted by the database query).
   */
  public listFiles(): AudioFileSummary[] {
    return this.database.listFiles();
  }

  /**
   * Returns groups of files that have identical checksums (potential duplicates).
   */
  public listDuplicates(): { checksum: string; files: AudioFileSummary[] }[] {
    return this.database.listDuplicateGroups();
  }

  /**
   * Finds and cleans up orphaned .tmp files in the library directory.
   * Returns the number of files cleaned up.
   */
  public async cleanupTempFiles(): Promise<number> {
    const libraryRoot = this.settings.getSettings().libraryPath;
    if (!libraryRoot) {
      return 0;
    }

    const pattern = ['**/*.tmp'];
    const tempFiles = await fg(pattern, {
      cwd: libraryRoot,
      absolute: true,
      onlyFiles: true,
      suppressErrors: true
    });

    let cleanedCount = 0;

    for (const tempFile of tempFiles) {
      try {
        // Try to determine the intended final name by removing the temp suffix pattern
        const baseMatch = tempFile.match(/^(.+)\.\d+-\d+-[a-f0-9]+\.tmp$/);
        if (baseMatch) {
          const intendedPath = baseMatch[1];
          
          // Check if the intended destination exists
          try {
            await fs.access(intendedPath);
            await fs.unlink(tempFile);
            cleanedCount++;
          } catch {
            await fs.rename(tempFile, intendedPath);
            cleanedCount++;
          }
        } else {
          console.warn(`Found temp file with unknown pattern: ${tempFile}`);
        }
      } catch (error) {
        console.error(`Failed to clean up temp file ${tempFile}:`, error);
      }
    }

    return cleanedCount;
  }

  /**
   * Renames a file while keeping it in the current directory.
   */
  public async renameFile(fileId: number, requestedName: string): Promise<AudioFileSummary> {
    const record = this.database.getFileById(fileId);
    const libraryRoot = this.settings.ensureLibraryPath();
    const cleanName = this.normaliseFileName(requestedName);
    const targetDirectory = path.dirname(record.absolutePath);
    const targetPath = path.join(targetDirectory, cleanName);
    await fs.rename(record.absolutePath, targetPath);

    const updated = this.database.updateFileLocation(
      fileId,
      targetPath,
      path.relative(libraryRoot, targetPath),
      path.basename(targetPath),
      path.basename(targetPath, path.extname(targetPath))
    );
    this.waveformPreviewCache.delete(fileId);
    this.search.rebuildIndex();
    return updated;
  }

  /**
   * Moves a file to a different subdirectory under the library root.
   */
  public async moveFile(fileId: number, targetRelativeDirectory: string): Promise<AudioFileSummary> {
    const record = this.database.getFileById(fileId);
    const libraryRoot = this.settings.ensureLibraryPath();
    const normalisedTarget = path.resolve(libraryRoot, targetRelativeDirectory);
    this.assertWithinLibrary(libraryRoot, normalisedTarget);
    await fs.mkdir(normalisedTarget, { recursive: true });

    const targetPath = path.join(normalisedTarget, record.fileName);
    await fs.rename(record.absolutePath, targetPath);

    const updated = this.database.updateFileLocation(
      fileId,
      targetPath,
      path.relative(libraryRoot, targetPath),
      path.basename(targetPath),
      path.basename(targetPath, path.extname(targetPath))
    );
    this.waveformPreviewCache.delete(fileId);
    this.search.rebuildIndex();
    return updated;
  }

  /**
   * Provides the binary payload required for renderer playback.
   */
  public async getAudioBuffer(fileId: number): Promise<AudioBufferPayload> {
    const record = this.database.getFileById(fileId);
    const buffer = await fs.readFile(record.absolutePath);
    const payload: AudioBufferPayload = {
      fileId,
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      mimeType: 'audio/wav'
    };
    return payload;
  }

  /**
   * Generates a lightweight waveform preview suitable for list rendering.
   */
  public async getWaveformPreview(fileId: number, pointCount = 160): Promise<{ samples: number[]; rms: number }> {
    const record = this.database.getFileById(fileId);
    const effectivePoints = Math.min(Math.max(pointCount ?? 160, 32), 512);
    const cacheHit = this.waveformPreviewCache.get(fileId);
    if (cacheHit && cacheHit.modifiedAt === record.modifiedAt && cacheHit.pointCount === effectivePoints) {
      return { samples: cacheHit.samples, rms: cacheHit.rms };
    }

    try {
  const buffer = await fs.readFile(record.absolutePath);
  const wave = new WaveFile(buffer);
  const sampleBlock = wave.getSamples(false, Float64Array) as Float64Array | Float64Array[];
  const channels = Array.isArray(sampleBlock) ? sampleBlock : [sampleBlock];
      const firstChannel = channels[0];

      if (!firstChannel || firstChannel.length === 0) {
        const fallback = new Array(effectivePoints).fill(0);
        this.waveformPreviewCache.set(fileId, {
          modifiedAt: record.modifiedAt,
          pointCount: effectivePoints,
          samples: fallback,
          rms: 0
        });
        return { samples: fallback, rms: 0 };
      }

      const amplitudeScale = Math.max(1, this.resolveWaveformAmplitudeScale(wave));
      const blockSize = Math.max(1, Math.floor(firstChannel.length / effectivePoints));
      const peaks: number[] = [];
      let sumSquares = 0;
      let sampleTotal = 0;

      for (let index = 0; index < effectivePoints; index += 1) {
        const start = index * blockSize;
        const end = index === effectivePoints - 1 ? firstChannel.length : Math.min(firstChannel.length, start + blockSize);
        let blockPeak = 0;
        for (let cursor = start; cursor < end; cursor += 1) {
          for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
            const channel = channels[channelIndex];
            const rawSample = channel?.[cursor] ?? 0;
            const normalisedSample = rawSample / amplitudeScale;
            const clampedSample = Math.max(-1, Math.min(1, normalisedSample));
            const magnitude = Math.abs(clampedSample);
            if (magnitude > blockPeak) {
              blockPeak = magnitude;
            }
            sumSquares += clampedSample * clampedSample;
            sampleTotal += 1;
          }
        }
        peaks.push(Math.min(blockPeak, 1));
      }

      const samples = this.normaliseWaveformArray(peaks);
      const rms = sampleTotal > 0 ? Math.sqrt(sumSquares / sampleTotal) : 0;
      this.waveformPreviewCache.set(fileId, {
        modifiedAt: record.modifiedAt,
        pointCount: effectivePoints,
        samples,
        rms
      });

      return { samples, rms };
    } catch (error) {
      console.warn('Failed to generate waveform preview', { fileId, error });
      const fallback = new Array(effectivePoints).fill(0);
      this.waveformPreviewCache.set(fileId, {
        modifiedAt: record.modifiedAt,
        pointCount: effectivePoints,
        samples: fallback,
        rms: 0
      });
      return { samples: fallback, rms: 0 };
    }
  }

  /**
   * Applies tag updates, optionally re-running the organize pipeline when categories are present.
   */
  public async updateTagging(payload: TagUpdatePayload): Promise<AudioFileSummary> {
    const updated = this.tagService.applyTagging(payload.fileId, payload.tags, payload.categories);
    this.waveformPreviewCache.delete(payload.fileId);

    if (updated.categories.length > 0) {
      const metadataSnapshot = this.tagService.readMetadata(updated.absolutePath);
      return this.organizeFile(payload.fileId, {
        customName: updated.customName ?? undefined,
        author: metadataSnapshot.author?.trim() || undefined,
        copyright: metadataSnapshot.copyright?.trim() || undefined,
        rating: metadataSnapshot.rating ?? undefined
      });
    }

    this.resetMetadataSuggestionsCache();
    this.search.rebuildIndex();
    return updated;
  }

  /**
   * Updates the custom name for a file without organizing it.
   */
  public updateCustomName(fileId: number, customName: string | null): AudioFileSummary {
    const updated = this.database.updateCustomName(fileId, customName);
    this.search.rebuildIndex();
    return updated;
  }

  /**
   * Finds the next available sequence number by checking both database and filesystem.
   * This prevents race conditions when multiple files are being organized simultaneously.
   */
  private async findNextAvailableNumberWithFilesystemCheck(
    folderPath: string,
    baseName: string,
    targetDirectory: string
  ): Promise<number> {
    // Start with database conflicts
    let nextIndex = this.organization.findNextAvailableNumber(folderPath, baseName);
    
    // Keep checking filesystem until we find an available number
    const maxAttempts = 100; // Prevent infinite loops
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidateFileName = `${baseName}_${this.organization.formatSequenceNumber(nextIndex)}.wav`;
      const candidatePath = path.join(targetDirectory, candidateFileName);
      
      try {
        await fs.stat(candidatePath);
        // File exists, try next number
        nextIndex++;
      } catch {
        // File doesn't exist, this number is available
        return nextIndex;
      }
    }
    
    // Fallback if we somehow exhaust attempts
    return nextIndex;
  }

  /**
   * Automatically organizes a file based on its categories.
   * Moves to CATEGORY/SUBCATEGORY folder and renames to SHORT_NN.wav or SHORT_customname.wav
   */
  public async organizeFile(
    fileId: number,
    metadata: { customName?: string | null; author?: string | null; copyright?: string | null; rating?: number }
  ): Promise<AudioFileSummary> {
    const record = this.database.getFileById(fileId);
    const category = this.organization.getPrimaryCategory(record);
    if (!category) {
      throw new Error('Cannot organize file without category assignment');
    }

    const libraryRoot = this.settings.ensureLibraryPath();
    const folderPath = this.organization.buildFolderPath(category);
  const requestedCustomName = this.normaliseMetadataInput(metadata.customName);
  const existingCustomName = record.customName ?? undefined;
  const effectiveCustomName = requestedCustomName !== undefined ? (requestedCustomName ?? undefined) : existingCustomName;
    const baseName = this.organization.buildBaseName(category, effectiveCustomName);
    const conflicts = this.organization
      .listConflictingFiles(folderPath, baseName)
      .filter((file) => file.id !== record.id);
    const requireNumbering = !effectiveCustomName || conflicts.length > 0;
    const targetDirectory = path.resolve(libraryRoot, folderPath);
    this.assertWithinLibrary(libraryRoot, targetDirectory);
    const currentFolder = this.normalizeRelativePath(path.dirname(record.relativePath));
    const targetFolderNormalized = this.normalizeRelativePath(folderPath);
    const needsDirectoryChange = currentFolder !== targetFolderNormalized;
    let targetFileName: string;
    if (requireNumbering) {
      const pattern = new RegExp(`^${baseName}_(\\d+)\\.wav$`, 'i');
      if (!needsDirectoryChange && pattern.test(record.fileName)) {
        targetFileName = record.fileName;
      } else {
        const nextIndex = await this.findNextAvailableNumberWithFilesystemCheck(folderPath, baseName, targetDirectory);
        targetFileName = `${baseName}_${this.organization.formatSequenceNumber(nextIndex)}.wav`;
      }
    } else {
      targetFileName = `${baseName}.wav`;
    }

    const needsRename = record.fileName !== targetFileName;
    const needsMove = needsDirectoryChange || needsRename;
    let targetRelativePath = this.toLibraryRelativePath(folderPath, targetFileName);
    let targetPath = path.join(targetDirectory, targetFileName);
    
    // Final safety check: if target exists and is not our source, force numbering
    if (needsMove) {
      const targetExists = await this.pathExists(targetPath);
      if (targetExists) {
        const targetNormalized = this.normalizeAbsolutePath(targetPath);
        const sourceNormalized = this.normalizeAbsolutePath(record.absolutePath);
        if (targetNormalized !== sourceNormalized) {
          const safeIndex = await this.findNextAvailableNumberWithFilesystemCheck(folderPath, baseName, targetDirectory);
          targetFileName = `${baseName}_${this.organization.formatSequenceNumber(safeIndex)}.wav`;
          targetPath = path.join(targetDirectory, targetFileName);
          targetRelativePath = this.toLibraryRelativePath(folderPath, targetFileName);
        }
      }
    }

    if (!needsMove) {
      const nextCustomName = effectiveCustomName ?? null;
      let updatedRecord = record;
      if (nextCustomName !== (record.customName ?? null)) {
        updatedRecord = this.database.updateCustomName(fileId, nextCustomName);
      }

      // Read existing metadata from the WAV file
      const existing = this.tagService.readMetadata(updatedRecord.absolutePath);
      
      // Merge with new metadata (only update fields that are provided)
      const requestedAuthor = this.normaliseMetadataInput(metadata.author);
      const requestedCopyright = this.normaliseMetadataInput(metadata.copyright);
      const mergedAuthor = requestedAuthor !== undefined ? requestedAuthor : existing.author ?? null;
      const mergedCopyright = requestedCopyright !== undefined ? requestedCopyright : existing.copyright ?? null;
      const mergedRating = metadata.rating !== undefined ? metadata.rating : existing.rating;
      
      this.tagService.writeMetadataOnly(updatedRecord.absolutePath, {
        tags: updatedRecord.tags,
        categories: updatedRecord.categories,
        title: effectiveCustomName,
        author: mergedAuthor,
        copyright: mergedCopyright,
        rating: mergedRating
      });

      // Update suggestions cache for any metadata that was provided
      if (typeof mergedAuthor === 'string' && mergedAuthor.length > 0) {
        this.updateMetadataSuggestionsCache(mergedAuthor, undefined);
      }
      if (typeof mergedCopyright === 'string' && mergedCopyright.length > 0) {
        this.updateMetadataSuggestionsCache(undefined, mergedCopyright);
      }

      this.resetMetadataSuggestionsCache();
      this.waveformPreviewCache.delete(fileId);
      this.search.rebuildIndex();
      return updatedRecord;
    }

    if (requireNumbering && conflicts.length > 0) {
      // Filter out conflicts that already have proper numbered names in the target directory
      const pattern = new RegExp(`^${baseName}_(\\d+)\\.wav$`, 'i');
      const conflictsNeedingRenumber = conflicts.filter((conflict) => {
        const conflictFolder = this.normalizeRelativePath(path.dirname(conflict.relativePath));
        const isInTargetFolder = conflictFolder === targetFolderNormalized;
        const hasNumberedName = pattern.test(conflict.fileName);
        return !isInTargetFolder || !hasNumberedName;
      });
      
      if (conflictsNeedingRenumber.length > 0) {
        await this.renumberConflictingFiles(conflictsNeedingRenumber, folderPath, baseName, libraryRoot);
        
        const nextIndex = await this.findNextAvailableNumberWithFilesystemCheck(folderPath, baseName, targetDirectory);
        targetFileName = `${baseName}_${this.organization.formatSequenceNumber(nextIndex)}.wav`;
        targetPath = path.join(targetDirectory, targetFileName);
        targetRelativePath = this.toLibraryRelativePath(folderPath, targetFileName);
      }
    }

    await fs.mkdir(targetDirectory, { recursive: true });

    await fs.rename(record.absolutePath, targetPath);

    // Try to update database, if UNIQUE constraint fails, retry with numbering
    let updated: AudioFileSummary;
    try {
      updated = this.database.updateFileLocation(
        fileId,
        targetPath,
        targetRelativePath,
        targetFileName,
        path.basename(targetFileName, '.wav')
      );
    } catch (error: unknown) {
      // Check if this is a UNIQUE constraint error on absolute_path
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('UNIQUE constraint') && errorMessage.includes('absolute_path')) {
        await fs.rename(targetPath, record.absolutePath);
        
        const safeIndex = await this.findNextAvailableNumberWithFilesystemCheck(folderPath, baseName, targetDirectory);
        targetFileName = `${baseName}_${this.organization.formatSequenceNumber(safeIndex)}.wav`;
        targetPath = path.join(targetDirectory, targetFileName);
        targetRelativePath = this.toLibraryRelativePath(folderPath, targetFileName);
        
        await fs.rename(record.absolutePath, targetPath);
        
        updated = this.database.updateFileLocation(
          fileId,
          targetPath,
          targetRelativePath,
          targetFileName,
          path.basename(targetFileName, '.wav')
        );
      } else {
        console.error(`Unexpected error during updateFileLocation:`, errorMessage);
        throw error;
      }
    }
    
    const nextCustomName = effectiveCustomName ?? null;
    if (nextCustomName !== (record.customName ?? null)) {
      updated = this.database.updateCustomName(fileId, nextCustomName);
    }
    
    // Read existing metadata from the file at its new location
    const existing = this.tagService.readMetadata(targetPath);
    
    // Merge with new metadata (only update fields that are provided)
  const movedAuthor = this.normaliseMetadataInput(metadata.author);
  const movedCopyright = this.normaliseMetadataInput(metadata.copyright);
  const mergedAuthor = movedAuthor !== undefined ? movedAuthor : existing.author ?? null;
  const mergedCopyright = movedCopyright !== undefined ? movedCopyright : existing.copyright ?? null;
    const mergedRating = metadata.rating !== undefined ? metadata.rating : existing.rating;
    
    // Write tags, categories, and additional metadata to the organized file
    this.tagService.writeMetadataOnly(targetPath, {
      tags: updated.tags,
      categories: updated.categories,
      title: effectiveCustomName,
      author: mergedAuthor,
      copyright: mergedCopyright,
      rating: mergedRating
    });

    // Update suggestions cache for any metadata that was provided
    if (typeof mergedAuthor === 'string' && mergedAuthor.length > 0) {
      this.updateMetadataSuggestionsCache(mergedAuthor, undefined);
    }
    if (typeof mergedCopyright === 'string' && mergedCopyright.length > 0) {
      this.updateMetadataSuggestionsCache(undefined, mergedCopyright);
    }

    this.resetMetadataSuggestionsCache();
    this.waveformPreviewCache.delete(fileId);
    this.search.rebuildIndex();
    return updated;
  }

  /**
   * Deletes files from disk and removes them from the database.
   */
  public async deleteFiles(fileIds: number[]): Promise<void> {
    for (const fileId of fileIds) {
      const record = this.database.getFileById(fileId);
      try {
        await fs.unlink(record.absolutePath);
      } catch (error) {
        console.error(`Failed to delete file ${record.absolutePath}:`, error);
      }
      this.database.deleteFile(fileId);
      this.waveformPreviewCache.delete(fileId);
    }
    this.resetMetadataSuggestionsCache();
    this.search.rebuildIndex();
  }

  /**
   * Returns the previously parsed UCS category catalog.
   */
  public listCategories(): CategoryRecord[] {
    return this.database.listCategories();
  }

  /**
   * Opens the containing folder for a file in the system file explorer.
   */
  public async openFileFolder(fileId: number): Promise<void> {
    const record = this.database.getFileById(fileId);
    const { shell } = await import('electron');
    shell.showItemInFolder(record.absolutePath);
  }

  /**
   * Reads embedded metadata from a WAV file and returns author, copyright, title, and rating.
   */
  public async readFileMetadata(fileId: number): Promise<{ author?: string; copyright?: string; title?: string; rating?: number }> {
    const record = this.database.getFileById(fileId);
    const metadata = this.tagService.readMetadata(record.absolutePath);
    this.updateMetadataSuggestionsCache(metadata.author, metadata.copyright);
    return metadata;
  }

  /**
   * Updates metadata (author, copyright, rating) without organizing the file.
   * Only writes to the WAV INFO chunk, doesn't move or rename the file.
   */
  public async updateFileMetadata(fileId: number, metadata: { author?: string | null; copyright?: string | null; rating?: number }): Promise<void> {
    const record = this.database.getFileById(fileId);
    
    // Read existing metadata from the WAV file
    const existing = this.tagService.readMetadata(record.absolutePath);
    
    // Merge with new metadata (only update fields that are provided)
    const requestedAuthor = this.normaliseMetadataInput(metadata.author);
    const requestedCopyright = this.normaliseMetadataInput(metadata.copyright);
    const mergedMetadata = {
      tags: record.tags,
      categories: record.categories,
      title: record.customName ?? existing.title,
      author: requestedAuthor !== undefined ? requestedAuthor : existing.author ?? null,
      copyright: requestedCopyright !== undefined ? requestedCopyright : existing.copyright ?? null,
      rating: metadata.rating !== undefined ? metadata.rating : existing.rating
    };
    
    // Write merged metadata to the WAV file
    this.tagService.writeMetadataOnly(record.absolutePath, mergedMetadata);

    // Update suggestions cache
    if (typeof mergedMetadata.author === 'string' && mergedMetadata.author.length > 0) {
      this.updateMetadataSuggestionsCache(mergedMetadata.author, undefined);
    }
    if (typeof mergedMetadata.copyright === 'string' && mergedMetadata.copyright.length > 0) {
      this.updateMetadataSuggestionsCache(undefined, mergedMetadata.copyright);
    }

    this.waveformPreviewCache.delete(fileId);
    this.resetMetadataSuggestionsCache();
  }

  /**
   * Returns distinct metadata suggestions aggregated from the library.
   */
  public async listMetadataSuggestions(): Promise<{ authors: string[]; copyrights: string[] }> {
    if (!this.metadataSuggestionCache) {
      const authors = new Set<string>();
      const copyrights = new Set<string>();
      const files = this.database.listFiles();

      for (const file of files) {
        try {
          const metadata = this.tagService.readMetadata(file.absolutePath);
          if (metadata.author) {
            this.addSuggestionValue(authors, metadata.author);
          }
          if (metadata.copyright) {
            this.addSuggestionValue(copyrights, metadata.copyright);
          }
        } catch (error) {
          if (!this.metadataFailures.has(file.absolutePath)) {
            this.metadataFailures.add(file.absolutePath);
            // eslint-disable-next-line no-console -- Provide visibility once per file for suggestion harvesting issues.
            console.warn(`Failed to collect metadata suggestions from ${file.absolutePath}`, error);
          }
        }
      }

      this.metadataSuggestionCache = { authors, copyrights };
    }

    return {
      authors: Array.from(this.metadataSuggestionCache.authors).sort((a, b) => a.localeCompare(b)),
      copyrights: Array.from(this.metadataSuggestionCache.copyrights).sort((a, b) => a.localeCompare(b))
    };
  }

  private addSuggestionValue(target: Set<string>, value: string): void {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      target.add(trimmed);
    }
  }

  /**
   * Normalises optional metadata inputs so blank strings collapse to null while preserving undefined for untouched fields.
   */
  private normaliseMetadataInput(value: string | null | undefined): string | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private updateMetadataSuggestionsCache(author?: string | null, copyright?: string | null): void {
    if (!this.metadataSuggestionCache) {
      return;
    }
    if (author) {
      this.addSuggestionValue(this.metadataSuggestionCache.authors, author);
    }
    if (copyright) {
      this.addSuggestionValue(this.metadataSuggestionCache.copyrights, copyright);
    }
  }

  /**
   * Drops the in-memory metadata suggestion cache so the next read reflects the current library state.
   */
  private resetMetadataSuggestionsCache(): void {
    this.metadataSuggestionCache = null;
  }

  private async renumberConflictingFiles(
    conflicts: AudioFileSummary[],
    folderPath: string,
    baseName: string,
    libraryRoot: string
  ): Promise<void> {
    if (conflicts.length === 0) {
      return;
    }

    const targetDirectory = path.resolve(libraryRoot, folderPath);
    
    // Get fresh file records from database in case they were updated by previous operations
    const freshConflicts = conflicts.map(c => this.database.getFileById(c.id));
    
    console.log(`[renumberConflictingFiles] planning renumber for ${freshConflicts.length} conflict(s) in ${folderPath}`);

    const sortedConflicts = freshConflicts
      .slice()
      .sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' }));

    const plans = sortedConflicts.map((file, index) => {
      const sequence = this.organization.formatSequenceNumber(index + 1);
      const finalFileName = `${baseName}_${sequence}.wav`;
      const finalAbsolutePath = path.join(targetDirectory, finalFileName);
      const relativePath = this.toLibraryRelativePath(folderPath, finalFileName);
      const tempPath = `${finalAbsolutePath}.${Date.now()}-${file.id}-${Math.random().toString(16).slice(2)}.tmp`;
      return {
        file,
        tempPath,
        finalAbsolutePath,
        relativePath,
        fileName: finalFileName,
        displayName: path.basename(finalFileName, '.wav')
      };
    });

    const movedToTemp: typeof plans = [];

    try {
      for (const plan of plans) {
        await fs.rename(plan.file.absolutePath, plan.tempPath);
        movedToTemp.push(plan);
      }

      for (const plan of plans) {
        await fs.rename(plan.tempPath, plan.finalAbsolutePath);
        this.database.updateFileLocation(
          plan.file.id,
          plan.finalAbsolutePath,
          plan.relativePath,
          plan.fileName,
          plan.displayName
        );
      }
    } catch (error) {
      console.error('Error during batch rename, attempting rollback:', error);
      for (const plan of movedToTemp) {
        try {
          await fs.access(plan.tempPath);
          await fs.rename(plan.tempPath, plan.file.absolutePath);
        } catch (rollbackError) {
          console.error(`Failed to rollback ${plan.tempPath}:`, rollbackError);
          try {
            await fs.rename(plan.tempPath, plan.finalAbsolutePath);
          } catch {
            // Recovery failed, file may be lost
          }
        }
      }
      throw error;
    }
  }

  private toLibraryRelativePath(folderPath: string, fileName: string): string {
    return this.normalizeRelativePath(path.join(folderPath, fileName));
  }

  private normalizeAbsolutePath(value: string): string {
    return path.resolve(value).replace(/\\/g, '/');
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Determines the divisor required to normalise raw sample amplitudes for the given wave file.
   */
  private resolveWaveformAmplitudeScale(wave: WaveFile): number {
    const bitDepthText = typeof wave.bitDepth === 'string' ? wave.bitDepth.trim() : '';
    if (bitDepthText.toLowerCase().includes('f')) {
      return 1;
    }
    const parsedBitDepth = Number.parseInt(bitDepthText, 10);
    if (Number.isFinite(parsedBitDepth) && parsedBitDepth > 0) {
      return 2 ** (parsedBitDepth - 1);
    }
    const fmtDepth = (wave as WaveFile & { fmt?: { bitsPerSample?: number } }).fmt?.bitsPerSample;
    if (typeof fmtDepth === 'number' && Number.isFinite(fmtDepth) && fmtDepth > 0) {
      return 2 ** (fmtDepth - 1);
    }
    return 1;
  }

  /**
   * Scales an array of sample peak magnitudes into the 0..1 range while guarding against NaN values.
   */
  private normaliseWaveformArray(values: number[]): number[] {
    let peak = 0;
    for (const value of values) {
      if (Number.isFinite(value) && value > peak) {
        peak = value;
      }
    }
    if (peak <= 0) {
      return values.map(() => 0);
    }
    return values.map((value) => {
      if (!Number.isFinite(value)) {
        return 0;
      }
      const normalised = value / peak;
      if (normalised <= 0) {
        return 0;
      }
      if (normalised >= 1) {
        return 1;
      }
      return normalised;
    });
  }

  private normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/');
  }

  /**
   * Extracts metadata from the WAV container, falling back to defaults when parsing fails.
   */
  private async extractAudioMetadata(filePath: string): Promise<{
    durationMs: number | null;
    sampleRate: number | null;
    bitDepth: number | null;
    tags: string[];
    categories: string[];
  }> {
    try {
      const mmImport = await import('music-metadata');
      const mm = (mmImport as { default?: unknown }).default ?? mmImport;
      
      const loadMusicMetadata = typeof mm === 'object' && mm !== null && 'loadMusicMetadata' in mm
        ? (mm as { loadMusicMetadata: () => Promise<{ parseFile: (path: string, opts?: { duration?: boolean }) => Promise<{
            format: { duration?: number | null; sampleRate?: number | null; bitsPerSample?: number | null };
            common: { comment?: unknown[]; genre?: unknown[]; subtitle?: unknown };
          }> }> }).loadMusicMetadata
        : null;
      
      if (!loadMusicMetadata) {
        throw new Error('music-metadata loadMusicMetadata not found');
      }
      
      const musicMetadata = await loadMusicMetadata();
      const metadata = await musicMetadata.parseFile(filePath, { duration: true });
      const infoTags = this.tagService.readInfoTags(filePath);
      const splitInfoValues = (input: string | undefined): string[] =>
        input
          ? input
              .split(/[,;]+/)
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : [];
      const duration = metadata.format.duration ? Math.round(metadata.format.duration * 1000) : null;
      const sampleRate = metadata.format.sampleRate ?? null;
      const bitDepth = metadata.format.bitsPerSample ?? null;
      const comment = (metadata.common.comment ?? [])
          .map((entry: unknown) => {
            if (typeof entry === 'string') {
              return entry;
            }
            if (entry && typeof entry === 'object' && 'text' in entry) {
              const value = (entry as { text?: unknown }).text;
              return typeof value === 'string' ? value : '';
            }
            return '';
          })
          .filter((value: string) => value.length > 0);
        const genre = (metadata.common.genre ?? [])
          .map((entry: unknown) => (typeof entry === 'string' ? entry : ''))
          .filter((entry: string) => entry.length > 0);
      const infoTagValues = splitInfoValues(infoTags.IKEY);
      const tagSet = new Set<string>();
      if (infoTagValues.length > 0) {
        for (const entry of infoTagValues) {
          tagSet.add(entry);
        }
      } else {
        for (const entry of comment) {
          tagSet.add(entry);
        }
        for (const entry of genre) {
          tagSet.add(entry);
        }
      }
        
        // Extract subtitle field and use it as CatID for category matching
        const subtitle = metadata.common.subtitle;
        const categoriesSet = new Set<string>();
        const subtitleValues = typeof subtitle === 'string' ? splitInfoValues(subtitle) : [];
        for (const value of subtitleValues) {
          categoriesSet.add(value);
        }

        const subjectValues = splitInfoValues(infoTags.ISBJ);
        for (const value of subjectValues) {
          categoriesSet.add(value);
        }

        if (categoriesSet.size === 0) {
          const legacyGenreValues = splitInfoValues(infoTags.IGNR);
          for (const value of legacyGenreValues) {
            categoriesSet.add(value);
          }
        }

        const categories: string[] = [];
        for (const candidate of categoriesSet) {
          const category = this.database.getCategoryById(candidate);
          if (category) {
            categories.push(candidate);
          }
        }
        
      const fallback = await this.extractWaveFallback(filePath, {
        durationMs: duration,
        sampleRate,
        bitDepth
      });

      const filteredTags = Array.from(tagSet).filter((entry) => !categories.includes(entry));

      return {
        durationMs: fallback.durationMs,
        sampleRate: fallback.sampleRate,
        bitDepth: fallback.bitDepth,
        tags: filteredTags,
        categories
      };
    } catch (error) {
      if (!this.metadataFailures.has(filePath)) {
        this.metadataFailures.add(filePath);
        // eslint-disable-next-line no-console -- Provide visibility once per file for metadata parsing issues.
        console.warn(`Failed to parse metadata for ${filePath}`, error);
      }
      const fallback = await this.extractWaveFallback(filePath);
      return {
        durationMs: fallback.durationMs,
        sampleRate: fallback.sampleRate,
        bitDepth: fallback.bitDepth,
        tags: [],
        categories: []
      };
    }
  }

  /**
   * Attempts to parse metadata directly from the WAV container when the primary parser misses fields.
   */
  private async extractWaveFallback(
    filePath: string,
    baseline?: {
      durationMs: number | null;
      sampleRate: number | null;
      bitDepth: number | null;
    }
  ): Promise<{
    durationMs: number | null;
    sampleRate: number | null;
    bitDepth: number | null;
  }> {
    const current = {
      durationMs: baseline?.durationMs ?? null,
      sampleRate: baseline?.sampleRate ?? null,
      bitDepth: baseline?.bitDepth ?? null
    };

    if (current.durationMs !== null && current.sampleRate !== null && current.bitDepth !== null) {
      return current;
    }

    try {
      const buffer = await fs.readFile(filePath);
      const wave = new WaveFile(buffer);

      const fmt = wave.fmt as {
        sampleRate?: number;
        bitsPerSample?: number;
        blockAlign?: number;
      };
      const data = wave.data as {
        chunkSize?: number;
      };

      const sampleRate = current.sampleRate !== null ? current.sampleRate : typeof fmt.sampleRate === 'number' ? fmt.sampleRate : null;
      const bitDepth = current.bitDepth !== null ? current.bitDepth : typeof fmt.bitsPerSample === 'number' ? fmt.bitsPerSample : null;

      let durationMs = current.durationMs;
      const blockAlign = typeof fmt.blockAlign === 'number' ? fmt.blockAlign : null;
      const chunkSize = typeof data.chunkSize === 'number' ? data.chunkSize : null;
      if (durationMs === null && sampleRate && blockAlign && blockAlign > 0 && chunkSize !== null && sampleRate > 0) {
        const totalSamples = chunkSize / blockAlign;
        durationMs = Math.round((totalSamples / sampleRate) * 1000);
      }

      return {
        durationMs,
        sampleRate,
        bitDepth
      };
    } catch (error) {
      if (!this.metadataFailures.has(`${filePath}::wave`)) {
        this.metadataFailures.add(`${filePath}::wave`);
        // eslint-disable-next-line no-console -- Provide visibility once per file for metadata fallback issues.
        console.warn(`Failed to parse WAV metadata for ${filePath}`, error);
      }
      return current;
    }
  }

  /**
   * Computes checksum from audio data only, excluding metadata chunks for stability.
   */
  private async computeFileChecksum(filePath: string): Promise<string | null> {
    try {
      const buffer = await fs.readFile(filePath);
      const wave = new WaveFile(buffer);
      
      // Hash only the raw audio samples, not metadata or other chunks
      const hash = createHash('md5');
      const samples = wave.getSamples();
      
      if (Array.isArray(samples)) {
        // Multi-channel: hash each channel
        for (const channel of samples) {
          hash.update(Buffer.from(channel.buffer));
        }
      } else {
        // Single channel
        hash.update(Buffer.from(samples.buffer));
      }
      
      return hash.digest('hex');
    } catch (error) {
      if (!this.checksumFailures.has(filePath)) {
        this.checksumFailures.add(filePath);
        // eslint-disable-next-line no-console -- Only log checksum issues once per file.
        console.warn(`Failed to compute checksum for ${filePath}`, error);
      }
      return null;
    }
  }

  /**
   * Normalises file names, ensuring the .wav extension is present.
   */
  private normaliseFileName(input: string): string {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new Error('File name cannot be empty.');
    }
    const extension = path.extname(trimmed);
    if (!extension) {
      return `${trimmed}.wav`;
    }
    if (extension.toLowerCase() !== '.wav') {
      throw new Error('Only WAV files are supported.');
    }
    return trimmed;
  }

  /**
   * Ensures paths stay inside the configured library root.
   */
  private assertWithinLibrary(libraryRoot: string, candidate: string): void {
    const normalisedRoot = path.resolve(libraryRoot);
    const normalisedCandidate = path.resolve(candidate);
    const rootWithSeparator = normalisedRoot.endsWith(path.sep)
      ? normalisedRoot
      : `${normalisedRoot}${path.sep}`;
    if (
      normalisedCandidate !== normalisedRoot &&
      !normalisedCandidate.toLowerCase().startsWith(rootWithSeparator.toLowerCase())
    ) {
      throw new Error('Target path must remain inside the configured library.');
    }
  }
}
