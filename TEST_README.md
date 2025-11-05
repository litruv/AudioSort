# AudioSort Test Suite

Comprehensive test suite for AudioSort application using real WAV files with embedded metadata.

## Running Tests

### Run all tests
```powershell
npm test
```

### Run specific test suites
```powershell
# Tag Service tests (metadata read/write)
npm run test:tag

# Library Service tests (scanning, organizing, file operations)
npm run test:library

# Search Service tests (fuzzy search, filters)
node --import tsx --test src/test/SearchService.test.ts
```

### Run individual test files
```powershell
node --import tsx --test src/test/DatabaseService.test.ts
node --import tsx --test src/test/TagService.test.ts
node --import tsx --test src/test/LibraryService.test.ts
node --import tsx --test src/test/SearchService.test.ts
```

## Test Coverage

### DatabaseService Tests (20+ tests)
- **File Management**: upsertFile, listFiles, getFileById, updateFileLocation, deleteFile
- **Tagging Operations**: updateTagging, updateCustomName
- **Category Management**: upsertCategory, getCategoryById, listCategories
- **Duplicate Detection**: listDuplicateGroups by checksum
- **Settings Persistence**: setSetting, getSettings
- Edge cases: Missing files, null values, duplicate checksums

### TagService Tests (14 tests)
- **readMetadata**: Reading author, copyright, title, rating from WAV files
- **writeMetadataOnly**: Writing metadata to WAV INFO chunks
- **applyTagging**: Updating tags/categories in database and WAV files
- Edge cases: Missing metadata, corrupted files, empty values, normalization

### LibraryService Tests (20+ tests)
- **scanLibrary**: File discovery, metadata extraction, temp file cleanup
- **listFiles**: File listing with metadata
- **renameFile**: File renaming on disk and in database
- **moveFile**: Moving files between directories
- **updateCustomName**: Custom name management
- **updateFileMetadata**: Metadata updates without organizing
- **readFileMetadata**: Reading embedded WAV metadata
- **listMetadataSuggestions**: Aggregating author/copyright suggestions
- **deleteFiles**: File deletion from disk and database
- **cleanupTempFiles**: Orphaned temp file recovery

### SearchService Tests (13 tests)
- **search**: Fuzzy search by filename, tags, path
- **Advanced filters**: author:, copyright: field-specific searches
- **Metadata caching**: Performance optimization
- **rebuildIndex**: Index updates after database changes
- Edge cases: Empty queries, typos, no matches

## Test Data

Tests use the `TestWavGenerator` class to create real WAV files with:
- Configurable duration, sample rate, bit depth
- Embedded metadata (author, copyright, title, rating)
- Tags and UCS categories
- Sine wave audio data (440 Hz)

Example test file creation:
```typescript
await TestWavGenerator.writeTestWav('test.wav', {
  duration: 1,
  sampleRate: 44100,
  bitDepth: 16,
  author: 'Test Author',
  copyright: 'Test Copyright',
  title: 'Test Title',
  rating: 3,
  tags: ['test', 'audio'],
  categories: ['AMBNatr']
});
```

## Test Isolation

Each test suite:
1. Creates temporary database and library directories
2. Generates fresh test WAV files
3. Initializes services with isolated instances
4. Cleans up all resources after tests complete

Temporary files are created in `test-data/` and automatically removed.

## Testing Strategy

### Unit Tests
- Test individual service methods in isolation
- Verify correct behavior with valid inputs
- Handle edge cases and error conditions

### Integration Tests
- Test interactions between services (LibraryService + TagService + SearchService)
- Verify database updates reflect in search results
- Ensure file system operations complete successfully

### Real Data Tests
- Use actual WAV files with embedded metadata
- Test metadata round-trip (write then read)
- Verify file integrity after operations

## Extending Tests

### Adding New Test Cases

1. **For TagService**:
```typescript
it('should handle new metadata field', () => {
  tagService.writeMetadataOnly(testFilePath, {
    tags: [],
    categories: [],
    newField: 'value'
  });
  
  const metadata = tagService.readMetadata(testFilePath);
  assert.strictEqual(metadata.newField, 'value');
});
```

2. **For LibraryService**:
```typescript
it('should handle new operation', async () => {
  await libraryService.scanLibrary();
  const files = libraryService.listFiles();
  
  // Perform operation
  await libraryService.newOperation(files[0].id);
  
  // Verify results
  const updated = libraryService.listFiles();
  assert.ok(/* verification */);
});
```

3. **For SearchService**:
```typescript
it('should support new filter', () => {
  const results = searchService.search('newfilter:value');
  
  assert.ok(results.length > 0);
  assert.ok(/* filter applied correctly */);
});
```

## Troubleshooting

### Tests hang or timeout
- Check for leaked file handles (ensure database.close() in afterEach)
- Verify temp files are being cleaned up
- Increase test timeout if needed

### File not found errors
- Ensure library path is created before writing test files
- Check file paths use correct separators for OS
- Verify temp directory permissions

### Metadata not persisting
- Confirm WAV file format is correct (use WaveFile library)
- Check INFO chunk tags are supported
- Verify file is written to disk before reading

### Search tests fail
- Rebuild search index after database changes
- Clear metadata cache when needed
- Check Fuse.js scoring thresholds

## Performance Considerations

- Tests create real WAV files (may be slower than mocks)
- Each test suite runs independently with fresh data
- Cleanup operations ensure no disk space accumulation
- Test data directory can be cleared manually if needed: `rm -rf test-data`

## CI/CD Integration

Tests can be run in CI/CD pipelines:

```yaml
# GitHub Actions example
- name: Run tests
  run: npm test
```

Tests require:
- Node.js 18+ (for node:test runner)
- File system write access
- Sufficient disk space for test WAV files (~1-2 MB per test run)

## Debugging Tests

Enable verbose output:
```powershell
NODE_OPTIONS='--test-reporter=spec' npm test
```

Run specific test:
```powershell
node --import tsx --test --test-name-pattern="should read author" src/test/TagService.test.ts
```

Debug with inspector:
```powershell
node --import tsx --test --inspect-brk src/test/TagService.test.ts
```
