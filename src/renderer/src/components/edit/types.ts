import type { SplitSegmentRequest } from '../../../../shared/models';

/**
 * Editable metadata captured for each draft segment.
 */
export interface SegmentMetadataDraft {
  /** Custom name override applied to the generated segment (null clears). */
  customName: string | null;
  /** Author/artist override applied to the generated segment. */
  author: string | null;
  /** Rating override (1-5) applied to the generated segment, null preserves none. */
  rating: number | null;
  /** Tag collection applied to the generated segment. */
  tags: string[];
  /** UCS categories applied to the generated segment. */
  categories: string[];
}

/**
 * Draft segment structure maintained inside the edit mode panel before saving.
 */
export interface SegmentDraft {
  /** Stable identifier used for React rendering and user interactions. */
  id: string;
  /** Inclusive start offset in milliseconds. */
  startMs: number;
  /** Exclusive end offset in milliseconds. */
  endMs: number;
  /** User facing label displayed in the segment list. */
  label: string;
  /** Captured metadata overrides. */
  metadata: SegmentMetadataDraft;
}

/**
 * Converts a draft segment into the IPC request payload.
 */
export function toSplitRequest(segment: SegmentDraft): SplitSegmentRequest {
  return {
    startMs: Math.round(segment.startMs),
    endMs: Math.round(segment.endMs),
    label: segment.label.trim().length > 0 ? segment.label.trim() : undefined,
    metadata: {
      customName: segment.metadata.customName,
      author: segment.metadata.author,
      rating: segment.metadata.rating ?? undefined,
      tags: segment.metadata.tags,
      categories: segment.metadata.categories
    }
  };
}
