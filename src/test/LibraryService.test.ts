/**
 * Comprehensive test suite for LibraryService.
 * Run with: node --import tsx --test src/test/LibraryService.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { LibraryService } from '../main/services/LibraryService';
import { DatabaseService } from '../main/services/DatabaseService';
import { SettingsService } from '../main/services/SettingsService';
import { TagService } from '../main/services/TagService';
import { SearchService } from '../main/services/SearchService';
import { TestWavGenerator, getTempDbPath, getTempLibraryPath } from './testHelpers';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('LibraryService', () => {
  let libraryService: LibraryService;
  let database: DatabaseService;
  let settings: SettingsService;
  let tagService: TagService;
  let searchService: SearchService;
  let dbPath: string;
  let libraryPath: string;

  beforeEach(async () => {
    dbPath = getTempDbPath();
    libraryPath = getTempLibraryPath();
    
    database = new DatabaseService(dbPath);
    database.initialize();
    settings = new SettingsService(database);
    tagService = new TagService(database);
    searchService = new SearchService(database, tagService);
    libraryService = new LibraryService(database, settings, tagService, searchService);

    // Set library path in database
    database.setSetting('libraryPath', libraryPath);

    // Create test files
    await TestWavGenerator.createTestLibrary(libraryPath, [
      {
        relativePath: 'test1.wav',
        options: {
          duration: 1,
          author: 'Author 1',
          copyright: 'Copyright 1',
          title: 'Test 1',
          rating: 3
        }
      },
      {
        relativePath: 'subfolder/test2.wav',
        options: {
          duration: 2,
          author: 'Author 2',
          copyright: 'Copyright 2',
          title: 'Test 2',
          rating: 5
        }
      }
    ]);
  });

  afterEach(async () => {
    database.close();
    await TestWavGenerator.cleanupTestLibrary(libraryPath);
    await fs.unlink(dbPath).catch(() => {});
  });

  describe('scanLibrary', () => {
    it('should discover WAV files in library', async () => {
      const result = await libraryService.scanLibrary();
      
      assert.strictEqual(result.added, 2);
      assert.strictEqual(result.total, 2);
    });

    it('should read embedded metadata during scan', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file1 = files.find(f => f.fileName === 'test1.wav');
      
      assert.ok(file1);
      assert.strictEqual(file1.customName, 'Test 1');
    });

    it('should detect updated files on rescan', async () => {
      await libraryService.scanLibrary();
      
      // Modify a file
      const testFile = path.join(libraryPath, 'test1.wav');
      await TestWavGenerator.writeTestWav(testFile, {
        duration: 1,
        author: 'Modified Author'
      });
      
      const result = await libraryService.scanLibrary();
      assert.strictEqual(result.updated, 2); // Both files are "updated" on rescan
    });

    it('should remove deleted files from database', async () => {
      await libraryService.scanLibrary();
      
      // Delete a file
      await fs.unlink(path.join(libraryPath, 'test1.wav'));
      
      const result = await libraryService.scanLibrary();
      assert.strictEqual(result.removed, 1);
      assert.strictEqual(result.total, 1);
    });

    it('should clean up orphaned temp files', async () => {
      // Create a temp file
      const tempFile = path.join(libraryPath, 'test.1234567890-1-abc123.tmp');
      await fs.writeFile(tempFile, 'temp data');
      
      await libraryService.scanLibrary();
      
      // Temp file should be cleaned up
      const tempExists = await fs.access(tempFile).then(() => true).catch(() => false);
      assert.strictEqual(tempExists, false);
    });
  });

  describe('listFiles', () => {
    it('should return all files in library', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      assert.strictEqual(files.length, 2);
    });

    it('should include file metadata', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      assert.ok(file.absolutePath);
      assert.ok(file.fileName);
      assert.ok(file.relativePath);
      assert.ok(typeof file.size === 'number');
      assert.ok(typeof file.durationMs === 'number');
    });
  });

  describe('renameFile', () => {
    it('should rename a file', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      const updated = await libraryService.renameFile(file.id, 'renamed.wav');
      
      assert.strictEqual(updated.fileName, 'renamed.wav');
      assert.ok(updated.absolutePath.endsWith('renamed.wav'));
    });

    it('should update file on disk', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      const originalPath = file.absolutePath;
      
      const updated = await libraryService.renameFile(file.id, 'renamed.wav');
      
      const originalExists = await fs.access(originalPath).then(() => true).catch(() => false);
      const newExists = await fs.access(updated.absolutePath).then(() => true).catch(() => false);
      
      assert.strictEqual(originalExists, false);
      assert.strictEqual(newExists, true);
    });
  });

  describe('moveFile', () => {
    it('should move file to different directory', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files.find(f => f.fileName === 'test1.wav');
      
      assert.ok(file);
      const updated = await libraryService.moveFile(file.id, 'newdir');
      
      assert.ok(updated.relativePath.includes('newdir'));
    });

    it('should create target directory if needed', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      await libraryService.moveFile(file.id, 'new/nested/dir');
      
      const dirExists = await fs.access(path.join(libraryPath, 'new/nested/dir'))
        .then(() => true).catch(() => false);
      
      assert.strictEqual(dirExists, true);
    });
  });

  describe('updateCustomName', () => {
    it('should update custom name in database', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      const updated = libraryService.updateCustomName(file.id, 'Custom Name');
      
      assert.strictEqual(updated.customName, 'Custom Name');
    });

    it('should allow clearing custom name', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      libraryService.updateCustomName(file.id, 'Custom Name');
      const updated = libraryService.updateCustomName(file.id, null);
      
      assert.strictEqual(updated.customName, null);
    });
  });

  describe('updateFileMetadata', () => {
    it('should update author metadata', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      await libraryService.updateFileMetadata(file.id, {
        author: 'New Author'
      });
      
      const metadata = await libraryService.readFileMetadata(file.id);
      assert.strictEqual(metadata.author, 'New Author');
    });

    it('should update copyright metadata', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      await libraryService.updateFileMetadata(file.id, {
        copyright: 'New Copyright'
      });
      
      const metadata = await libraryService.readFileMetadata(file.id);
      assert.strictEqual(metadata.copyright, 'New Copyright');
    });

    it('should update rating metadata', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      await libraryService.updateFileMetadata(file.id, {
        rating: 4
      });
      
      const metadata = await libraryService.readFileMetadata(file.id);
      assert.strictEqual(metadata.rating, 4);
    });
  });

  describe('readFileMetadata', () => {
    it('should read embedded metadata', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      const metadata = await libraryService.readFileMetadata(file.id);
      
      assert.ok(metadata);
      assert.ok(metadata.author);
    });
  });

  describe('listMetadataSuggestions', () => {
    it('should aggregate authors from library', async () => {
      await libraryService.scanLibrary();
      
      const suggestions = await libraryService.listMetadataSuggestions();
      
      assert.ok(suggestions.authors.length > 0);
      assert.ok(suggestions.authors.includes('Author 1'));
      assert.ok(suggestions.authors.includes('Author 2'));
    });

    it('should aggregate copyrights from library', async () => {
      await libraryService.scanLibrary();
      
      const suggestions = await libraryService.listMetadataSuggestions();
      
      assert.ok(suggestions.copyrights.length > 0);
      assert.ok(suggestions.copyrights.includes('Copyright 1'));
      assert.ok(suggestions.copyrights.includes('Copyright 2'));
    });

    it('should return sorted suggestions', async () => {
      await libraryService.scanLibrary();
      
      const suggestions = await libraryService.listMetadataSuggestions();
      
      // Check if arrays are sorted
      const authorsSorted = [...suggestions.authors].sort();
      assert.deepStrictEqual(suggestions.authors, authorsSorted);
      
      const copyrightsSorted = [...suggestions.copyrights].sort();
      assert.deepStrictEqual(suggestions.copyrights, copyrightsSorted);
    });
  });

  describe('deleteFiles', () => {
    it('should delete file from disk', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      const filePath = file.absolutePath;
      
      await libraryService.deleteFiles([file.id]);
      
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      assert.strictEqual(exists, false);
    });

    it('should remove file from database', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const file = files[0];
      
      await libraryService.deleteFiles([file.id]);
      
      const remaining = libraryService.listFiles();
      assert.strictEqual(remaining.length, 1);
      assert.ok(!remaining.find(f => f.id === file.id));
    });

    it('should handle multiple files', async () => {
      await libraryService.scanLibrary();
      
      const files = libraryService.listFiles();
      const ids = files.map(f => f.id);
      
      await libraryService.deleteFiles(ids);
      
      const remaining = libraryService.listFiles();
      assert.strictEqual(remaining.length, 0);
    });
  });

  describe('cleanupTempFiles', () => {
    it('should remove orphaned temp files', async () => {
      const tempFile = path.join(libraryPath, 'test.1234567890-1-abc123.tmp');
      await fs.writeFile(tempFile, 'temp');
      
      const cleaned = await libraryService.cleanupTempFiles();
      
      assert.strictEqual(cleaned, 1);
      const exists = await fs.access(tempFile).then(() => true).catch(() => false);
      assert.strictEqual(exists, false);
    });

    it('should recover temp files when final file missing', async () => {
      const finalPath = path.join(libraryPath, 'test.wav');
      const tempFile = `${finalPath}.1234567890-1-abc123.tmp`;
      
      await fs.writeFile(tempFile, 'temp data');
      
      const cleaned = await libraryService.cleanupTempFiles();
      
      assert.strictEqual(cleaned, 1);
      const finalExists = await fs.access(finalPath).then(() => true).catch(() => false);
      assert.strictEqual(finalExists, true);
    });
  });
});
