/**
 * Comprehensive test suite for SearchService.
 * Run with: node --import tsx --test src/test/SearchService.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SearchService } from '../main/services/SearchService';
import { DatabaseService } from '../main/services/DatabaseService';
import { TagService } from '../main/services/TagService';
import { TestWavGenerator, getTempDbPath, getTempLibraryPath } from './testHelpers';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('SearchService', () => {
  let searchService: SearchService;
  let database: DatabaseService;
  let tagService: TagService;
  let dbPath: string;
  let libraryPath: string;

  beforeEach(async () => {
    dbPath = getTempDbPath();
    libraryPath = getTempLibraryPath();
    
    database = new DatabaseService(dbPath);
    database.initialize();
    tagService = new TagService(database);
    searchService = new SearchService(database, tagService);

    // Create test files with various metadata
    await TestWavGenerator.createTestLibrary(libraryPath, [
      {
        relativePath: 'ambience/city/traffic.wav',
        options: {
          author: 'John Doe',
          copyright: 'Copyright 2024',
          title: 'City Traffic',
          tags: ['traffic', 'city', 'urban']
        }
      },
      {
        relativePath: 'ambience/nature/forest.wav',
        options: {
          author: 'Jane Smith',
          copyright: 'Copyright 2024',
          title: 'Forest Ambience',
          tags: ['forest', 'nature', 'birds']
        }
      },
      {
        relativePath: 'effects/explosion.wav',
        options: {
          author: 'John Doe',
          copyright: 'Copyright 2023',
          title: 'Big Explosion',
          tags: ['explosion', 'boom', 'loud']
        }
      }
    ]);

    // Add files to database
    const files = [
      {
        absolutePath: path.join(libraryPath, 'ambience/city/traffic.wav'),
        relativePath: 'ambience/city/traffic.wav',
        fileName: 'traffic.wav',
        displayName: 'traffic',
        tags: ['traffic', 'city', 'urban'],
        categories: []
      },
      {
        absolutePath: path.join(libraryPath, 'ambience/nature/forest.wav'),
        relativePath: 'ambience/nature/forest.wav',
        fileName: 'forest.wav',
        displayName: 'forest',
        tags: ['forest', 'nature', 'birds'],
        categories: []
      },
      {
        absolutePath: path.join(libraryPath, 'effects/explosion.wav'),
        relativePath: 'effects/explosion.wav',
        fileName: 'explosion.wav',
        displayName: 'explosion',
        tags: ['explosion', 'boom', 'loud'],
        categories: []
      }
    ];

    for (const file of files) {
      database.upsertFile({
        ...file,
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null
      });
    }

    searchService.rebuildIndex();
  });

  afterEach(async () => {
    database.close();
    await TestWavGenerator.cleanupTestLibrary(libraryPath);
    await fs.unlink(dbPath).catch(() => {});
  });

  describe('search', () => {
    it('should find files by filename', () => {
      const results = searchService.search('traffic');
      
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.fileName === 'traffic.wav'));
    });

    it('should find files by tag', () => {
      const results = searchService.search('forest');
      
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.tags.includes('forest')));
    });

    it('should find files by path', () => {
      const results = searchService.search('ambience');
      
      assert.ok(results.length >= 2);
      assert.ok(results.every(r => r.relativePath.includes('ambience')));
    });

    it('should return empty array for no matches', () => {
      const results = searchService.search('nonexistent');
      
      assert.strictEqual(results.length, 0);
    });

    it('should perform fuzzy matching', () => {
      const results = searchService.search('trffic'); // typo
      
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.fileName === 'traffic.wav'));
    });

    it('should support author: filter', () => {
      const results = searchService.search('author:john');
      
      assert.ok(results.length > 0);
      assert.ok(results.every(r => {
        const metadata = tagService.readMetadata(r.absolutePath);
        return metadata.author?.toLowerCase().includes('john');
      }));
    });

    it('should support copyright: filter', () => {
      const results = searchService.search('copyright:2024');
      
      assert.ok(results.length >= 2);
    });

    it('should combine regular search with filters', () => {
      const results = searchService.search('author:john explosion');
      
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.fileName === 'explosion.wav'));
    });

    it('should cache metadata for performance', () => {
      // First search should cache metadata
      searchService.search('author:john');
      
      // Second search should use cache
      const results = searchService.search('author:john');
      
      assert.ok(results.length > 0);
    });

    it('should handle empty query', () => {
      const results = searchService.search('');
      
      // Empty query returns all files
      assert.strictEqual(results.length, 3);
    });

    it('should handle whitespace-only query', () => {
      const results = searchService.search('   ');
      
      // Whitespace-only query is treated as empty, returns all files
      assert.strictEqual(results.length, 3);
    });
  });

  describe('rebuildIndex', () => {
    it('should update search index', () => {
      // Add a new file to database
      database.upsertFile({
        absolutePath: path.join(libraryPath, 'new.wav'),
        relativePath: 'new.wav',
        fileName: 'new.wav',
        displayName: 'new',
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        size: 1024,
        durationMs: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        checksum: null,
        tags: ['new'],
        categories: []
      });

      searchService.rebuildIndex();
      
      const results = searchService.search('new');
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.fileName === 'new.wav'));
    });

    it('should clear metadata cache', () => {
      // Cache some metadata
      searchService.search('author:john');
      
      // Rebuild should clear cache
      searchService.rebuildIndex();
      
      // Search again should work
      const results = searchService.search('author:john');
      assert.ok(results.length > 0);
    });
  });
});
