/**
 * Test helpers and utilities for creating test WAV files with metadata.
 */
import { WaveFile } from 'wavefile';
import fs from 'node:fs/promises';
import path from 'node:path';

export class TestWavGenerator {
  /**
   * Creates a simple 1-second WAV file with metadata.
   */
  public static createTestWav(options: {
    duration?: number;
    sampleRate?: number;
    bitDepth?: number;
    tags?: string[];
    categories?: string[];
    author?: string;
    copyright?: string;
    title?: string;
    rating?: number;
  } = {}): Buffer {
    const {
      duration = 1,
      sampleRate = 44100,
      bitDepth = 16,
      tags = [],
      categories = [],
      author,
      copyright,
      title,
      rating
    } = options;

    // Generate simple sine wave data
    const numSamples = Math.floor(sampleRate * duration);
    const frequency = 440; // A4 note
    const samples = new Int16Array(numSamples);
    const amplitude = Math.pow(2, bitDepth - 1) - 1;

    for (let i = 0; i < numSamples; i++) {
      const time = i / sampleRate;
      samples[i] = Math.floor(amplitude * 0.5 * Math.sin(2 * Math.PI * frequency * time));
    }

    // Create WAV file
    const wav = new WaveFile();
    wav.fromScratch(1, sampleRate, String(bitDepth), samples);

    // Add metadata using INFO chunks
    const wavWithTags = wav as WaveFile & {
      setTag?: (tag: string, value: string) => void;
    };

    if (wavWithTags.setTag) {
      // Set tags and categories
      if (tags.length > 0) {
        wavWithTags.setTag('IKEY', tags.join('; '));
        wavWithTags.setTag('ISBJ', tags.join('; '));
      }

      if (categories.length > 0) {
        wavWithTags.setTag('IGNR', categories.join('; '));
        wavWithTags.setTag('ICMT', categories.join('; '));
        wavWithTags.setTag('ISUB', categories.join('; '));
      }

      // Set metadata
      if (title) {
        wavWithTags.setTag('INAM', title);
      }

      if (author) {
        wavWithTags.setTag('IART', author);
      }

      if (copyright) {
        wavWithTags.setTag('ICOP', copyright);
      }

      if (rating && rating > 0) {
        wavWithTags.setTag('IRTD', String(rating * 2));
      }

      wavWithTags.setTag('ISFT', 'AudioSort Test Generator');
    }

    return Buffer.from(wav.toBuffer());
  }

  /**
   * Writes a test WAV file to disk.
   */
  public static async writeTestWav(
    filePath: string,
    options: Parameters<typeof TestWavGenerator.createTestWav>[0] = {}
  ): Promise<void> {
    const buffer = this.createTestWav(options);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
  }

  /**
   * Creates multiple test WAV files in a directory structure.
   */
  public static async createTestLibrary(
    rootPath: string,
    files: Array<{
      relativePath: string;
      options?: Parameters<typeof TestWavGenerator.createTestWav>[0];
    }>
  ): Promise<void> {
    await fs.mkdir(rootPath, { recursive: true });

    for (const file of files) {
      const fullPath = path.join(rootPath, file.relativePath);
      await this.writeTestWav(fullPath, file.options);
    }
  }

  /**
   * Cleans up a test directory.
   */
  public static async cleanupTestLibrary(rootPath: string): Promise<void> {
    try {
      await fs.rm(rootPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to cleanup test library at ${rootPath}:`, error);
    }
  }
}

/**
 * Creates a temporary test database path.
 */
export function getTempDbPath(): string {
  return path.join(process.cwd(), 'test-data', `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/**
 * Creates a temporary test library path.
 */
export function getTempLibraryPath(): string {
  return path.join(process.cwd(), 'test-data', `test-lib-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/**
 * Delays execution for testing async operations.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
