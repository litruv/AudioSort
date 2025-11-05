import { useEffect, useSyncExternalStore } from 'react';
import { playerStore, type PlayerSnapshot } from '../stores/PlayerStore';
import type { AudioFileSummary } from '../../../shared/models';

/**
 * React hook to wire components to the player store.
 */
export function usePlayerSnapshot(): PlayerSnapshot {
  useEffect(() => () => playerStore.dispose(), []);
  return useSyncExternalStore(
    (listener: () => void) => playerStore.subscribe(listener),
    () => playerStore.getSnapshot()
  );
}

/**
 * Convenience helper that loads a file into the audio player store.
 */
export function loadPlayerFile(file: AudioFileSummary | null, autoPlay = true): void {
  if (!file) {
    playerStore.dispose();
    return;
  }
  void playerStore.loadFile(file, autoPlay);
}
