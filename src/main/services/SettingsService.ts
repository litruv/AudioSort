import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { AppSettings } from '../../shared/models';
import { DatabaseService } from './DatabaseService';

/**
 * Manages persistent application settings backed by the SQLite database.
 */
export class SettingsService {
  public constructor(private readonly database: DatabaseService) {}

  /**
   * Reads the current settings snapshot.
   */
  public getSettings(): AppSettings {
    return this.database.getSettings();
  }

  /**
   * Returns the configured library path or null when not set.
   */
  public getLibraryPath(): string | null {
    return this.database.getSettings().libraryPath;
  }

  /**
   * Ensures there is a library path stored, defaulting to the user's Music directory.
   */
  public ensureLibraryPath(): string {
    const settings = this.database.getSettings();
    if (settings.libraryPath) {
      this.ensureDirectory(settings.libraryPath);
      return settings.libraryPath;
    }
    const defaultPath = path.join(app.getPath('music'), 'AudioSortLibrary');
    this.ensureDirectory(defaultPath);
    this.database.setSetting('libraryPath', defaultPath);
    return defaultPath;
  }

  /**
   * Updates the stored library path after validating and normalising it.
   */
  public updateLibraryPath(targetPath: string): AppSettings {
    const normalised = path.resolve(targetPath);
    this.ensureDirectory(normalised);
    this.database.setSetting('libraryPath', normalised);
    return this.database.getSettings();
  }

  /**
   * Guarantees that the desired directory exists.
   */
  private ensureDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}
