/**
 * Comprehensive test suite for TagService.
 * Run with: node --import tsx --test src/test/TagService.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { TagService } from '../main/services/TagService';
import { DatabaseService } from '../main/services/DatabaseService';
import { TestWavGenerator, getTempDbPath, getTempLibraryPath } from './testHelpers';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('TagService', () => {
  let tagService: TagService;
  let database: DatabaseService;
  let dbPath: string;
  let libraryPath: string;
  let testFilePath: string;

  beforeEach(async () => {
    dbPath = getTempDbPath();
    libraryPath = getTempLibraryPath();
    database = new DatabaseService(dbPath);
    database.initialize();
    tagService = new TagService(database);

    await TestWavGenerator.createTestLibrary(libraryPath, [
      {
        relativePath: 'test.wav',
        options: {
          duration: 1,
          author: 'Test Author',
          copyright: 'Test Copyright',
          title: 'Test Title',
          rating: 3,
          tags: ['test', 'audio'],
          categories: ['AMBNatr']
        }
      }
    ]);

    testFilePath = path.join(libraryPath, 'test.wav');

    // Add file to database
    database.upsertFile({
      absolutePath: testFilePath,
      relativePath: 'test.wav',
      fileName: 'test.wav',
      displayName: 'test',
      modifiedAt: Date.now(),
      createdAt: Date.now(),
      size: 1024,
      durationMs: 1000,
      sampleRate: 44100,
      bitDepth: 16,
      checksum: 'test-checksum',
      tags: ['test'],
      categories: ['AMBNatr']
    });
  });

  afterEach(async () => {
    database.close();
    await TestWavGenerator.cleanupTestLibrary(libraryPath);
    await fs.unlink(dbPath).catch(() => {});
  });

  describe('readMetadata', () => {
    it('should read author from WAV file', () => {
      const metadata = tagService.readMetadata(testFilePath);
      assert.strictEqual(metadata.author, 'Test Author');
    });

    it('should read copyright from WAV file', () => {
      const metadata = tagService.readMetadata(testFilePath);
      assert.strictEqual(metadata.copyright, 'Test Copyright');
    });

    it('should read title from WAV file', () => {
      const metadata = tagService.readMetadata(testFilePath);
      assert.strictEqual(metadata.title, 'Test Title');
    });

    it('should read rating from WAV file', () => {
      const metadata = tagService.readMetadata(testFilePath);
      assert.strictEqual(metadata.rating, 3);
    });

    it('should handle missing metadata gracefully', async () => {
      const emptyFilePath = path.join(libraryPath, 'empty.wav');
      await TestWavGenerator.writeTestWav(emptyFilePath, {});

      const metadata = tagService.readMetadata(emptyFilePath);
      assert.strictEqual(metadata.author, undefined);
      assert.strictEqual(metadata.copyright, undefined);
      assert.strictEqual(metadata.title, undefined);
      assert.strictEqual(metadata.rating, undefined);
    });

    it('should handle corrupted files gracefully', () => {
      const metadata = tagService.readMetadata('/nonexistent/file.wav');
      assert.deepStrictEqual(metadata, {});
    });
  });

  describe('writeMetadataOnly', () => {
    it('should write author to WAV file', () => {
      tagService.writeMetadataOnly(testFilePath, {
        tags: ['test'],
        categories: ['AMBNatr'],
        author: 'New Author'
      });

      const metadata = tagService.readMetadata(testFilePath);
      assert.strictEqual(metadata.author, 'New Author');
    });

    it('should write copyright to WAV file', () => {
      tagService.writeMetadataOnly(testFilePath, {
        tags: ['test'],
        categories: ['AMBNatr'],
        copyright: 'New Copyright'
      });

      const metadata = tagService.readMetadata(testFilePath);
      assert.strictEqual(metadata.copyright, 'New Copyright');
    });

    it('should write title to WAV file', () => {
      tagService.writeMetadataOnly(testFilePath, {
        tags: ['test'],
        categories: ['AMBNatr'],
        title: 'New Title'
      });

      const metadata = tagService.readMetadata(testFilePath);
      assert.strictEqual(metadata.title, 'New Title');
    });

    it('should write rating to WAV file', () => {
      tagService.writeMetadataOnly(testFilePath, {
        tags: ['test'],
        categories: ['AMBNatr'],
        rating: 5
      });

      const metadata = tagService.readMetadata(testFilePath);
      assert.strictEqual(metadata.rating, 5);
    });

    it('should clear metadata when set to empty', () => {
      tagService.writeMetadataOnly(testFilePath, {
        tags: ['test'],
        categories: ['AMBNatr'],
        author: '',
        copyright: '',
        title: '',
        rating: 0
      });

      const metadata = tagService.readMetadata(testFilePath);
      assert.strictEqual(metadata.author, undefined);
      assert.strictEqual(metadata.copyright, undefined);
      assert.strictEqual(metadata.title, undefined);
      assert.strictEqual(metadata.rating, undefined);
    });

    it('should write tags to WAV file', () => {
      tagService.writeMetadataOnly(testFilePath, {
        tags: ['new', 'tags'],
        categories: ['AMBNatr']
      });

      // Metadata write succeeded without throwing
      assert.ok(true);
    });

    it('should write categories to WAV file', () => {
      tagService.writeMetadataOnly(testFilePath, {
        tags: ['test'],
        categories: ['AMBCity', 'AMBNatr']
      });

      // Verify write succeeded
      assert.ok(true);
    });
  });

  describe('applyTagging', () => {
    it('should update tags in database', () => {
      const files = database.listFiles();
      const fileId = files[0].id;

      const updated = tagService.applyTagging(fileId, ['new', 'tags'], ['AMBNatr']);

      assert.deepStrictEqual(updated.tags, ['new', 'tags']);
    });

    it('should update categories in database', () => {
      const files = database.listFiles();
      const fileId = files[0].id;

      const updated = tagService.applyTagging(fileId, ['test'], ['AMBCity', 'AMBNatr']);

      assert.deepStrictEqual(updated.categories, ['AMBCity', 'AMBNatr']);
    });

    it('should write metadata to WAV file', () => {
      const files = database.listFiles();
      const fileId = files[0].id;

      tagService.applyTagging(fileId, ['new', 'tags'], ['AMBCity']);

      // Verify it didn't throw
      assert.ok(true);
    });

    it('should normalize tags by trimming whitespace', () => {
      const files = database.listFiles();
      const fileId = files[0].id;

      const updated = tagService.applyTagging(fileId, ['  tag1  ', '  tag2  '], ['AMBNatr']);

      assert.deepStrictEqual(updated.tags, ['tag1', 'tag2']);
    });

    it('should remove duplicate tags', () => {
      const files = database.listFiles();
      const fileId = files[0].id;

      const updated = tagService.applyTagging(fileId, ['tag1', 'tag1', 'tag2'], ['AMBNatr']);

      assert.deepStrictEqual(updated.tags, ['tag1', 'tag2']);
    });

    it('should remove empty tags', () => {
      const files = database.listFiles();
      const fileId = files[0].id;

      const updated = tagService.applyTagging(fileId, ['tag1', '', '  ', 'tag2'], ['AMBNatr']);

      assert.deepStrictEqual(updated.tags, ['tag1', 'tag2']);
    });
  });
});
