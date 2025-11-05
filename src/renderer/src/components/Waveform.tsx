import { useEffect, useRef } from 'react';

export interface WaveformProps {
  audioUrl: string | null;
  currentTime: number;
  duration: number;
  className?: string;
}

/**
 * Renders an audio waveform visualization that serves as the background for the progress bar.
 */
export function Waveform({ audioUrl, currentTime, duration, className = '' }: WaveformProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformDataRef = useRef<number[] | null>(null);

  useEffect(() => {
    if (!audioUrl) {
      return;
    }

    const loadWaveform = async () => {
      try {
        const audioContext = new AudioContext();
        const response = await fetch(audioUrl);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        const rawData = audioBuffer.getChannelData(0);
        const samples = 500;
        const blockSize = Math.floor(rawData.length / samples);
        const filteredData: number[] = [];

        for (let i = 0; i < samples; i++) {
          const blockStart = blockSize * i;
          let sum = 0;
          for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(rawData[blockStart + j]);
          }
          filteredData.push(sum / blockSize);
        }

        const multiplier = Math.max(...filteredData) ** -1;
        waveformDataRef.current = filteredData.map((n) => n * multiplier);
        drawWaveform();

        await audioContext.close();
      } catch (error) {
        console.warn('Failed to generate waveform', error);
      }
    };

    void loadWaveform();
  }, [audioUrl]);

  useEffect(() => {
    drawWaveform();
  }, [currentTime, duration]);

  const drawWaveform = () => {
    const canvas = canvasRef.current;
    const data = waveformDataRef.current;
    if (!canvas || !data) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const thumbWidth = 14;
    const padding = thumbWidth / 2;
    const drawableWidth = width - thumbWidth;
    const barWidth = drawableWidth / data.length;
    const playedProgress = duration > 0 ? currentTime / duration : 0;

    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < data.length; i++) {
      const barHeight = data[i] * height * 0.8;
      const x = padding + (i * barWidth);
      const y = (height - barHeight) / 2;

      if (i / data.length < playedProgress) {
        ctx.fillStyle = '#4a9eff';
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      }

      ctx.fillRect(x, y, barWidth * 0.8, barHeight);
    }
  };

  return <canvas ref={canvasRef} className={className} style={{ width: '100%', height: '100%' }} />;
}

export default Waveform;
