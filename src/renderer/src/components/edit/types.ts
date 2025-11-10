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
  /** Color used for visual identification in UI and waveform. */
  color: string;
}

/**
 * Converts a draft segment into the IPC request payload.
 */
export function toSplitRequest(segment: SegmentDraft): SplitSegmentRequest {
  const trimmedLabel = segment.label.trim();
  const effectiveLabel = trimmedLabel.length > 0 ? trimmedLabel : undefined;
  
  // Only include customName in metadata if it differs from the label
  // This allows the backend to use the label as the customName by default
  const customNameOverride = segment.metadata.customName !== null && segment.metadata.customName !== trimmedLabel
    ? segment.metadata.customName
    : undefined;
  
  return {
    startMs: Math.round(segment.startMs),
    endMs: Math.round(segment.endMs),
    label: effectiveLabel,
    metadata: {
      customName: customNameOverride,
      author: segment.metadata.author,
      rating: segment.metadata.rating ?? undefined,
      tags: segment.metadata.tags,
      categories: segment.metadata.categories
    }
  };
}
