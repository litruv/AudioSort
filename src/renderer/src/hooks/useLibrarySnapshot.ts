import { useEffect, useSyncExternalStore } from 'react';
import { libraryStore, type LibrarySnapshot } from '../stores/LibraryStore';

/**
 * React hook to consume the library store snapshot with automatic bootstrap.
 */
export function useLibrarySnapshot(): LibrarySnapshot {
  useEffect(() => {
    if (!libraryStore.getSnapshot().initialized) {
      void libraryStore.bootstrap();
    }
  }, []);

  return useSyncExternalStore(
    (listener: () => void) => libraryStore.subscribe(listener),
    () => libraryStore.getSnapshot()
  );
}
