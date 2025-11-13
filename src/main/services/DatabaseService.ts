/**
 * Thin wrapper around better-sqlite3 providing schema setup and helpers used by the main process services.
 */
import Database, { Database as BetterSqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { AppSettings, AudioFileSummary, CategoryRecord } from '../../shared/models';

export interface FileRecordInput {
  /** Absolute filesystem path. */
  absolutePath: string;
  /** Relative path inside the library root. */
  relativePath: string;
  /** Filename including extension. */
  fileName: string;
  /** Display name without extension. */
  displayName: string;
  /** Unix epoch milliseconds. */
  modifiedAt: number;
  /** File creation time if available. */
  createdAt: number | null;
  /** File size in bytes. */
  size: number;
  /** Duration in milliseconds if known. */
  durationMs: number | null;
  /** Sample rate in Hz if known. */
  sampleRate: number | null;
  /** Bit depth if known. */
  bitDepth: number | null;
  /** MD5 checksum of the file contents. */
  checksum: string | null;
  /** Optional tag payload (stored as JSON string). */
  tags?: string[];
  /** Optional category payload (stored as JSON string). */
  categories?: string[];
  /** Optional parent file reference when generated from another file. */
  parentFileId?: number | null;
}

export interface FileRecordRow extends AudioFileSummary {}

type DbRow = Record<string, unknown>;

/**
 * Handles persistence for files, categories, and settings.
 */
export class DatabaseService {
  private db: BetterSqliteDatabase | null = null;

  public constructor(private readonly dbFilePath: string) {}

  /**
   * Opens the database connection (creating the file if necessary) and ensures the schema exists.
   */
  public initialize(): void {
    const folder = path.dirname(this.dbFilePath);
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
    this.db = new Database(this.dbFilePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.applySchema();
  }

  /**
   * Closes the active database connection.
   */
  public close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Persists or updates a file row and returns the stored record.
   * @param record File description to persist.
   */
  public upsertFile(record: FileRecordInput): FileRecordRow {
    const connection = this.requireDb();
    const statement = connection.prepare(
      `INSERT INTO files (
        absolute_path,
        library_relative_path,
        file_name,
        display_name,
        modified_at,
        created_at,
        size_bytes,
        duration_ms,
        sample_rate,
        bit_depth,
        checksum,
        tags_json,
        categories_json,
        parent_file_id
      ) VALUES (
        @absolutePath,
        @relativePath,
        @fileName,
        @displayName,
        @modifiedAt,
        @createdAt,
        @size,
        @durationMs,
        @sampleRate,
        @bitDepth,
        @checksum,
        @tagsJson,
        @categoriesJson,
        @parentFileId
      )
      ON CONFLICT(absolute_path) DO UPDATE SET
        library_relative_path = excluded.library_relative_path,
        file_name = excluded.file_name,
        display_name = excluded.display_name,
        modified_at = excluded.modified_at,
        created_at = COALESCE(files.created_at, excluded.created_at),
        size_bytes = excluded.size_bytes,
        duration_ms = excluded.duration_ms,
        sample_rate = excluded.sample_rate,
        bit_depth = excluded.bit_depth,
        checksum = excluded.checksum,
        tags_json = CASE WHEN files.tags_json = '[]' THEN excluded.tags_json ELSE files.tags_json END,
        categories_json = CASE WHEN files.categories_json = '[]' THEN excluded.categories_json ELSE files.categories_json END,
        parent_file_id = CASE WHEN excluded.parent_file_id IS NOT NULL THEN excluded.parent_file_id ELSE files.parent_file_id END
      RETURNING *`
    );

    const row = statement.get({
      absolutePath: record.absolutePath,
      relativePath: record.relativePath,
      fileName: record.fileName,
      displayName: record.displayName,
      modifiedAt: record.modifiedAt,
  createdAt: record.createdAt,
      size: record.size,
      durationMs: record.durationMs,
      sampleRate: record.sampleRate,
      bitDepth: record.bitDepth,
      checksum: record.checksum,
      tagsJson: JSON.stringify(record.tags ?? []),
      categoriesJson: JSON.stringify(record.categories ?? []),
      parentFileId: record.parentFileId ?? null
    }) as DbRow | undefined;

    if (!row) {
      throw new Error('Failed to persist file record.');
    }

    return this.mapFileRow(row);
  }

  /**
   * Updates the stored tags and/or categories for a file.
   * When a field is omitted it remains unchanged.
   */
  public updateTagging(fileId: number, tags?: string[], categories?: string[]): AudioFileSummary {
    const connection = this.requireDb();
    const updates: string[] = [];
    const parameters: Record<string, unknown> = { id: fileId };

    if (tags !== undefined) {
      updates.push('tags_json = @tags');
      parameters.tags = JSON.stringify(tags);
    }

    if (categories !== undefined) {
      updates.push('categories_json = @categories');
      parameters.categories = JSON.stringify(categories);
    }

    if (updates.length === 0) {
      return this.getFileById(fileId);
    }

    const statement = connection.prepare(
      `UPDATE files
         SET ${updates.join(', ')}
       WHERE id = @id
       RETURNING *`
    );
    const row = statement.get(parameters) as DbRow | undefined;
    if (!row) {
      throw new Error(`File with id ${fileId} not found`);
    }
    return this.mapFileRow(row);
  }

  /**
   * Updates the custom name for a file.
   */
  public updateCustomName(fileId: number, customName: string | null): AudioFileSummary {
    const connection = this.requireDb();
    const statement = connection.prepare(
      `UPDATE files
         SET custom_name = @customName
       WHERE id = @id
       RETURNING *`
    );
    const row = statement.get({
      id: fileId,
      customName
    }) as DbRow | undefined;
    if (!row) {
      throw new Error(`File with id ${fileId} not found`);
    }
    return this.mapFileRow(row);
  }

  /**
   * Returns a single file row by id.
   */
  public getFileById(fileId: number): AudioFileSummary {
    const row = this.requireDb()
      .prepare('SELECT * FROM files WHERE id = ?')
      .get(fileId) as DbRow | undefined;
    if (!row) {
      throw new Error(`File with id ${fileId} not found`);
    }
    return this.mapFileRow(row);
  }

  /**
   * Lists all audio files currently known to the database.
   */
  public listFiles(): AudioFileSummary[] {
    const rows = this.requireDb()
      .prepare('SELECT * FROM files ORDER BY display_name COLLATE NOCASE ASC')
      .all() as DbRow[];
    return rows.map((row) => this.mapFileRow(row));
  }

  /**
   * Deletes a file record permanently.
   */
  public deleteFile(fileId: number): void {
    const statement = this.requireDb().prepare('DELETE FROM files WHERE id = ?');
    statement.run(fileId);
  }

  /**
   * Returns groups of files that share the same checksum.
   */
  public listDuplicateGroups(): { checksum: string; files: AudioFileSummary[] }[] {
    const connection = this.requireDb();
    const checksumRows = connection
      .prepare(`
        SELECT checksum
        FROM files
        WHERE checksum IS NOT NULL AND checksum <> ''
        GROUP BY checksum
        HAVING COUNT(*) > 1
      `)
      .all() as Array<{ checksum: string }>;

    const fileQuery = connection.prepare('SELECT * FROM files WHERE checksum = ? ORDER BY created_at ASC, modified_at ASC');
    return checksumRows.map((row) => ({
      checksum: row.checksum,
      files: (fileQuery.all(row.checksum) as DbRow[]).map((fileRow) => this.mapFileRow(fileRow))
    }));
  }

  /**
   * Deletes file records whose absolute path is not part of the provided set.
   * @param validPathsSet Set of absolute paths that should remain in the database.
   * @returns Number of removed rows.
   */
  public removeFilesOutside(validPathsSet: Set<string>): number {
    const connection = this.requireDb();
  const rows = connection.prepare('SELECT id, absolute_path FROM files').all() as DbRow[];
    let removed = 0;
    const deleteStatement = connection.prepare('DELETE FROM files WHERE id = ?');
    for (const row of rows) {
      const absolutePath = row.absolute_path as string | undefined;
      const id = row.id as number | undefined;
      if (!absolutePath || typeof id !== 'number') {
        continue;
      }
      if (!validPathsSet.has(absolutePath)) {
        deleteStatement.run(id);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Updates file path and naming metadata after a rename or move operation.
   */
  public updateFileLocation(
    fileId: number,
    absolutePath: string,
    relativePath: string,
    fileName: string,
    displayName: string
  ): AudioFileSummary {
    const row = this.requireDb()
      .prepare(
        `UPDATE files
           SET absolute_path = @absolutePath,
               library_relative_path = @relativePath,
               file_name = @fileName,
               display_name = @displayName
         WHERE id = @id
         RETURNING *`
      )
      .get({ id: fileId, absolutePath, relativePath, fileName, displayName }) as DbRow | undefined;
    if (!row) {
      throw new Error(`File with id ${fileId} not found`);
    }
    return this.mapFileRow(row);
  }

  /**
   * Retrieves application settings as a typed object.
   */
  public getSettings(): AppSettings {
    const connection = this.requireDb();
    const rows = connection.prepare('SELECT key, value FROM settings').all() as DbRow[];
    const map = new Map<string, string>();
    for (const row of rows) {
      const key = row.key as string | undefined;
      const value = row.value as string | undefined;
      if (key && typeof value === 'string') {
        map.set(key, value);
      }
    }
    return {
      libraryPath: map.has('libraryPath') ? (JSON.parse(map.get('libraryPath') as string) as string) : null
    };
  }

  /**
   * Persists a single setting key.
   */
  public setSetting(key: string, value: unknown): void {
    this.requireDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run({ key, value: JSON.stringify(value) });
  }

  /**
   * Inserts or updates a UCS category record.
   */
  public upsertCategory(category: CategoryRecord): void {
    this.requireDb()
      .prepare(
        `INSERT INTO categories (
           id,
           category,
           sub_category,
           short_code,
           explanation,
           synonyms_json
         ) VALUES (@id, @category, @subCategory, @shortCode, @explanation, @synonyms)
         ON CONFLICT(id) DO UPDATE SET
           category = excluded.category,
           sub_category = excluded.sub_category,
           short_code = excluded.short_code,
           explanation = excluded.explanation,
           synonyms_json = excluded.synonyms_json`
      )
      .run({
        id: category.id,
        category: category.category,
        subCategory: category.subCategory,
        shortCode: category.shortCode,
        explanation: category.explanation,
        synonyms: JSON.stringify(category.synonyms)
      });
  }

  /**
   * Returns the full catalog of UCS categories.
   */
  public listCategories(): CategoryRecord[] {
    const rows = this.requireDb()
      .prepare('SELECT * FROM categories ORDER BY category, sub_category')
      .all() as DbRow[];
    return rows.map((row) => ({
      id: row.id as string,
      category: row.category as string,
      subCategory: row.sub_category as string,
      shortCode: row.short_code as string,
      explanation: row.explanation as string,
      synonyms: this.parseJsonArray(row.synonyms_json)
    }));
  }

  /**
   * Retrieves a category by its CatID.
   */
  public getCategoryById(catId: string): CategoryRecord | null {
    const row = this.requireDb()
      .prepare('SELECT * FROM categories WHERE id = ?')
      .get(catId) as DbRow | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id as string,
      category: row.category as string,
      subCategory: row.sub_category as string,
      shortCode: row.short_code as string,
      explanation: row.explanation as string,
      synonyms: this.parseJsonArray(row.synonyms_json)
    };
  }

  /**
   * Gets cached waveform data for a file.
   */
  public getWaveformCache(fileId: number, pointCount: number): { samples: number[]; rms: number } | null {
    const connection = this.requireDb();
    const row = connection
      .prepare('SELECT waveform_cache FROM files WHERE id = ?')
      .get(fileId) as { waveform_cache: string | null } | undefined;
    
    if (!row || !row.waveform_cache) {
      return null;
    }
    
    try {
      const parsed = JSON.parse(row.waveform_cache) as { pointCount: number; samples: number[]; rms: number };
      if (parsed.pointCount === pointCount) {
        return { samples: parsed.samples, rms: parsed.rms };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Sets cached waveform data for a file.
   */
  public setWaveformCache(fileId: number, pointCount: number, samples: number[], rms: number): void {
    const connection = this.requireDb();
    const cacheData = JSON.stringify({ pointCount, samples, rms });
    connection
      .prepare('UPDATE files SET waveform_cache = ? WHERE id = ?')
      .run(cacheData, fileId);
  }

  /**
   * Clears waveform cache for a specific file.
   */
  public clearWaveformCache(fileId: number): void {
    const connection = this.requireDb();
    connection
      .prepare('UPDATE files SET waveform_cache = NULL WHERE id = ?')
      .run(fileId);
  }

  /**
   * Maps a raw database row to the strongly typed summary shape.
   */
  private mapFileRow(row: DbRow): AudioFileSummary {
    return {
      id: row.id as number,
      absolutePath: row.absolute_path as string,
      relativePath: row.library_relative_path as string,
      fileName: row.file_name as string,
      displayName: row.display_name as string,
      modifiedAt: row.modified_at as number,
      createdAt: row.created_at === null || row.created_at === undefined ? null : (row.created_at as number),
      size: row.size_bytes as number,
      durationMs: row.duration_ms === null ? null : (row.duration_ms as number),
      sampleRate: row.sample_rate === null ? null : (row.sample_rate as number),
      bitDepth: row.bit_depth === null ? null : (row.bit_depth as number),
      checksum: typeof row.checksum === 'string' ? (row.checksum as string) : null,
      parentFileId: typeof row.parent_file_id === 'number' ? (row.parent_file_id as number) : null,
      tags: this.parseJsonArray(row.tags_json),
      categories: this.parseJsonArray(row.categories_json),
      customName: typeof row.custom_name === 'string' ? (row.custom_name as string) : null
    };
  }

  /**
   * Lazy accessor ensuring the database has been initialised.
   */
  private requireDb(): BetterSqliteDatabase {
    if (!this.db) {
      throw new Error('Database connection has not been initialised.');
    }
    return this.db;
  }

  /**
   * Applies the initial schema for the application.
   */
  private applySchema(): void {
    const connection = this.requireDb();
    connection.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        absolute_path TEXT NOT NULL UNIQUE,
        library_relative_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        modified_at INTEGER NOT NULL,
        created_at INTEGER,
        size_bytes INTEGER NOT NULL,
        duration_ms INTEGER,
        sample_rate INTEGER,
        bit_depth INTEGER,
        checksum TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        categories_json TEXT NOT NULL DEFAULT '[]',
        parent_file_id INTEGER REFERENCES files(id)
      );
      CREATE INDEX IF NOT EXISTS idx_files_display_name ON files(display_name);
      CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        sub_category TEXT NOT NULL,
        short_code TEXT NOT NULL,
        explanation TEXT NOT NULL,
        synonyms_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        previous_path TEXT NOT NULL,
        new_path TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
      );
    `);

    // Add newly introduced columns if the table already existed.
    this.addColumnIfMissing(connection, 'files', 'created_at', 'INTEGER');
    this.addColumnIfMissing(connection, 'files', 'checksum', 'TEXT');
    this.addColumnIfMissing(connection, 'files', 'custom_name', 'TEXT');
  this.addColumnIfMissing(connection, 'files', 'parent_file_id', 'INTEGER');
    this.addColumnIfMissing(connection, 'files', 'waveform_cache', 'TEXT');

    // Create checksum index after ensuring column exists
    connection.exec('CREATE INDEX IF NOT EXISTS idx_files_checksum ON files(checksum)');
  }

  private addColumnIfMissing(connection: BetterSqliteDatabase, table: string, column: string, definition: string): void {
    const info = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!info.some((row) => row.name === column)) {
      connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  /**
   * Safely parses stored JSON arrays, handling legacy nulls or malformed values.
   */
  private parseJsonArray(value: unknown): string[] {
    if (typeof value !== 'string' || value.length === 0) {
      return [];
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
    } catch {
      return [];
    }
  }
}
