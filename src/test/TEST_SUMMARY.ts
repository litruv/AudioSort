/**
 * Test Suite Summary
 * ===================
 * 
 * Comprehensive test coverage for AudioSort application core services.
 * All tests use real WAV file generation and isolated test environments.
 * 
 * Total Test Count: 67+ tests across 4 test files
 * 
 * Test Files:
 * -----------
 * 
 * 1. DatabaseService.test.ts (20 tests)
 *    - File CRUD operations
 *    - Tag and category management
 *    - Duplicate detection
 *    - Settings persistence
 * 
 * 2. TagService.test.ts (14 tests)
 *    - WAV metadata reading (author, copyright, title, rating)
 *    - WAV metadata writing
 *    - Tag normalization and application
 * 
 * 3. LibraryService.test.ts (20 tests)
 *    - Library scanning with metadata priority
 *    - File operations (rename, move, delete)
 *    - Temp file cleanup and recovery
 *    - Metadata management without organizing
 * 
 * 4. SearchService.test.ts (13 tests)
 *    - Fuzzy search across filename, tags, path
 *    - Advanced filters (author:, copyright:)
 *    - Typo tolerance and similarity scoring
 *    - Metadata caching and index rebuilding
 * 
 * Running Tests:
 * --------------
 * 
 * # Run all tests
 * npm test
 * 
 * # Run specific service tests
 * npm run test:database
 * npm run test:tag
 * npm run test:library
 * npm run test:search
 * 
 * Test Infrastructure:
 * --------------------
 * 
 * - Framework: Node.js built-in test runner (node:test)
 * - TypeScript: tsx for runtime execution
 * - WAV Generation: WaveFile library with real audio data
 * - Test Isolation: Temporary databases and libraries per suite
 * - Audio Format: 16-bit PCM, 44100 Hz, sine wave (440 Hz)
 * - Metadata: WAV INFO chunks (INAM, IART, ICOP, IRTD, etc.)
 * 
 * Key Features:
 * -------------
 * 
 * ✓ Real WAV file generation with embedded metadata
 * ✓ Isolated test environments (no cross-contamination)
 * ✓ Comprehensive coverage of all service methods
 * ✓ Edge case testing (missing data, errors, duplicates)
 * ✓ Fast execution with minimal dependencies
 * ✓ No mocking - tests use actual service implementations
 * 
 * For detailed documentation, see TEST_README.md
 */
