/**
 * Comprehensive test suite for DatabaseService.
 * Run with: node --import tsx --test src/test/DatabaseService.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { DatabaseService } from '../main/services/DatabaseService';
import { getTempDbPath } from './testHelpers';
import fs from 'node:fs/promises';

describe('DatabaseService', () => {
  let database: DatabaseService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTempDbPath();
    database = new DatabaseService(dbPath);
    database.initialize();
  });

  afterEach(async () => {
    database.close();
    await fs.unlink(dbPath).catch(() => {});
  });

  describe('file management', () => {
    it('should upsert file record', () => {
      const record = database.upsertFile({
        absolutePath: '/test/file.wav',
        relativePath: 'file.wav',
        fileName: 'file.wav',
        displayName: 'file',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: 'abc123',
        tags: ['test'],
        categories: []
      });

      assert.ok(record.id);
      assert.strictEqual(record.fileName, 'file.wav');
    });

    it('should list all files', () => {
      database.upsertFile({
        absolutePath: '/test/file1.wav',
        relativePath: 'file1.wav',
        fileName: 'file1.wav',
        displayName: 'file1',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      database.upsertFile({
        absolutePath: '/test/file2.wav',
        relativePath: 'file2.wav',
        fileName: 'file2.wav',
        displayName: 'file2',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      const files = database.listFiles();
      assert.strictEqual(files.length, 2);
    });

    it('should get file by id', () => {
      const inserted = database.upsertFile({
        absolutePath: '/test/file.wav',
        relativePath: 'file.wav',
        fileName: 'file.wav',
        displayName: 'file',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      const retrieved = database.getFileById(inserted.id);
      assert.strictEqual(retrieved.id, inserted.id);
      assert.strictEqual(retrieved.fileName, 'file.wav');
    });

    it('should update file location', () => {
      const file = database.upsertFile({
        absolutePath: '/test/file.wav',
        relativePath: 'file.wav',
        fileName: 'file.wav',
        displayName: 'file',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      const updated = database.updateFileLocation(
        file.id,
        '/test/newdir/file.wav',
        'newdir/file.wav',
        'file.wav',
        'file'
      );

      assert.strictEqual(updated.absolutePath, '/test/newdir/file.wav');
      assert.strictEqual(updated.relativePath, 'newdir/file.wav');
    });

    it('should delete file', () => {
      const file = database.upsertFile({
        absolutePath: '/test/file.wav',
        relativePath: 'file.wav',
        fileName: 'file.wav',
        displayName: 'file',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      database.deleteFile(file.id);

      const files = database.listFiles();
      assert.strictEqual(files.length, 0);
    });

    it('should remove files outside set', () => {
      database.upsertFile({
        absolutePath: '/test/file1.wav',
        relativePath: 'file1.wav',
        fileName: 'file1.wav',
        displayName: 'file1',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      database.upsertFile({
        absolutePath: '/test/file2.wav',
        relativePath: 'file2.wav',
        fileName: 'file2.wav',
        displayName: 'file2',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      const kept = new Set(['/test/file1.wav']);
      const removed = database.removeFilesOutside(kept);

      assert.strictEqual(removed, 1);
      assert.strictEqual(database.listFiles().length, 1);
    });
  });

  describe('tagging', () => {
    it('should update file tags', () => {
      const file = database.upsertFile({
        absolutePath: '/test/file.wav',
        relativePath: 'file.wav',
        fileName: 'file.wav',
        displayName: 'file',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      const updated = database.updateTagging(file.id, ['tag1', 'tag2'], ['cat1']);

      assert.deepStrictEqual(updated.tags, ['tag1', 'tag2']);
      assert.deepStrictEqual(updated.categories, ['cat1']);
    });

    it('should update custom name', () => {
      const file = database.upsertFile({
        absolutePath: '/test/file.wav',
        relativePath: 'file.wav',
        fileName: 'file.wav',
        displayName: 'file',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      const updated = database.updateCustomName(file.id, 'Custom Name');

      assert.strictEqual(updated.customName, 'Custom Name');
    });

    it('should clear custom name', () => {
      const file = database.upsertFile({
        absolutePath: '/test/file.wav',
        relativePath: 'file.wav',
        fileName: 'file.wav',
        displayName: 'file',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: [],
        categories: []
      });

      database.updateCustomName(file.id, 'Custom Name');
      const updated = database.updateCustomName(file.id, null);

      assert.strictEqual(updated.customName, null);
    });
  });

  describe('categories', () => {
    it('should upsert category', () => {
      database.upsertCategory({
        id: 'TEST',
        category: 'TEST CATEGORY',
        subCategory: 'Test Sub',
        shortCode: 'TST',
        explanation: 'Test explanation',
        synonyms: ['test', 'sample']
      });

      const categories = database.listCategories();
      assert.ok(categories.some(c => c.id === 'TEST'));
    });

    it('should get category by id', () => {
      database.upsertCategory({
        id: 'TEST',
        category: 'TEST CATEGORY',
        subCategory: 'Test Sub',
        shortCode: 'TST',
        explanation: 'Test explanation',
        synonyms: ['test', 'sample']
      });

      const category = database.getCategoryById('TEST');
      assert.ok(category);
      assert.strictEqual(category.id, 'TEST');
      assert.strictEqual(category.shortCode, 'TST');
    });

    it('should list all categories', () => {
      database.upsertCategory({
        id: 'TEST1',
        category: 'TEST CATEGORY',
        subCategory: 'Test Sub 1',
        shortCode: 'TS1',
        explanation: 'Test',
        synonyms: []
      });

      database.upsertCategory({
        id: 'TEST2',
        category: 'TEST CATEGORY',
        subCategory: 'Test Sub 2',
        shortCode: 'TS2',
        explanation: 'Test',
        synonyms: []
      });

      const categories = database.listCategories();
      assert.ok(categories.length >= 2);
    });
  });

  describe('duplicates', () => {
    it('should detect duplicate files by checksum', () => {
      const checksum = 'duplicate-checksum';

      database.upsertFile({
        absolutePath: '/test/file1.wav',
        relativePath: 'file1.wav',
        fileName: 'file1.wav',
        displayName: 'file1',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum,
        tags: [],
        categories: []
      });

      database.upsertFile({
        absolutePath: '/test/file2.wav',
        relativePath: 'file2.wav',
        fileName: 'file2.wav',
        displayName: 'file2',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum,
        tags: [],
        categories: []
      });

      const duplicates = database.listDuplicateGroups();
      assert.strictEqual(duplicates.length, 1);
      assert.strictEqual(duplicates[0].checksum, checksum);
      assert.strictEqual(duplicates[0].files.length, 2);
    });

    it('should not include unique files in duplicates', () => {
      database.upsertFile({
        absolutePath: '/test/file1.wav',
        relativePath: 'file1.wav',
        fileName: 'file1.wav',
        displayName: 'file1',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: 'unique1',
        tags: [],
        categories: []
      });

      database.upsertFile({
        absolutePath: '/test/file2.wav',
        relativePath: 'file2.wav',
        fileName: 'file2.wav',
        displayName: 'file2',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: 'unique2',
        tags: [],
        categories: []
      });

      const duplicates = database.listDuplicateGroups();
      assert.strictEqual(duplicates.length, 0);
    });
  });

  describe('settings', () => {
    it('should save and retrieve library path setting', () => {
      database.setSetting('libraryPath', '/test/library');
      const settings = database.getSettings();
      
      assert.strictEqual(settings.libraryPath, '/test/library');
    });

    it('should return null for missing library path', () => {
      const settings = database.getSettings();
      assert.strictEqual(settings.libraryPath, null);
    });

    it('should overwrite existing setting', () => {
      database.setSetting('libraryPath', '/path1');
      database.setSetting('libraryPath', '/path2');
      
      const settings = database.getSettings();
      assert.strictEqual(settings.libraryPath, '/path2');
    });

    it('should handle custom settings', () => {
      database.setSetting('customKey', { test: 'value' });
      // Settings are stored as JSON strings internally
      // Just verify no errors thrown
      assert.ok(true);
    });
  });
});
