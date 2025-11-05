import path from 'node:path';
import { AudioFileSummary, CategoryRecord } from '../../shared/models';
import { DatabaseService } from './DatabaseService';

/**
 * Handles automatic file organization based on UCS categories.
 * Provides helpers for folder resolution, base name creation, and duplicate handling.
 */
export class OrganizationService {
  public constructor(private readonly database: DatabaseService) {}

  /**
   * Resolves the primary category record for a file, or null if unavailable.
   */
  public getPrimaryCategory(file: AudioFileSummary): CategoryRecord | null {
    if (file.categories.length === 0) {
      return null;
    }
    const categoryId = file.categories[0];
    return this.database.getCategoryById(categoryId);
  }

  /**
   * Builds the folder path for the provided category (CATEGORY/SUBCATEGORY).
   */
  public buildFolderPath(category: CategoryRecord): string {
    const categoryFolder = category.category.toUpperCase().replace(/\s+/g, '_');
    const subCategoryFolder = category.subCategory.toUpperCase().replace(/\s+/g, '_');
    return path.join(categoryFolder, subCategoryFolder);
  }

  /**
   * Produces the base name (without extension) used for organizing files.
   * Combines the short code with the suffix from CatID, plus custom name if provided.
   * Example: CatID "VEHUtil" + CatShort "VEH" → "VEH_Util"
   */
  public buildBaseName(category: CategoryRecord, customName?: string): string {
    const shortCode = category.shortCode.toUpperCase();
    const suffix = this.extractCatIdSuffix(category.id, category.shortCode);
    
    let baseName = shortCode;
    if (suffix) {
      baseName = `${shortCode}_${suffix}`;
    }
    
    if (customName) {
      const clean = this.sanitizeCustomName(customName);
      if (clean) {
        baseName = `${baseName}_${clean}`;
      }
    }
    
    return baseName;
  }

  /**
   * Extracts the suffix from CatID by removing the CatShort prefix.
   * Example: extractCatIdSuffix("VEHUtil", "VEH") → "Util"
   */
  private extractCatIdSuffix(catId: string, catShort: string): string {
    if (!catId.toLowerCase().startsWith(catShort.toLowerCase())) {
      return '';
    }
    const suffix = catId.substring(catShort.length);
    return suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase();
  }

  /**
   * Lists existing files inside the target folder that share the provided base name.
   */
  public listConflictingFiles(folderPath: string, baseName: string): AudioFileSummary[] {
    const normalizedFolder = this.normalizePath(folderPath);
    const pattern = new RegExp(`^${baseName}(?:_(\\d+))?\\.wav$`, 'i');
    return this.database
      .listFiles()
      .filter((file) => this.normalizePath(path.dirname(file.relativePath)) === normalizedFolder)
      .filter((file) => pattern.test(file.fileName));
  }

  /**
   * Determines the next available sequence number for the given base name within a folder.
   */
  public findNextAvailableNumber(folderPath: string, baseName: string): number {
    const conflicts = this.listConflictingFiles(folderPath, baseName);
    if (conflicts.length === 0) {
      return 1;
    }
    const pattern = new RegExp(`^${baseName}_(\\d+)\\.wav$`, 'i');
    const numbers = conflicts
      .map((file) => {
        const match = file.fileName.match(pattern);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((value) => value > 0);
    if (numbers.length === 0) {
      return 1;
    }
    return Math.max(...numbers) + 1;
  }

  /**
   * Formats a sequence number with leading zeros.
   */
  public formatSequenceNumber(index: number): string {
    return index.toString().padStart(2, '0');
  }

  /**
   * Exposes the sanitiser so the caller can reuse consistent logic.
   * Capitalizes the first letter of each word and replaces spaces with underscores.
   */
  public sanitizeCustomName(name: string): string {
    return name
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('_');
  }

  private normalizePath(value: string): string {
    return value.replace(/\\/g, '/');
  }
}
