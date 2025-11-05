import type { AudioFileSummary } from '../../../shared/models';

type PlayerListener = () => void;

export interface PlayerSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error';
  currentFileId: number | null;
  audioUrl: string | null;
  autoPlay: boolean;
  error: string | null;
  loadCount: number;
}

/**
 * Minimal audio playback store that fetches WAV data through the preload bridge and exposes a blob URL.
 */
export class PlayerStore extends EventTarget {
  private snapshot: PlayerSnapshot = {
    status: 'idle',
    currentFileId: null,
    audioUrl: null,
    autoPlay: false,
    error: null,
    loadCount: 0
  };

  /**
   * Retrieves the latest snapshot.
   */
  public getSnapshot(): PlayerSnapshot {
    return this.snapshot;
  }

  /**
   * Subscribes to updates.
   */
  public subscribe(listener: PlayerListener): () => void {
    const handler = () => listener();
    this.addEventListener('change', handler as EventListener);
    return () => this.removeEventListener('change', handler as EventListener);
  }

  /**
   * Loads a new file from disk, emitting progress updates.
   */
  public async loadFile(file: AudioFileSummary, autoPlay = true): Promise<void> {
    this.update({ status: 'loading', currentFileId: file.id, autoPlay, error: null });
    try {
      const payload = await window.api.getAudioBuffer(file.id);
      const blob = new Blob([payload.buffer], { type: payload.mimeType });
      const url = URL.createObjectURL(blob);
      if (this.snapshot.audioUrl) {
        URL.revokeObjectURL(this.snapshot.audioUrl);
      }
      this.update({ status: 'ready', audioUrl: url, autoPlay, loadCount: this.snapshot.loadCount + 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load audio file.';
      this.update({ status: 'error', error: message });
    }
  }

  /**
   * Releases resources when the player is disposed.
   */
  public dispose(): void {
    if (this.snapshot.audioUrl) {
      URL.revokeObjectURL(this.snapshot.audioUrl);
    }
    this.update({ status: 'idle', currentFileId: null, audioUrl: null, autoPlay: false, error: null, loadCount: 0 });
  }

  private update(patch: Partial<PlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.dispatchEvent(new Event('change'));
  }
}

export const playerStore = new PlayerStore();
