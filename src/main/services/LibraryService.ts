import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fg from 'fast-glob';
import { parse } from 'csv-parse/sync';
import {
  AppSettings,
  AudioBufferPayload,
  AudioFileSummary,
  CategoryRecord,
  ImportFailureEntry,
  ImportSkipEntry,
  LibraryImportResult,
  LibraryScanSummary,
  SplitSegmentRequest,
  TagUpdatePayload
} from '../../shared/models';
import { DatabaseService, FileRecordInput } from './DatabaseService';
import { SettingsService } from './SettingsService';
import { TagService } from './TagService';
import { SearchService } from './SearchService';
import { WaveFile } from 'wavefile';
import { OrganizationService } from './OrganizationService';

type MusicMetadataParser = (path: string, options?: { duration?: boolean }) => Promise<{
  format: { duration?: number | null; sampleRate?: number | null; bitsPerSample?: number | null };
  common: { comment?: unknown[]; genre?: unknown[]; subtitle?: unknown };
}>;

type MusicMetadataNamespace = Partial<{ parseFile: MusicMetadataParser }> & {
  default?: Partial<{ parseFile: MusicMetadataParser }>;
};

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
  private metadataSuggestionCache: { authors: Set<string> } | null = null;
  private readonly waveformPreviewCache = new Map<number, { modifiedAt: number; pointCount: number; samples: number[]; rms: number }>();
  private offlineAudioContextCtor: (new (channelCount: number, length: number, sampleRate: number) => any) | null = null;
  private musicMetadataParseFile: MusicMetadataParser | null = null;
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
    
  await this.cleanupTempFiles();
    const libraryRoot = this.settings.ensureLibraryPath();
    const existing = this.database.listFiles();
  const existingByPath = new Map(existing.map((file) => [file.absolutePath, file] as const));
  const existingByChecksum = new Map(existing.filter((file) => file.checksum).map((file) => [file.checksum!, file] as const));
  const discoveredByPath = new Map<string, AudioFileSummary>();

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
      
      // Read embedded WAV metadata (author, copyright, rating, title, parentId)
      const embeddedMetadata = this.tagService.readMetadata(absolutePath);
      
      let parentFileId = knownFile?.parentFileId ?? null;
      
      // First try embedded metadata parentId
      if (parentFileId === null && embeddedMetadata.parentId !== undefined) {
        parentFileId = embeddedMetadata.parentId;
      }
      
      // Fall back to filename pattern matching for segments
      if (parentFileId === null) {
        const segmentMatch = fileName.match(/^(.*)_segment\d+(\.[^.]+)$/i);
        if (segmentMatch) {
          const parentFileName = `${segmentMatch[1]}${segmentMatch[2]}`;
          const parentAbsolutePath = path.join(path.dirname(absolutePath), parentFileName);
          const parentRecord = existingByPath.get(parentAbsolutePath) ?? discoveredByPath.get(parentAbsolutePath) ?? null;
          if (parentRecord) {
            parentFileId = parentRecord.id;
          }
        }
      }

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
        categories: metadata.categories.length > 0 ? metadata.categories : (knownFile?.categories ?? []),
        parentFileId
      };
      const upserted = this.database.upsertFile(record);
      
      // Update custom name from embedded title if present, otherwise keep existing
      const customName = embeddedMetadata.title?.trim() || knownFile?.customName || null;
      const finalRecord = customName !== upserted.customName
        ? this.database.updateCustomName(upserted.id, customName)
        : upserted;

      existingByPath.set(absolutePath, finalRecord);
      if (checksum) {
        existingByChecksum.set(checksum, finalRecord);
      }
      discoveredByPath.set(absolutePath, finalRecord);

      if (parentFileId !== null) {
        const embeddedParent = embeddedMetadata.parentId ?? null;
        if (embeddedParent === null || embeddedParent !== parentFileId) {
          this.tagService.writeMetadataOnly(absolutePath, {
            tags: finalRecord.tags,
            categories: finalRecord.categories,
            title: customName ?? embeddedMetadata.title ?? finalRecord.displayName,
            author: embeddedMetadata.author ?? null,
            rating: embeddedMetadata.rating,
            copyright: embeddedMetadata.copyright ?? null,
            parentId: parentFileId
          });
        }
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
   * Attempts to resolve a file summary by id. Returns null when the record no longer exists.
   */
  public getFileById(fileId: number): AudioFileSummary | null {
    try {
      return this.database.getFileById(fileId);
    } catch (error) {
      if (error instanceof Error) {
        console.warn(`Failed to resolve file by id ${fileId}:`, error.message);
      }
      return null;
    }
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
   * Imports external WAV files from the provided sources, copying them into the library while
   * skipping duplicates based on the audio checksum. Imported files land under `_Imports/<date>`.
   */
  public async importExternalSources(sourcePaths: string[]): Promise<LibraryImportResult> {
    // eslint-disable-next-line no-console -- Log import start for debugging.
    console.log('Starting import from:', sourcePaths);
    
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
      return { imported: [], skipped: [], failed: [] };
    }

    const libraryRoot = this.settings.ensureLibraryPath();
    const normalisedLibraryRoot = this.normalizeAbsolutePath(libraryRoot);
    const libraryRootWithSlash = normalisedLibraryRoot.endsWith('/')
      ? normalisedLibraryRoot
      : `${normalisedLibraryRoot}/`;

    const existingFiles = this.database.listFiles();
    const knownChecksums = new Set<string>();
    const knownPaths = new Set<string>();
    for (const file of existingFiles) {
      if (typeof file.checksum === 'string' && file.checksum.length > 0) {
        knownChecksums.add(file.checksum);
      }
      knownPaths.add(this.normalizeAbsolutePath(file.absolutePath));
    }

    const importFolderRelativeBase = path.join('_Imports', new Date().toISOString().slice(0, 10));
    const importFolderAbsolute = path.join(libraryRoot, importFolderRelativeBase);
    await fs.mkdir(importFolderAbsolute, { recursive: true });

    const { files: candidateFiles, failures } = await this.collectImportCandidates(sourcePaths);
    
    // eslint-disable-next-line no-console -- Log discovered files for debugging.
    console.log(`Found ${candidateFiles.length} candidate files, ${failures.length} collection failures`);
    if (failures.length > 0) {
      // eslint-disable-next-line no-console -- Log collection failures for debugging.
      console.log('Collection failures:', failures);
    }

    const imported: AudioFileSummary[] = [];
    const skipped: ImportSkipEntry[] = [];
    const failed: ImportFailureEntry[] = [...failures];
    const usedNames = new Set<string>();
    const allowedExtensions = new Set(['.wav', '.wave']);

    const folderRelativeNormalised = this.normalizeRelativePath(
      path.relative(libraryRoot, importFolderAbsolute)
    );
    const folderForJoin =
      folderRelativeNormalised === '.' || folderRelativeNormalised.length === 0
        ? ''
        : folderRelativeNormalised;

    for (const candidate of candidateFiles) {
      const extension = path.extname(candidate).toLowerCase();
      if (!allowedExtensions.has(extension)) {
        // eslint-disable-next-line no-console -- Log skip reason for debugging.
        console.log(`Skipping ${candidate}: unsupported extension ${extension}`);
        skipped.push({ path: candidate, reason: 'unsupported' });
        continue;
      }

      const normalisedCandidate = this.normalizeAbsolutePath(candidate);
      if (
        normalisedCandidate === normalisedLibraryRoot ||
        normalisedCandidate.startsWith(libraryRootWithSlash)
      ) {
        // eslint-disable-next-line no-console -- Log skip reason for debugging.
        console.log(`Skipping ${candidate}: already inside library`);
        skipped.push({ path: candidate, reason: 'inside-library' });
        continue;
      }

      if (knownPaths.has(normalisedCandidate)) {
        // eslint-disable-next-line no-console -- Log skip reason for debugging.
        console.log(`Skipping ${candidate}: duplicate path`);
        skipped.push({ path: candidate, reason: 'duplicate' });
        continue;
      }

      // eslint-disable-next-line no-console -- Log checksum computation for debugging.
      console.log(`Computing checksum for ${candidate}...`);
      const checksum = await this.computeFileChecksum(candidate);
      if (!checksum) {
        // eslint-disable-next-line no-console -- Log skip reason for debugging.
        console.log(`Skipping ${candidate}: checksum computation failed`);
        skipped.push({ path: candidate, reason: 'checksum' });
        continue;
      }

      if (knownChecksums.has(checksum)) {
        // eslint-disable-next-line no-console -- Log skip reason for debugging.
        console.log(`Skipping ${candidate}: duplicate checksum ${checksum}`);
        skipped.push({ path: candidate, reason: 'duplicate' });
        continue;
      }

      // eslint-disable-next-line no-console -- Log import attempt for debugging.
      console.log(`Attempting to import ${candidate} with checksum ${checksum}...`);
      try {
        const record = await this.copyAndRegisterImportedFile({
          sourcePath: candidate,
          checksum,
          importFolderAbsolute,
          folderForJoin,
          libraryRoot,
          usedNames
        });
        imported.push(record);
        knownChecksums.add(checksum);
        knownPaths.add(this.normalizeAbsolutePath(record.absolutePath));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console -- Log import failures for debugging.
        console.error(`Failed to import ${candidate}:`, errorMessage);
        failed.push({
          path: candidate,
          message: errorMessage
        });
      }
    }

    if (imported.length > 0) {
      this.resetMetadataSuggestionsCache();
      this.search.rebuildIndex();
    }

    return { imported, skipped, failed };
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
    this.clearWaveformCache(fileId);
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
    this.clearWaveformCache(fileId);
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
    const startTime = performance.now();
    const record = this.database.getFileById(fileId);
  const effectivePoints = Math.min(Math.max(pointCount ?? 160, 32), 16384);
    
    // Check database cache first
    const dbCache = this.database.getWaveformCache(fileId, effectivePoints);
    if (dbCache) {
      return dbCache;
    }
    
    // Check memory cache
    const cacheHit = this.waveformPreviewCache.get(fileId);
    if (cacheHit && cacheHit.modifiedAt === record.modifiedAt && cacheHit.pointCount === effectivePoints) {
      return { samples: cacheHit.samples, rms: cacheHit.rms };
    }

    try {
  const buffer = await fs.readFile(record.absolutePath);
  const wave = new WaveFile(buffer);
  
  // For large files, use optimized sampling instead of processing all samples
  const fileSize = buffer.length;
  const useFastSampling = fileSize > 10 * 1024 * 1024; // 10MB threshold
  
  if (useFastSampling) {
    return await this.getWaveformPreviewFast(fileId, record, wave, effectivePoints, buffer, startTime);
  }
  
  const sampleBlock = wave.getSamples(false, Float64Array) as Float64Array | Float64Array[];
  const channels = (Array.isArray(sampleBlock) ? sampleBlock : [sampleBlock]) as Float64Array[];
      const firstChannel = channels[0];

      if (!firstChannel || firstChannel.length === 0) {
        const fallback = new Array(effectivePoints).fill(0);
        this.waveformPreviewCache.set(fileId, {
          modifiedAt: record.modifiedAt,
          pointCount: effectivePoints,
          samples: fallback,
          rms: 0
        });
        this.database.setWaveformCache(fileId, effectivePoints, fallback, 0);
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
      this.database.setWaveformCache(fileId, effectivePoints, samples, rms);

      const totalTime = performance.now() - startTime;
      const durationSec = record.durationMs ? (record.durationMs / 1000).toFixed(1) : 'unknown';
      console.log(`Waveform preview for ${record.fileName}: ${totalTime.toFixed(1)}ms (${durationSec}s audio, ${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);

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
      this.database.setWaveformCache(fileId, effectivePoints, fallback, 0);
      return { samples: fallback, rms: 0 };
    }
  }

  /**
   * Fast waveform preview generation for large files using sparse sampling.
   * Reads raw audio data directly without extracting all samples.
   */
  private async getWaveformPreviewFast(
    fileId: number,
    record: AudioFileSummary,
    wave: WaveFile,
    effectivePoints: number,
    buffer: Buffer,
    startTime: number
  ): Promise<{ samples: number[]; rms: number }> {
    // Parse WAV header to find data chunk
    const fmt = wave.fmt as { numChannels: number; bitsPerSample: number };
    const numChannels = fmt.numChannels;
    const bytesPerSample = Math.floor(fmt.bitsPerSample / 8);
    const bytesPerFrame = numChannels * bytesPerSample;
    
    // Find the data chunk in the buffer
    let dataOffset = 12; // Skip RIFF header
    let dataSize = 0;
    
    while (dataOffset < buffer.length - 8) {
      const chunkId = buffer.toString('ascii', dataOffset, dataOffset + 4);
      const chunkSize = buffer.readUInt32LE(dataOffset + 4);
      
      if (chunkId === 'data') {
        dataOffset += 8; // Skip chunk header
        dataSize = chunkSize;
        break;
      }
      
      dataOffset += 8 + chunkSize;
      if (chunkSize % 2 === 1) dataOffset++; // Word-aligned
    }
    
    if (dataSize === 0) {
      // Fallback if we can't find data chunk
      const fallback = new Array(effectivePoints).fill(0);
      this.waveformPreviewCache.set(fileId, {
        modifiedAt: record.modifiedAt,
        pointCount: effectivePoints,
        samples: fallback,
        rms: 0
      });
      return { samples: fallback, rms: 0 };
    }
    
    const totalFrames = Math.floor(dataSize / bytesPerFrame);
    const framesPerPoint = Math.floor(totalFrames / effectivePoints);
    
    // Sample at most 100 frames per point for large files
    const framesToSamplePerPoint = Math.min(framesPerPoint, 100);
    const frameStep = Math.max(1, Math.floor(framesPerPoint / framesToSamplePerPoint));
    
    const peaks: number[] = [];
    let sumSquares = 0;
    let sampleTotal = 0;
    
    // Determine max value for normalization based on bit depth
    const maxValue = Math.pow(2, fmt.bitsPerSample - 1);
    
    for (let pointIndex = 0; pointIndex < effectivePoints; pointIndex++) {
      const startFrame = pointIndex * framesPerPoint;
      const endFrame = pointIndex === effectivePoints - 1 
        ? totalFrames 
        : Math.min(totalFrames, startFrame + framesPerPoint);
      
      let blockPeak = 0;
      
      for (let frame = startFrame; frame < endFrame; frame += frameStep) {
        const byteOffset = dataOffset + (frame * bytesPerFrame);
        
        // Read samples from all channels at this frame
        for (let ch = 0; ch < numChannels; ch++) {
          const sampleOffset = byteOffset + (ch * bytesPerSample);
          
          if (sampleOffset + bytesPerSample > buffer.length) break;
          
          // Read sample based on bit depth
          let sampleValue = 0;
          if (bytesPerSample === 2) {
            sampleValue = buffer.readInt16LE(sampleOffset);
          } else if (bytesPerSample === 3) {
            // 24-bit
            const byte1 = buffer.readUInt8(sampleOffset);
            const byte2 = buffer.readUInt8(sampleOffset + 1);
            const byte3 = buffer.readInt8(sampleOffset + 2);
            sampleValue = (byte3 << 16) | (byte2 << 8) | byte1;
          } else if (bytesPerSample === 4) {
            sampleValue = buffer.readInt32LE(sampleOffset);
          } else if (bytesPerSample === 1) {
            sampleValue = buffer.readInt8(sampleOffset) << 8; // Convert 8-bit to 16-bit range
          }
          
          const normalized = sampleValue / maxValue;
          const clamped = Math.max(-1, Math.min(1, normalized));
          const magnitude = Math.abs(clamped);
          
          if (magnitude > blockPeak) {
            blockPeak = magnitude;
          }
          
          sumSquares += clamped * clamped;
          sampleTotal++;
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
    this.database.setWaveformCache(fileId, effectivePoints, samples, rms);

    const totalTime = performance.now() - startTime;
    const durationSec = record.durationMs ? (record.durationMs / 1000).toFixed(1) : 'unknown';
    console.log(`Waveform preview for ${record.fileName}: ${totalTime.toFixed(1)}ms (${durationSec}s audio, ${(buffer.length / 1024 / 1024).toFixed(1)}MB) [FAST]`);

    return { samples, rms };
  }

  /**
   * Returns full-resolution waveform samples for a specific time range.
   * Used for high-detail editor rendering when zoomed in.
   */
  public async getWaveformRange(fileId: number, startMs: number, endMs: number): Promise<{ samples: number[] }> {
    const record = this.database.getFileById(fileId);
    
    try {
      const buffer = await fs.readFile(record.absolutePath);
      const wave = new WaveFile(buffer);
      
      // Get all samples for the entire file
      const sampleBlock = wave.getSamples(false, Float64Array) as Float64Array | Float64Array[];
      const channels = (Array.isArray(sampleBlock) ? sampleBlock : [sampleBlock]) as Float64Array[];
      const firstChannel = channels[0];

      if (!firstChannel || firstChannel.length === 0 || !record.durationMs || record.durationMs <= 0) {
        return { samples: [] };
      }

      const amplitudeScale = Math.max(1, this.resolveWaveformAmplitudeScale(wave));
      const totalDurationMs = record.durationMs;
      const samplesPerMs = firstChannel.length / totalDurationMs;
      
      // Calculate sample indices for the requested time range
      const startSample = Math.floor(startMs * samplesPerMs);
      const endSample = Math.ceil(endMs * samplesPerMs);
      const clampedStart = Math.max(0, startSample);
      const clampedEnd = Math.min(firstChannel.length, endSample);
      
      // Extract peaks for the range
      const samples: number[] = [];
      
      for (let cursor = clampedStart; cursor < clampedEnd; cursor += 1) {
        let peak = 0;
        for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
          const channel = channels[channelIndex];
          const rawSample = channel?.[cursor] ?? 0;
          const normalisedSample = rawSample / amplitudeScale;
          const clampedSample = Math.max(-1, Math.min(1, normalisedSample));
          const magnitude = Math.abs(clampedSample);
          if (magnitude > peak) {
            peak = magnitude;
          }
        }
        samples.push(Math.min(peak, 1));
      }

      return { samples: this.normaliseWaveformArray(samples) };
    } catch (error) {
      console.warn('Failed to generate waveform range', { fileId, startMs, endMs, error });
      return { samples: [] };
    }
  }

  /**
   * Applies tag updates, optionally re-running the organize pipeline when categories are present.
   */
  public async updateTagging(payload: TagUpdatePayload): Promise<AudioFileSummary> {
    const updated = this.tagService.applyTagging(payload.fileId, payload.tags, payload.categories);
    this.clearWaveformCache(payload.fileId);

    if (updated.categories.length > 0) {
      const metadataSnapshot = this.tagService.readMetadata(updated.absolutePath);
      return this.organizeFile(payload.fileId, {
        customName: updated.customName ?? undefined,
        author: metadataSnapshot.author?.trim() || undefined,
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
    metadata: { customName?: string | null; author?: string | null; rating?: number }
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
      const mergedAuthor = requestedAuthor !== undefined ? requestedAuthor : existing.author ?? null;
      const mergedRating = metadata.rating !== undefined ? metadata.rating : existing.rating;
      
      this.tagService.writeMetadataOnly(updatedRecord.absolutePath, {
        tags: updatedRecord.tags,
        categories: updatedRecord.categories,
        title: effectiveCustomName,
        author: mergedAuthor,
        rating: mergedRating,
        copyright: existing.copyright ?? null,
        parentId: updatedRecord.parentFileId ?? null
      });

      // Update suggestions cache for any metadata that was provided
      if (typeof mergedAuthor === 'string' && mergedAuthor.length > 0) {
        this.updateMetadataSuggestionsCache(mergedAuthor);
      }

      this.resetMetadataSuggestionsCache();
      this.clearWaveformCache(fileId);
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
  const mergedAuthor = movedAuthor !== undefined ? movedAuthor : existing.author ?? null;
    const mergedRating = metadata.rating !== undefined ? metadata.rating : existing.rating;
    
    // Write tags, categories, and additional metadata to the organized file
    this.tagService.writeMetadataOnly(targetPath, {
      tags: updated.tags,
      categories: updated.categories,
      title: effectiveCustomName,
      author: mergedAuthor,
      rating: mergedRating,
      copyright: existing.copyright ?? null,
      parentId: updated.parentFileId ?? null
    });

    // Update suggestions cache for any metadata that was provided
    if (typeof mergedAuthor === 'string' && mergedAuthor.length > 0) {
      this.updateMetadataSuggestionsCache(mergedAuthor);
    }

    this.resetMetadataSuggestionsCache();
    this.clearWaveformCache(fileId);
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
      this.clearWaveformCache(fileId);
    }
    this.resetMetadataSuggestionsCache();
    this.search.rebuildIndex();
  }

  /**
   * Splits an audio file into multiple segments, writing each segment to disk and registering it in the library.
   */
  public async splitFile(fileId: number, requestSegments: SplitSegmentRequest[]): Promise<AudioFileSummary[]> {
    if (!Array.isArray(requestSegments) || requestSegments.length === 0) {
      return [];
    }

    const record = this.database.getFileById(fileId);
    const fileBuffer = await fs.readFile(record.absolutePath);
  const wave = new WaveFile(fileBuffer);
  const format = (wave as WaveFile & { fmt?: { sampleRate?: number; bitsPerSample?: number } }).fmt;
    const rawSamples = wave.getSamples(false, Float64Array) as Float64Array | Float64Array[];
    const channels = Array.isArray(rawSamples) ? rawSamples : [rawSamples];
    if (channels.length === 0 || channels[0].length === 0) {
      throw new Error('Unable to split file: no audio data available.');
    }

  const sampleRate = format?.sampleRate ?? record.sampleRate ?? null;
    if (!sampleRate) {
      throw new Error('Unable to split file: missing sample rate information.');
    }

    const sourceSampleCount = channels[0].length;
    const totalDurationMs = Math.round((sourceSampleCount / sampleRate) * 1000);
    const bitDepthNumeric = (() => {
  const explicit = format?.bitsPerSample;
      if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
        return explicit;
      }
      if (typeof record.bitDepth === 'number' && Number.isFinite(record.bitDepth) && record.bitDepth > 0) {
        return record.bitDepth;
      }
      const parsedFromText = Number.parseInt(typeof wave.bitDepth === 'string' ? wave.bitDepth : '', 10);
      return Number.isFinite(parsedFromText) && parsedFromText > 0 ? parsedFromText : null;
    })();
    const bitDepthText = (() => {
      if (typeof wave.bitDepth === 'string' && wave.bitDepth.trim().length > 0) {
        return wave.bitDepth.trim();
      }
      if (typeof bitDepthNumeric === 'number') {
        return bitDepthNumeric.toString();
      }
      return '16';
    })();
    const container = (wave as WaveFile & { container?: string }).container ?? 'RIFF';

  let originalMetadata: { author?: string | null; rating?: number; title?: string | null; copyright?: string | null } = {};
    try {
      const metadata = this.tagService.readMetadata(record.absolutePath);
      originalMetadata = {
        author: metadata.author ?? null,
        rating: metadata.rating ?? undefined,
        title: metadata.title ?? null,
        copyright: metadata.copyright ?? null
      };
    } catch (error) {
      console.warn('Failed to read original metadata before splitting', error);
    }

    const normalizedSegments = requestSegments
      .map((segment) => {
        const startMs = Number.isFinite(segment.startMs) ? Math.max(0, Math.min(Math.floor(segment.startMs), totalDurationMs)) : 0;
        const endMs = Number.isFinite(segment.endMs) ? Math.max(0, Math.min(Math.floor(segment.endMs), totalDurationMs)) : startMs;
        const safeEnd = Math.max(startMs + 1, endMs);
        return {
          startMs,
          endMs: safeEnd,
          label: segment.label?.trim() ?? undefined,
          metadata: segment.metadata,
          fadeInMs: Number.isFinite(segment.fadeInMs) ? Math.max(0, Math.floor(segment.fadeInMs!)) : 0,
          fadeOutMs: Number.isFinite(segment.fadeOutMs) ? Math.max(0, Math.floor(segment.fadeOutMs!)) : 0
        };
      })
      .filter((segment) => segment.endMs - segment.startMs >= 5)
      .sort((a, b) => a.startMs - b.startMs);

    if (normalizedSegments.length === 0) {
      return [];
    }

    const libraryRoot = this.settings.ensureLibraryPath();
    const sourceDirectory = path.dirname(record.absolutePath);
    const relativeFolder = path.dirname(record.relativePath);
    const folderForJoin = relativeFolder === '.' ? '' : relativeFolder;
    const baseName = path.basename(record.fileName, path.extname(record.fileName));
    const usedNames = new Set<string>();
    let sequence = 1;
    const created: AudioFileSummary[] = [];

    for (const segment of normalizedSegments) {
      const startSample = Math.max(0, Math.min(Math.floor((segment.startMs / 1000) * sampleRate), sourceSampleCount - 1));
      const endSample = Math.max(
        startSample + 1,
        Math.min(Math.floor((segment.endMs / 1000) * sampleRate), sourceSampleCount)
      );
      if (endSample <= startSample) {
        continue;
      }

  let segmentChannels: Float64Array[] = channels.map((channel) => channel.slice(startSample, endSample));

      const fadeInMs = segment.fadeInMs ?? 0;
      const fadeOutMs = segment.fadeOutMs ?? 0;
      if (fadeInMs > 0 || fadeOutMs > 0) {
        segmentChannels = (await this.applyFadeEnvelopeToSegment(segmentChannels, sampleRate, fadeInMs, fadeOutMs)) as Float64Array[];
      }

      const nextWave = new WaveFile();
      nextWave.fromScratch(channels.length, sampleRate, bitDepthText, segmentChannels.length === 1 ? segmentChannels[0] : segmentChannels);
      (nextWave as WaveFile & { container?: string }).container = container;
      const segmentBytes = Buffer.from(nextWave.toBuffer());

      // Determine the segment name part - use label if available, otherwise use sequence
      let segmentNamePart = '';
      if (segment.label) {
        const sanitized = this.organization.sanitizeCustomName(segment.label);
        if (sanitized) {
          segmentNamePart = sanitized;
        }
      }
      
      let segmentFileName = '';
      let segmentAbsolutePath = '';
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        let candidateName: string;
        if (segmentNamePart) {
          // Use label-based name, with optional suffix for duplicates
          if (attempt === 0) {
            candidateName = `${baseName}_${segmentNamePart}.wav`;
          } else {
            candidateName = `${baseName}_${segmentNamePart}_${this.organization.formatSequenceNumber(attempt)}.wav`;
          }
        } else {
          // Fallback to sequential numbering
          const suffix = this.organization.formatSequenceNumber(sequence);
          sequence += 1;
          candidateName = `${baseName}_segment${suffix}.wav`;
        }
        
        if (usedNames.has(candidateName)) {
          continue;
        }
        const candidatePath = path.join(sourceDirectory, candidateName);
        const exists = await this.pathExists(candidatePath);
        if (exists) {
          continue;
        }
        segmentFileName = candidateName;
        segmentAbsolutePath = candidatePath;
        usedNames.add(candidateName);
        break;
      }

      if (!segmentFileName || !segmentAbsolutePath) {
        throw new Error('Failed to allocate filename for split segment.');
      }

      this.assertWithinLibrary(libraryRoot, segmentAbsolutePath);
      await fs.writeFile(segmentAbsolutePath, segmentBytes);
      const stats = await fs.stat(segmentAbsolutePath);
      const checksum = createHash('md5').update(segmentBytes).digest('hex');
      const relativePath = this.toLibraryRelativePath(folderForJoin, segmentFileName);
      const durationMs = Math.round(((endSample - startSample) / sampleRate) * 1000);

      const resolvedTagsSource = segment.metadata?.tags ?? record.tags;
      const resolvedCategoriesSource = segment.metadata?.categories ?? record.categories;
      const resolvedTags = Array.isArray(resolvedTagsSource) ? resolvedTagsSource.slice() : record.tags.slice();
      const resolvedCategories = Array.isArray(resolvedCategoriesSource)
        ? resolvedCategoriesSource.slice()
        : record.categories.slice();
      const fileRecord = this.database.upsertFile({
        absolutePath: segmentAbsolutePath,
        relativePath,
        fileName: segmentFileName,
        displayName: path.basename(segmentFileName, '.wav'),
        modifiedAt: stats.mtimeMs,
        createdAt: Number.isNaN(stats.birthtimeMs) ? null : stats.birthtimeMs,
        size: stats.size,
        durationMs,
        sampleRate,
        bitDepth: bitDepthNumeric,
        checksum,
        tags: resolvedTags,
        categories: resolvedCategories,
        parentFileId: record.id
      });

      const resolvedCustomName = segment.metadata?.customName !== undefined
        ? this.normaliseMetadataInput(segment.metadata.customName)
        : segment.label !== undefined
          ? this.normaliseMetadataInput(segment.label)
          : record.customName ?? null;
      const updatedRecord = resolvedCustomName !== fileRecord.customName
        ? this.database.updateCustomName(fileRecord.id, resolvedCustomName ?? null)
        : fileRecord;

      const resolvedAuthor = segment.metadata?.author !== undefined
        ? this.normaliseMetadataInput(segment.metadata.author)
        : this.normaliseMetadataInput(originalMetadata.author ?? null);
      const resolvedRating = segment.metadata?.rating !== undefined
        ? segment.metadata.rating ?? undefined
        : originalMetadata.rating;

      this.tagService.writeMetadataOnly(segmentAbsolutePath, {
        tags: resolvedTags,
        categories: resolvedCategories,
        title: resolvedCustomName ?? updatedRecord.displayName,
        author: resolvedAuthor ?? undefined,
        rating: resolvedRating,
        copyright: originalMetadata.copyright ?? null,
        parentId: record.id
      });

      if (typeof resolvedAuthor === 'string' && resolvedAuthor.length > 0) {
        this.updateMetadataSuggestionsCache(resolvedAuthor);
      }

      this.clearWaveformCache(updatedRecord.id);
      created.push(updatedRecord);
    }

    this.clearWaveformCache(record.id);
    this.resetMetadataSuggestionsCache();
    this.search.rebuildIndex();

    return created;
  }

  /**
   * Applies the configured fade envelope to the provided channel data. Tries to render using
   * `standardized-audio-context` for consistency with the editor preview and falls back to
   * a manual smooth-step implementation if the dependency is unavailable at runtime.
   */
  private async applyFadeEnvelopeToSegment(
    source: Float64Array[],
    sampleRate: number,
    fadeInMs: number,
    fadeOutMs: number
  ): Promise<Float64Array[]> {
    if (source.length === 0 || source[0]?.length === 0) {
      return source.map((channel) => channel.slice());
    }

    const totalSamples = source[0].length;
    const fadeInSamples = Math.min(totalSamples, Math.max(0, Math.floor((fadeInMs / 1000) * sampleRate)));
    const fadeOutSamples = Math.min(totalSamples, Math.max(0, Math.floor((fadeOutMs / 1000) * sampleRate)));

    if (fadeInSamples === 0 && fadeOutSamples === 0) {
      return source.map((channel) => channel.slice());
    }

    const applyManual = (): Float64Array[] => {
      return source.map((channel) => {
        const copy = channel.slice();
        const sampleCount = copy.length;
        const fadeInDenominator = Math.max(1, fadeInSamples - 1);
        const fadeOutDenominator = Math.max(1, fadeOutSamples - 1);
        for (let index = 0; index < sampleCount; index += 1) {
          let gain = 1;
          if (fadeInSamples > 0 && index < fadeInSamples) {
            const t = fadeInDenominator > 0 ? index / fadeInDenominator : 0;
            const eased = this.smoothStep(t);
            gain = Math.min(gain, eased);
          }
          if (fadeOutSamples > 0) {
            const fromEnd = sampleCount - 1 - index;
            if (fromEnd < fadeOutSamples) {
              const t = fadeOutDenominator > 0 ? fromEnd / fadeOutDenominator : 0;
              const eased = this.smoothStep(t);
              gain = Math.min(gain, eased);
            }
          }
          copy[index] = copy[index] * gain;
        }
        return copy;
      });
    };

    try {
      let OfflineContextCtor = this.offlineAudioContextCtor;
      if (!OfflineContextCtor) {
        const audioModule = (await import('standardized-audio-context')) as {
          OfflineAudioContext?: new (channelCount: number, length: number, sampleRate: number) => any;
          default?: { OfflineAudioContext?: new (channelCount: number, length: number, sampleRate: number) => any };
        };
        const resolvedCtor = audioModule.OfflineAudioContext ?? audioModule.default?.OfflineAudioContext ?? null;
        if (typeof resolvedCtor !== 'function') {
          return applyManual();
        }
        this.offlineAudioContextCtor = resolvedCtor;
        OfflineContextCtor = resolvedCtor;
      }

      const channelCount = source.length;
      const offlineContext = new OfflineContextCtor(channelCount, totalSamples, sampleRate);
      const buffer = offlineContext.createBuffer(channelCount, totalSamples, sampleRate);
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channelData = buffer.getChannelData(channelIndex);
        const sourceChannel = source[channelIndex];
        for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += 1) {
          channelData[sampleIndex] = sourceChannel?.[sampleIndex] ?? 0;
        }
      }

      const bufferSource = offlineContext.createBufferSource();
      bufferSource.buffer = buffer;
      const gainNode = offlineContext.createGain();
      bufferSource.connect(gainNode);
      gainNode.connect(offlineContext.destination);

      const totalDurationSeconds = totalSamples / sampleRate;
      gainNode.gain.setValueAtTime(1, 0);

      if (fadeInSamples > 0) {
        const fadeInCurve = this.generateFadeCurve(Math.max(fadeInSamples, 2), 'in');
        gainNode.gain.setValueAtTime(fadeInCurve[0], 0);
        gainNode.gain.setValueCurveAtTime(fadeInCurve, 0, fadeInSamples / sampleRate);
        gainNode.gain.setValueAtTime(1, fadeInSamples / sampleRate);
      }

      if (fadeOutSamples > 0) {
        const fadeOutCurve = this.generateFadeCurve(Math.max(fadeOutSamples, 2), 'out');
        const fadeOutStart = Math.max(0, totalDurationSeconds - fadeOutSamples / sampleRate);
        gainNode.gain.setValueAtTime(1, fadeOutStart);
        gainNode.gain.setValueCurveAtTime(fadeOutCurve, fadeOutStart, fadeOutSamples / sampleRate);
        gainNode.gain.setValueAtTime(fadeOutCurve[fadeOutCurve.length - 1], totalDurationSeconds);
      }

      bufferSource.start(0);
      const renderedBuffer = await offlineContext.startRendering();
      const processed: Float64Array[] = [];
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const renderedChannel = renderedBuffer.getChannelData(channelIndex);
        const clone = new Float64Array(renderedChannel.length);
        clone.set(renderedChannel);
        processed.push(clone);
      }
      return processed;
    } catch (error) {
      console.warn('Falling back to manual fade processing', error);
      return applyManual();
    }
  }

  /**
   * Generates a smooth fade curve using a cubic smooth-step easing function.
   */
  private generateFadeCurve(sampleCount: number, direction: 'in' | 'out'): Float32Array {
    const totalSamples = Math.max(sampleCount, 2);
    const curve = new Float32Array(totalSamples);
    const lastIndex = totalSamples - 1;
    for (let index = 0; index < totalSamples; index += 1) {
      const t = lastIndex === 0 ? 1 : index / lastIndex;
      const eased = this.smoothStep(Math.min(Math.max(t, 0), 1));
      curve[index] = direction === 'in' ? eased : 1 - eased;
    }
    if (direction === 'in') {
      curve[0] = 0;
      curve[lastIndex] = 1;
    } else {
      curve[0] = 1;
      curve[lastIndex] = 0;
    }
    return curve;
  }

  /**
   * Computes the cubic smooth-step easing value for the provided normalised progress.
   */
  private smoothStep(t: number): number {
    const clamped = Math.min(Math.max(t, 0), 1);
    return clamped * clamped * (3 - 2 * clamped);
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
   * Reads embedded metadata from a WAV file and returns author, title, and rating.
   */
  public async readFileMetadata(fileId: number): Promise<{ author?: string; title?: string; rating?: number }> {
    const record = this.database.getFileById(fileId);
    const metadata = this.tagService.readMetadata(record.absolutePath);
    this.updateMetadataSuggestionsCache(metadata.author);
    return metadata;
  }

  /**
   * Updates metadata (author, rating) without organizing the file.
   * Only writes to the WAV INFO chunk, doesn't move or rename the file.
   */
  public async updateFileMetadata(fileId: number, metadata: { author?: string | null; rating?: number }): Promise<void> {
    const record = this.database.getFileById(fileId);
    
    // Read existing metadata from the WAV file
    const existing = this.tagService.readMetadata(record.absolutePath);
    
    // Merge with new metadata (only update fields that are provided)
    const requestedAuthor = this.normaliseMetadataInput(metadata.author);
    const mergedMetadata = {
      tags: record.tags,
      categories: record.categories,
      title: record.customName ?? existing.title,
      author: requestedAuthor !== undefined ? requestedAuthor : existing.author ?? null,
      rating: metadata.rating !== undefined ? metadata.rating : existing.rating,
      copyright: existing.copyright ?? null,
      parentId: record.parentFileId ?? null
    };
    
    // Write merged metadata to the WAV file
    this.tagService.writeMetadataOnly(record.absolutePath, mergedMetadata);

    // Update suggestions cache
    if (typeof mergedMetadata.author === 'string' && mergedMetadata.author.length > 0) {
      this.updateMetadataSuggestionsCache(mergedMetadata.author);
    }

    this.clearWaveformCache(fileId);
    this.resetMetadataSuggestionsCache();
  }

  /**
   * Returns distinct metadata suggestions aggregated from the library.
   */
  public async listMetadataSuggestions(): Promise<{ authors: string[] }> {
    if (!this.metadataSuggestionCache) {
      const authors = new Set<string>();
      const files = this.database.listFiles();

      for (const file of files) {
        try {
          const metadata = this.tagService.readMetadata(file.absolutePath);
          if (metadata.author) {
            this.addSuggestionValue(authors, metadata.author);
          }
        } catch (error) {
          if (!this.metadataFailures.has(file.absolutePath)) {
            this.metadataFailures.add(file.absolutePath);
            // eslint-disable-next-line no-console -- Provide visibility once per file for suggestion harvesting issues.
            console.warn(`Failed to collect metadata suggestions from ${file.absolutePath}`, error);
          }
        }
      }

      this.metadataSuggestionCache = { authors };
    }

    return {
      authors: Array.from(this.metadataSuggestionCache.authors).sort((a, b) => a.localeCompare(b))
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

  private updateMetadataSuggestionsCache(author?: string | null): void {
    if (!this.metadataSuggestionCache) {
      return;
    }
    if (author) {
      this.addSuggestionValue(this.metadataSuggestionCache.authors, author);
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
   * Gathers candidate audio files from the provided sources, handling both folders and individual files.
   */
  private async collectImportCandidates(sourcePaths: string[]): Promise<{
    files: string[];
    failures: ImportFailureEntry[];
  }> {
    const discovered = new Set<string>();
    const failures: ImportFailureEntry[] = [];
    const uniqueSources = Array.from(
      new Set((sourcePaths ?? []).map((entry) => entry?.trim()).filter((entry): entry is string => Boolean(entry)))
    );

    for (const rawSource of uniqueSources) {
      const absoluteSource = path.resolve(rawSource);
      try {
        const stats = await fs.stat(absoluteSource);
        if (stats.isDirectory()) {
          try {
            const matches = await fg(['**/*.wav', '**/*.wave'], {
              cwd: absoluteSource,
              absolute: true,
              onlyFiles: true,
              suppressErrors: true,
              caseSensitiveMatch: false
            });
            for (const match of matches) {
              discovered.add(path.resolve(match));
            }
          } catch (error) {
            failures.push({
              path: absoluteSource,
              message: error instanceof Error ? error.message : String(error)
            });
          }
        } else if (stats.isFile()) {
          discovered.add(absoluteSource);
        } else {
          failures.push({ path: absoluteSource, message: 'Unsupported file system entry.' });
        }
      } catch (error) {
        failures.push({
          path: absoluteSource,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const files = Array.from(discovered).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return { files, failures };
  }

  /**
   * Copies a single source file into the library and registers it in the database, returning the stored record.
   */
  private async copyAndRegisterImportedFile(options: {
    sourcePath: string;
    checksum: string;
    importFolderAbsolute: string;
    folderForJoin: string;
    libraryRoot: string;
    usedNames: Set<string>;
  }): Promise<AudioFileSummary> {
    const { sourcePath, checksum, importFolderAbsolute, folderForJoin, libraryRoot, usedNames } = options;
    const extension = path.extname(sourcePath);
    const baseName = path.basename(sourcePath, extension);
    let sanitizedBase = this.organization.sanitizeCustomName(baseName);
    if (!sanitizedBase) {
      sanitizedBase = 'Imported';
    }

    let attempt = 0;
    let candidateName: string = '';
    let candidateAbsolutePath: string = '';
    while (true) {
      if (attempt === 0) {
        candidateName = this.normaliseFileName(`${sanitizedBase}.wav`);
      } else {
        const suffix = this.organization.formatSequenceNumber(attempt);
        candidateName = this.normaliseFileName(`${sanitizedBase}_${suffix}.wav`);
      }

      if (!usedNames.has(candidateName)) {
        candidateAbsolutePath = path.join(importFolderAbsolute, candidateName);
        const exists = await this.pathExists(candidateAbsolutePath);
        if (!exists) {
          break;
        }
      }

      attempt += 1;
      if (attempt > 9999) {
        throw new Error('Unable to allocate a unique filename for the imported file.');
      }
    }

    usedNames.add(candidateName);
    this.assertWithinLibrary(libraryRoot, candidateAbsolutePath);

    await fs.copyFile(sourcePath, candidateAbsolutePath);

    try {
      const stats = await fs.stat(candidateAbsolutePath);
      const metadata = await this.extractAudioMetadata(candidateAbsolutePath);
      const relativePath = this.toLibraryRelativePath(folderForJoin, candidateName);
      const record = this.database.upsertFile({
        absolutePath: candidateAbsolutePath,
        relativePath,
        fileName: candidateName,
        displayName: path.basename(candidateName, path.extname(candidateName)),
        modifiedAt: stats.mtimeMs,
        createdAt: Number.isNaN(stats.birthtimeMs) ? null : stats.birthtimeMs,
        size: stats.size,
        durationMs: metadata.durationMs,
        sampleRate: metadata.sampleRate,
        bitDepth: metadata.bitDepth,
        checksum,
        tags: metadata.tags,
        categories: metadata.categories
      });

      try {
        const embedded = this.tagService.readMetadata(candidateAbsolutePath);
        this.updateMetadataSuggestionsCache(embedded.author ?? null);
      } catch (metadataError) {
        // eslint-disable-next-line no-console -- Import should continue even if metadata read fails.
        console.warn('Failed to read metadata from imported file', metadataError);
      }

      return record;
    } catch (error) {
      await fs.rm(candidateAbsolutePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Resolves and caches the music-metadata parseFile implementation.
   */
  private async resolveMusicMetadataParser(): Promise<MusicMetadataParser> {
    if (this.musicMetadataParseFile) {
      return this.musicMetadataParseFile;
    }

    const namespace = (await import('music-metadata')) as MusicMetadataNamespace;
    const candidate = typeof namespace.parseFile === 'function'
      ? namespace.parseFile
      : namespace.default && typeof namespace.default.parseFile === 'function'
        ? namespace.default.parseFile
        : null;

    if (!candidate) {
      throw new Error('music-metadata parseFile not found');
    }

    this.musicMetadataParseFile = candidate;
    return candidate;
  }

  /**
   * Helper to clear both memory and database waveform cache.
   */
  private clearWaveformCache(fileId: number): void {
    this.waveformPreviewCache.delete(fileId);
    this.database.clearWaveformCache(fileId);
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
      const parseFile = await this.resolveMusicMetadataParser();
      const metadata = await parseFile(filePath, { duration: true });
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
   * Uses streaming approach to handle large files efficiently.
   */
  private async computeFileChecksum(filePath: string): Promise<string | null> {
    try {
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;
      
      // For files larger than 100MB, use chunked streaming to avoid memory issues
      if (fileSize > 100 * 1024 * 1024) {
        return await this.computeFileChecksumStreaming(filePath);
      }
      
      // For smaller files, use the existing fast method
      const buffer = await fs.readFile(filePath);
      const wave = new WaveFile(buffer);
      
      const hash = createHash('md5');
      const samples = wave.getSamples();
      
      if (Array.isArray(samples)) {
        for (const channel of samples) {
          hash.update(Buffer.from(channel.buffer));
        }
      } else {
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
   * Computes checksum using streaming for large files.
   * Reads WAV header to locate data chunk, then streams only the audio data.
   */
  private async computeFileChecksumStreaming(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('md5');
      const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 }); // 64KB chunks
      
      let headerProcessed = false;
      let dataChunkStart = 0;
      let dataChunkSize = 0;
      let bytesRead = 0;
      let buffer = Buffer.alloc(0);

      stream.on('data', (chunk: string | Buffer) => {
        const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        buffer = Buffer.concat([buffer, bufferChunk]);
        bytesRead += bufferChunk.length;

        if (!headerProcessed && buffer.length >= 44) {
          // Parse minimal WAV header to find data chunk
          // RIFF header: "RIFF" (4) + fileSize (4) + "WAVE" (4) = 12 bytes
          // fmt chunk: "fmt " (4) + size (4) + format data (usually 16) = 24+ bytes
          // data chunk: "data" (4) + size (4) + audio data
          
          let offset = 12; // Skip RIFF header
          while (offset + 8 <= buffer.length) {
            const chunkId = buffer.toString('ascii', offset, offset + 4);
            const chunkSize = buffer.readUInt32LE(offset + 4);
            
            if (chunkId === 'data') {
              dataChunkStart = offset + 8;
              dataChunkSize = chunkSize;
              headerProcessed = true;
              
              // Hash any data chunk content we've already read
              const availableData = buffer.length - dataChunkStart;
              if (availableData > 0) {
                const dataToHash = buffer.subarray(dataChunkStart, Math.min(buffer.length, dataChunkStart + dataChunkSize));
                hash.update(dataToHash);
              }
              
              // Clear buffer to free memory
              buffer = Buffer.alloc(0);
              break;
            }
            
            offset += 8 + chunkSize;
            if (chunkSize % 2 === 1) offset++; // WAV chunks are word-aligned
          }
        } else if (headerProcessed) {
          // We're in the data chunk, hash everything
          hash.update(bufferChunk);
          buffer = Buffer.alloc(0); // Clear buffer to free memory
        }
      });

      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });

      stream.on('error', (error) => {
        reject(error);
      });
    });
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
