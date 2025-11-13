import { useEffect, useRef, useState } from 'react';

export interface WaveformProps {
  audioUrl: string | null;
  currentTime: number;
  duration: number;
  className?: string;
}

/**
 * Renders an audio waveform visualization that serves as the background for the progress bar.
 * Skips waveform generation for very long files to avoid UI lag.
 */
export function Waveform({ audioUrl, currentTime, duration, className = '' }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformDataRef = useRef<number[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!audioUrl) {
      return;
    }

    let cancelled = false;

    const loadWaveform = async () => {
      try {
        setIsLoading(true);
        const startTime = performance.now();
        
        const response = await fetch(audioUrl);
        const arrayBuffer = await response.arrayBuffer();
        
        if (cancelled) return;
        
        const audioContext = new AudioContext();
        const decodeStart = performance.now();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const decodeTime = performance.now() - decodeStart;

        if (cancelled) {
          await audioContext.close();
          return;
        }

        const processStart = performance.now();
        const rawData = audioBuffer.getChannelData(0);
        const samples = 100; // Reduced from 500 to 100 for faster generation
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

        if (cancelled) {
          await audioContext.close();
          return;
        }

        const multiplier = Math.max(...filteredData) ** -1;
        waveformDataRef.current = filteredData.map((n) => n * multiplier);
        drawWaveform();

        await audioContext.close();
        
        const totalTime = performance.now() - startTime;
        const processTime = performance.now() - processStart;
        console.log(`Waveform generation: total=${totalTime.toFixed(1)}ms, decode=${decodeTime.toFixed(1)}ms, process=${processTime.toFixed(1)}ms, duration=${(duration / 1000).toFixed(1)}s`);
        
        setIsLoading(false);
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to generate waveform', error);
          setIsLoading(false);
        }
      }
    };

    void loadWaveform();
    
    return () => {
      cancelled = true;
    };
  }, [audioUrl, duration]);

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

  return (
    <>
      <canvas ref={canvasRef} className={className} style={{ width: '100%', height: '100%' }} />
      {isLoading && (
        <div style={{ 
          position: 'absolute', 
          top: '50%', 
          left: '50%', 
          transform: 'translate(-50%, -50%)',
          fontSize: '10px',
          color: 'rgba(255, 255, 255, 0.5)'
        }}>
          Loading waveform...
        </div>
      )}
    </>
  );
}

export default Waveform;
