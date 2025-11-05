import Fuse from 'fuse.js';
import { AudioFileSummary } from '../../shared/models';
import { DatabaseService } from './DatabaseService';
import { TagService } from './TagService';

/**
 * Lightweight snapshot of metadata required for advanced search filters.
 */
interface CachedMetadata {
  author?: string;
  copyright?: string;
}

/**
 * Represents a structured filter derived from the freeform query.
 */
interface AdvancedFilter {
  field: 'author' | 'copyright';
  value: string;
}

/**
 * Provides fuzzy search capabilities backed by Fuse.js and the database content.
 */
export class SearchService {
  private fuse: Fuse<AudioFileSummary> | null = null;
  private cache: AudioFileSummary[] = [];
  private readonly metadataCache = new Map<number, CachedMetadata>();

  public constructor(
    private readonly database: DatabaseService,
    private readonly tagService: TagService
  ) {}

  /**
   * Rebuilds the in-memory index from the current database contents.
   */
  public rebuildIndex(): void {
    this.cache = this.database.listFiles();
    this.metadataCache.clear();
    this.fuse = new Fuse(this.cache, {
      includeScore: true,
      threshold: 0.35,
      keys: [
        { name: 'displayName', weight: 0.3 },
        { name: 'fileName', weight: 0.2 },
        { name: 'relativePath', weight: 0.2 },
        { name: 'tags', weight: 0.2 },
        { name: 'categories', weight: 0.1 }
      ]
    });
  }

  /**
   * Executes a fuzzy search query, falling back to the full collection when the input is empty.
   */
  public search(query: string): AudioFileSummary[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return this.getAll();
    }

    const { filters, remainingQuery } = this.extractAdvancedFilters(trimmed);
    let candidates = this.getAll();

    if (filters.length > 0) {
      candidates = candidates.filter((file) => this.matchesAdvancedFilters(file, filters));
    }

    if (remainingQuery.length === 0) {
      return candidates;
    }

    const fuseInstance = filters.length > 0
      ? new Fuse(candidates, this.createFuseOptions())
      : this.ensureFuse();

    return fuseInstance
      .search(remainingQuery)
      .map((result: Fuse.FuseResult<AudioFileSummary>) => result.item)
      .filter((file) => (filters.length === 0 ? true : this.matchesAdvancedFilters(file, filters)));
  }

  /**
   * Provides the cached collection, lazily rebuilding the index on first access.
   */
  public getAll(): AudioFileSummary[] {
    if (this.cache.length === 0) {
      this.rebuildIndex();
    }
    return this.cache;
  }

  /**
   * Ensures a Fuse instance is available, recreating it when the cache is stale.
   */
  private ensureFuse(): Fuse<AudioFileSummary> {
    if (!this.fuse) {
      this.rebuildIndex();
    }
    return this.fuse ?? new Fuse(this.getAll(), this.createFuseOptions());
  }

  /**
   * Provides the standard Fuse configuration used by the service.
   */
  private createFuseOptions(): Fuse.IFuseOptions<AudioFileSummary> {
    return {
      includeScore: true,
      threshold: 0.35,
      keys: [
        { name: 'displayName', weight: 0.3 },
        { name: 'fileName', weight: 0.2 },
        { name: 'relativePath', weight: 0.2 },
        { name: 'tags', weight: 0.2 },
        { name: 'categories', weight: 0.1 }
      ]
    } satisfies Fuse.IFuseOptions<AudioFileSummary>;
  }

  /**
   * Pulls out author/copyright filters and returns the remaining free text query.
   */
  private extractAdvancedFilters(query: string): { filters: AdvancedFilter[]; remainingQuery: string } {
    const tokens = query.split(/\s+/);
    const filters: AdvancedFilter[] = [];
    const remainingTokens: string[] = [];

    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower.startsWith('author:')) {
        const value = token.slice('author:'.length).trim();
        if (value.length > 0) {
          filters.push({ field: 'author', value: value.toLowerCase() });
        }
        continue;
      }
      if (lower.startsWith('copyright:')) {
        const value = token.slice('copyright:'.length).trim();
        if (value.length > 0) {
          filters.push({ field: 'copyright', value: value.toLowerCase() });
        }
        continue;
      }
      remainingTokens.push(token);
    }

    return {
      filters,
      remainingQuery: remainingTokens.join(' ').trim()
    };
  }

  /**
   * Evaluates whether a file satisfies all extracted advanced filters.
   */
  private matchesAdvancedFilters(file: AudioFileSummary, filters: AdvancedFilter[]): boolean {
    if (filters.length === 0) {
      return true;
    }

    const metadata = this.getCachedMetadata(file);
    return filters.every((filter) => {
      const source = filter.field === 'author' ? metadata.author : metadata.copyright;
      if (!source) {
        return false;
      }
      return source.toLowerCase().includes(filter.value);
    });
  }

  /**
   * Reads metadata once per file and caches it for reuse across searches in the same session.
   */
  private getCachedMetadata(file: AudioFileSummary): CachedMetadata {
    const cached = this.metadataCache.get(file.id);
    if (cached) {
      return cached;
    }

    const metadata = this.tagService.readMetadata(file.absolutePath);
    const normalized: CachedMetadata = {
      author: metadata.author?.trim() || undefined,
      copyright: metadata.copyright?.trim() || undefined
    };
    this.metadataCache.set(file.id, normalized);
    return normalized;
  }
}
