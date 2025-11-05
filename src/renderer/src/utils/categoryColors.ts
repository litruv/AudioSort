import type { CSSProperties } from 'react';

/**
 * Shared helpers for deriving deterministic color accents for UCS categories.
 */
export interface CategorySwatch {
  base: string;
  soft: string;
  strong: string;
  text: string;
}

/**
 * Generates a deterministic numeric hash for a category label.
 */
export function hashCategoryLabel(label: string): number {
  let hash = 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + label.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * Creates a hue-based color swatch derived from the provided category label.
 */
export function buildCategorySwatch(label: string): CategorySwatch {
  const normalized = label.trim().toLowerCase();
  const hue = hashCategoryLabel(normalized) % 360;
  const saturation = 62;
  const lightness = 52;

  const base = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  const soft = `hsla(${hue}, ${saturation}%, ${lightness}%, 0.18)`;
  const strong = `hsla(${hue}, ${saturation}%, ${Math.min(lightness + 8, 70)}%, 0.35)`;

  return {
    base,
    soft,
    strong,
    text: '#ffffff'
  };
}

/**
 * Generates CSS custom property assignments from a swatch.
 */
export function createCategoryStyleVars(swatch?: CategorySwatch): CSSProperties | undefined {
  if (!swatch) {
    return undefined;
  }
  return {
    '--category-color-base': swatch.base,
    '--category-color-soft': swatch.soft,
    '--category-color-strong': swatch.strong,
    '--category-color-text': swatch.text
  } as CSSProperties;
}

/**
 * Formats UCS labels from uppercase source data into readable casing.
 */
export function formatCategoryLabel(value: string): string {
  const lower = value.trim().toLowerCase();
  return lower.replace(/(^|[\s\-\/'])([a-z])/g, (match, boundary, letter) => `${boundary}${letter.toUpperCase()}`);
}
