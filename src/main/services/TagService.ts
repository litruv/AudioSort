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
   * Applies tags and categories to a file record and embeds the metadata into the WAV container.
   */
  public applyTagging(fileId: number, tags: string[], categories: string[]): AudioFileSummary {
    const normalisedTags = this.normaliseValues(tags);
    const normalisedCategories = this.normaliseValues(categories);
    const updated = this.database.updateTagging(fileId, normalisedTags, normalisedCategories);
    this.writeWaveMetadata(updated.absolutePath, {
      tags: normalisedTags,
      categories: normalisedCategories
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
    copyright?: string;
    title?: string;
    rating?: number;
  } {
    try {
      const buffer = fs.readFileSync(filePath);
      const wave = new WaveFile(buffer);
      const tags = this.extractInfoTagMap(wave);
      const ratingValue = tags.IRTD ? Number.parseInt(tags.IRTD, 10) : undefined;
      let rating: number | undefined;
      if (typeof ratingValue === 'number' && Number.isFinite(ratingValue)) {
        rating = Math.floor(ratingValue / 2);
      }

      return {
        author: tags.IART?.trim() || undefined,
        copyright: tags.ICOP?.trim() || undefined,
        title: tags.INAM?.trim() || undefined,
        rating
      };
    } catch (error) {
      // eslint-disable-next-line no-console -- Logging to devtools console is helpful for diagnosis.
      console.warn('Failed to read WAV metadata', error);
      return {};
    }
  }

  /**
   * Writes tags and categories to an organized file as embedded metadata.
   */
  public writeMetadataOnly(
    filePath: string,
    metadata: {
      tags: string[];
      categories: string[];
  title?: string | null;
  author?: string | null;
  copyright?: string | null;
      rating?: number;
    }
  ): void {
    this.writeWaveMetadata(filePath, metadata);
  }

  /**
   * Writes a simple INFO chunk with the provided metadata. Failures are swallowed so DB state remains authoritative.
   */
  private writeWaveMetadata(
    filePath: string,
    metadata: {
      tags: string[];
      categories: string[];
  title?: string | null;
  author?: string | null;
  copyright?: string | null;
      rating?: number;
    }
  ): void {
    try {
      const buffer = fs.readFileSync(filePath);
      const wave = new WaveFile(buffer);
      const waveWithInfo = wave as WaveFile & {
        setTag?: (tag: string, value: string) => void;
        listInfoTags?: Record<string, string>;
      };

      const tagValuesList = metadata.tags.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      const categoryValuesList = metadata.categories.map((entry) => entry.trim()).filter((entry) => entry.length > 0);

      const tagText = tagValuesList.length > 0 ? tagValuesList.join('; ') : null;
      const categoryText = categoryValuesList.length > 0 ? categoryValuesList.join('; ') : null;
      const primaryCategory = categoryValuesList.at(0) ?? null;

      const tagValues: Record<string, string | null> = {
        IKEY: tagText,
        ICMT: tagText,
        ISBJ: categoryText,
        ISUB: primaryCategory,
        IGNR: null,
        INAM: metadata.title?.trim()?.length ? metadata.title.trim() : null,
        IART: metadata.author?.trim()?.length ? metadata.author.trim() : null,
        ICOP: metadata.copyright?.trim()?.length ? metadata.copyright.trim() : null,
        IRTD: metadata.rating && metadata.rating > 0 ? String(metadata.rating * 2) : null,
        ISFT: 'AudioSort'
      };

      this.applyInfoTags(waveWithInfo, tagValues);

      const updatedBuffer = wave.toBuffer();
      fs.writeFileSync(filePath, updatedBuffer);

      console.log(`Wrote metadata to ${filePath}:`, {
        tags: metadata.tags.join(', '),
        categories: metadata.categories.join(', '),
        title: metadata.title,
        author: metadata.author,
        copyright: metadata.copyright,
        rating: metadata.rating
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
