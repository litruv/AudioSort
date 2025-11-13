import { useEffect, useRef, useState } from 'react';
import type { PlayerSnapshot } from '../stores/PlayerStore';
import { Waveform } from './Waveform';

const MIN_VOLUME_DB = -48;
const DEFAULT_VOLUME_DB = -24;
const VOLUME_STORAGE_KEY = 'audio-player.volume-slider';

const DEFAULT_VOLUME_SLIDER = (() => {
  const range = 0 - MIN_VOLUME_DB;
  if (range === 0) {
    return 1;
  }
  const slider = (DEFAULT_VOLUME_DB - MIN_VOLUME_DB) / range;
  if (!Number.isFinite(slider)) {
    return 1;
  }
  return Math.min(1, Math.max(0, slider));
})();

/**
 * Reads the persisted volume slider position from local storage, falling back to the default slider value.
 */
function loadStoredVolumeSlider(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_VOLUME_SLIDER;
  }
  try {
    const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_VOLUME_SLIDER;
    }
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_VOLUME_SLIDER;
    }
    if (parsed < 0 || parsed > 1) {
      return DEFAULT_VOLUME_SLIDER;
    }
    return parsed;
  } catch {
    return DEFAULT_VOLUME_SLIDER;
  }
}

/**
 * Persists the volume slider position to local storage, guarding against storage errors.
 */
function persistVolumeSlider(value: number): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, value.toFixed(4));
  } catch {
    // Ignored: local storage may be unavailable (private mode, quotas, etc.).
  }
}

export interface AudioPlayerProps {
  snapshot: PlayerSnapshot;
}

/**
 * Seamless audio player that integrates smoothly with the interface.
 */
export function AudioPlayer({ snapshot }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volumeSlider, setVolumeSlider] = useState<number>(() => loadStoredVolumeSlider());
  const volumeSliderRef = useRef(volumeSlider);
  const isSettingVolumeRef = useRef(false);

  useEffect(() => {
    volumeSliderRef.current = volumeSlider;
    persistVolumeSlider(volumeSlider);
  }, [volumeSlider]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const targetVolume = sliderToVolume(volumeSlider);
    if (Math.abs(audio.volume - targetVolume) < 0.0001) {
      return;
    }
    isSettingVolumeRef.current = true;
    audio.volume = targetVolume;
    setTimeout(() => {
      isSettingVolumeRef.current = false;
    }, 0);
  }, [volumeSlider]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || snapshot.status !== 'ready' || !snapshot.audioUrl) {
      return;
    }

    let rafId: number | null = null;

    if (!audio.paused) {
      audio.pause();
    }
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);


    const updateTime = () => {
      if (audio && !audio.paused) {
        setCurrentTime(audio.currentTime);
        rafId = requestAnimationFrame(updateTime);
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
      rafId = requestAnimationFrame(updateTime);
    };
    
    const handlePause = () => {
      setIsPlaying(false);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    
    const handleEnded = () => {
      setIsPlaying(false);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const handleDurationChange = () => setDuration(audio.duration);
    const handleVolumeChange = () => {
      if (isSettingVolumeRef.current) {
        return;
      }
      const nextSlider = volumeToSlider(audio.volume);
      setVolumeSlider(nextSlider);
      volumeSliderRef.current = nextSlider;
    };
    const handleLoadedMetadata = () => {
      isSettingVolumeRef.current = true;
      audio.volume = sliderToVolume(volumeSliderRef.current);
      setTimeout(() => {
        isSettingVolumeRef.current = false;
      }, 0);
      setCurrentTime(0);
      setDuration(audio.duration);
      if (snapshot.autoPlay) {
        void audio.play().catch(() => undefined);
      }
    };

    isSettingVolumeRef.current = true;
    audio.volume = sliderToVolume(volumeSliderRef.current);
    setTimeout(() => {
      isSettingVolumeRef.current = false;
    }, 0);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('volumechange', handleVolumeChange);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);

    audio.src = snapshot.audioUrl;
    audio.load();

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('volumechange', handleVolumeChange);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [snapshot.loadCount, snapshot.autoPlay]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target) {
        const tagName = target.tagName;
        const isEditableElement = tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable;
        if (isEditableElement) {
          const isRangeInput = target instanceof HTMLInputElement && target.type === 'range';
          if (!isRangeInput) {
            return;
          }
        }
      }

      event.preventDefault();
      togglePlayPause();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPlaying]);

  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused || audio.ended) {
      void audio.play();
    } else {
      audio.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const time = parseFloat(e.target.value);
    audio.currentTime = time;
    setCurrentTime(time);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const sliderPosition = Math.max(0, Math.min(1, parseFloat(e.target.value)));
    const amplitude = sliderToVolume(sliderPosition);
    audio.volume = amplitude;
    setVolumeSlider(sliderPosition);
    volumeSliderRef.current = sliderPosition;
  };

  const volumeAmplitude = sliderToVolume(volumeSlider);
  const volumeIcon = volumeAmplitude === 0 ? '🔇' : volumeAmplitude < 0.4 ? '🔉' : '🔊';
  const volumeDecibels = sliderToDecibels(volumeSlider);
  const volumeLabel = formatDecibels(volumeDecibels);

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds)) return '00:00.000';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  if (snapshot.status === 'idle') {
    return <div className="player player--empty">Select a file to play</div>;
  }

  if (snapshot.status === 'loading') {
    return <div className="player player--loading">Loading audio…</div>;
  }

  if (snapshot.status === 'error') {
    return <div className="player player--error">{snapshot.error}</div>;
  }

  return (
    <div className="player">
      <audio ref={audioRef} preload="metadata">
        <track kind="captions" />
      </audio>
      <div className="player-controls">
        <button type="button" className="player-button" onClick={togglePlayPause} aria-label={isPlaying ? 'Pause' : 'Play'}>
          <span
            aria-hidden="true"
            className={isPlaying ? 'player-button-icon player-button-icon--pause' : 'player-button-icon player-button-icon--play'}
          />
        </button>
        <div className="player-progress">
          <span className="player-time">{formatTime(currentTime)}</span>
          <div className="player-slider-container">
            <Waveform 
              audioUrl={snapshot.audioUrl} 
              currentTime={currentTime} 
              duration={duration}
              className="player-waveform"
            />
            <input
              type="range"
              className="player-slider"
              min="0"
              max={duration || 0}
              step="0.001"
              value={currentTime}
              onChange={handleSeek}
              aria-label="Seek"
            />
          </div>
          <span className="player-time">{formatTime(duration)}</span>
        </div>
        <div className="player-volume">
          <span className="player-volume-icon">{volumeIcon}</span>
          <span className="player-volume-db">{volumeLabel}</span>
          <input
            type="range"
            className="player-slider player-slider--volume"
            min="0"
            max="1"
            step="0.01"
            value={volumeSlider}
            onChange={handleVolumeChange}
            aria-label="Volume"
            aria-valuetext={volumeLabel}
          />
        </div>
      </div>
    </div>
  );
}

function sliderToDecibels(value: number): number {
  if (value <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const clamped = Math.max(0, Math.min(1, value));
  return MIN_VOLUME_DB + (0 - MIN_VOLUME_DB) * clamped;
}

function sliderToVolume(value: number): number {
  if (value <= 0) {
    return 0;
  }
  const decibels = sliderToDecibels(value);
  return Math.pow(10, decibels / 20);
}

function volumeToSlider(volume: number): number {
  if (volume <= 0) {
    return 0;
  }
  const decibels = 20 * Math.log10(volume);
  if (!Number.isFinite(decibels)) {
    return 0;
  }
  const slider = (decibels - MIN_VOLUME_DB) / (0 - MIN_VOLUME_DB);
  return Math.max(0, Math.min(1, slider));
}

function formatDecibels(decibels: number): string {
  if (!Number.isFinite(decibels) || decibels <= MIN_VOLUME_DB + 0.1) {
    return '-∞ dB';
  }
  return `${decibels.toFixed(1)} dB`;
}

export default AudioPlayer;
