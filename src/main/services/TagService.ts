import fs from 'node:fs';
import { WaveFile } from 'wavefile';
import { AudioFileSummary } from '../../shared/models';
import { DatabaseService } from './DatabaseService';

/**
 * Coordinates tag persistence between the database and embedded WAV metadata.
 */
export class TagService {
  public constructor(private readonly database: DatabaseService) {}

  /**
   * Applies category updates (and optional tag overrides) then embeds metadata into the WAV container.
   * Preserves existing author, title, and rating fields.
   */
  public applyTagging(fileId: number, tags: string[] | undefined, categories: string[]): AudioFileSummary {
    const normalisedCategories = this.normaliseValues(categories);
    const normalisedTags = Array.isArray(tags) ? this.normaliseValues(tags) : undefined;
    const updated = this.database.updateTagging(fileId, normalisedTags, normalisedCategories);
    
    // Read existing metadata to preserve author, title, and rating
    const existing = this.readMetadata(updated.absolutePath);
    
    this.writeWaveMetadata(updated.absolutePath, {
  tags: normalisedTags ?? updated.tags,
  categories: normalisedCategories,
      title: existing.title,
      author: existing.author,
      rating: existing.rating,
      copyright: existing.copyright,
      parentId: existing.parentId ?? updated.parentFileId ?? null
    });
    return updated;
  }

  /**
   * Normalises incoming arrays by trimming whitespace, removing empties, and deduplicating.
   */
  private normaliseValues(values: string[]): string[] {
    const result = new Set<string>();
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        result.add(trimmed);
      }
    }
    return Array.from(result);
  }

  /**
   * Reads embedded metadata from a WAV file.
   */
  public readMetadata(filePath: string): {
    author?: string;
    title?: string;
    rating?: number;
    copyright?: string;
    parentId?: number;
  } {
    try {
      const buffer = fs.readFileSync(filePath);
      const wave = new WaveFile(buffer);
      const tags = this.extractInfoTagMap(wave);
      
      // Read from individual fields
      const title = tags.INAM?.trim() || undefined;
      const author = tags.IART?.trim() || undefined;
      const copyright = tags.ICOP?.trim() || undefined;
      
      const ratingValue = tags.IRTD ? Number.parseInt(tags.IRTD, 10) : undefined;
      let rating: number | undefined;
      if (typeof ratingValue === 'number' && Number.isFinite(ratingValue)) {
        rating = Math.floor(ratingValue / 2);
      }
      
      // Try to read parentId from JSON comment
      let parentId: number | undefined;
      const comment = tags.ICMT?.trim();
      if (comment) {
        try {
          const parsed = JSON.parse(comment);
          if (parsed && typeof parsed.parentId === 'number') {
            parentId = parsed.parentId;
          }
        } catch {
          // Not JSON, ignore
        }
      }
      
      // Fallback to IPAR field if no JSON parentId
      if (parentId === undefined) {
        const parentRaw = tags.IPAR?.trim();
        if (parentRaw && parentRaw.length > 0) {
          const parsedNum = Number.parseInt(parentRaw, 10);
          if (Number.isFinite(parsedNum)) {
            parentId = parsedNum;
          }
        }
      }

      return {
        author,
        title,
        rating,
        copyright,
        parentId
      };
    } catch (error) {
      // eslint-disable-next-line no-console -- Logging to devtools console is helpful for diagnosis.
      console.warn('Failed to read WAV metadata', error);
      return {};
    }
  }

  /**
   * Writes tags and categories to an organized file as embedded metadata.
   * All metadata fields are required to prevent accidental clearing.
   */
  public writeMetadataOnly(
    filePath: string,
    metadata: {
      tags: string[];
      categories: string[];
      title?: string | null;
      author?: string | null;
      rating?: number;
      copyright?: string | null;
      parentId?: number | null;
    }
  ): void {
    this.writeWaveMetadata(filePath, metadata);
  }

  /**
   * Writes a simple INFO chunk with the provided metadata. Failures are swallowed so DB state remains authoritative.
   * All metadata fields must be explicitly provided to prevent accidental data loss.
   */
  private writeWaveMetadata(
    filePath: string,
    metadata: {
      tags: string[];
      categories: string[];
      title?: string | null;
      author?: string | null;
      rating?: number;
      copyright?: string | null;
      parentId?: number | null;
    }
  ): void {
    try {
      const buffer = fs.readFileSync(filePath);
      const wave = new WaveFile(buffer);
      const waveWithInfo = wave as WaveFile & {
        setTag?: (tag: string, value: string) => void;
        listInfoTags?: Record<string, string>;
      };

      const tagValuesList = (metadata.tags ?? [])
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const categoryValuesList = (metadata.categories ?? [])
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      const tagText = tagValuesList.length > 0 ? tagValuesList.join('; ') : null;
      const categoryText = categoryValuesList.length > 0 ? categoryValuesList.join('; ') : null;
      const primaryCategory = categoryValuesList.at(0) ?? null;
      const trimmedTitle = metadata.title?.toString().trim();
      const effectiveTitle = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : null;
      const trimmedAuthor = metadata.author?.toString().trim();
      const effectiveAuthor = trimmedAuthor && trimmedAuthor.length > 0 ? trimmedAuthor : null;
      const trimmedCopyright = metadata.copyright?.toString().trim();
      const effectiveCopyright = trimmedCopyright && trimmedCopyright.length > 0 ? trimmedCopyright : null;
      const parentText = metadata.parentId !== undefined && metadata.parentId !== null
        ? String(metadata.parentId)
        : null;
      const commentPayload = {
        parentId: metadata.parentId ?? null
      } satisfies Record<string, unknown>;
      const commentText = JSON.stringify(commentPayload);

      const tagValues: Record<string, string | null> = {
        IKEY: tagText,
  ICMT: commentText,
        ISBJ: categoryText,
        ISUB: primaryCategory,
        IGNR: null,
        INAM: effectiveTitle,
        IART: effectiveAuthor,
        IRTD: metadata.rating && metadata.rating > 0 ? String(metadata.rating * 2) : null,
        ICOP: effectiveCopyright,
        IPAR: parentText,
        ISFT: 'AudioSort'
      };

      this.applyInfoTags(waveWithInfo, tagValues);

      const updatedBuffer = wave.toBuffer();
      fs.writeFileSync(filePath, updatedBuffer);

      console.log(`Wrote metadata to ${filePath}:`, {
        comment: commentText,
        categories: metadata.categories.join(', '),
        title: effectiveTitle,
        author: effectiveAuthor,
        copyright: effectiveCopyright,
        rating: metadata.rating,
        parentId: metadata.parentId ?? null
      });
    } catch (error) {
      // eslint-disable-next-line no-console -- Logging to devtools console is helpful for diagnosis.
      console.warn('Failed to write WAV metadata', error);
    }
  }

  /**
   * Returns the INFO chunk tag map for low-level metadata consumers.
   */
  public readInfoTags(filePath: string): Partial<Record<string, string>> {
    try {
      const buffer = fs.readFileSync(filePath);
      const wave = new WaveFile(buffer);
      return this.extractInfoTagMap(wave);
    } catch (error) {
      // eslint-disable-next-line no-console -- Metadata parsing failures are non-fatal.
      console.warn('Failed to read WAV info tags', error);
      return {};
    }
  }

  /**
   * Applies INFO chunk updates, clearing values when the metadata source is empty.
   */
  private applyInfoTags(
    wave: WaveFile & { setTag?: (tag: string, value: string) => void; listInfoTags?: Record<string, string> },
    entries: Record<string, string | null>
  ): void {
    const listInfo = wave.listInfoTags ?? null;
    for (const [key, value] of Object.entries(entries)) {
      const normalised = value ?? '';
      if (typeof wave.setTag === 'function') {
        wave.setTag(key, normalised);
      }
      if (listInfo) {
        if (normalised.length === 0) {
          delete listInfo[key];
        } else {
          listInfo[key] = normalised;
        }
      }
    }
  }

  /**
   * Extracts INFO chunk entries from a WaveFile instance.
   */
  private extractInfoTagMap(wave: WaveFile): Partial<Record<string, string>> {
    const waveWithTags = wave as WaveFile & {
      listTags?: () => Record<string, string>;
      LIST?: Array<{ format: string; subChunks: Array<{ chunkId: string; value: string }> }>;
    };

    if (typeof waveWithTags.listTags === 'function') {
      return waveWithTags.listTags() as Record<string, string>;
    }

    if (Array.isArray(waveWithTags.LIST)) {
      const listEntries = waveWithTags.LIST as Array<{
        format: string;
        subChunks: Array<{ chunkId: string; value: string }>;
      }>;
      const infoChunk = listEntries.find((entry) => entry.format === 'INFO');
      if (infoChunk) {
        return infoChunk.subChunks.reduce<Record<string, string>>((acc, chunk) => {
          acc[chunk.chunkId] = chunk.value;
          return acc;
        }, {} as Record<string, string>);
      }
    }

    return {};
  }
}
