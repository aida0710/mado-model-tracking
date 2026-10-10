import { useEffect, useRef, useState } from 'react';
import type { WaveformPeaks } from '../../lib/audioAnalysis';

// Redraws when the theme changes, because canvas pixels do not follow CSS variables.
function useThemeRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setRevision((value) => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return revision;
}

export function AudioWaveform({ peaks, height }: { peaks: WaveformPeaks; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const themeRevision = useThemeRevision();
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const pixelHeight = Math.round(height * window.devicePixelRatio);
    canvas.width = peaks.max.length;
    canvas.height = pixelHeight;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const style = getComputedStyle(canvas);
    context.fillStyle = style.getPropertyValue('--border');
    context.fillRect(0, Math.floor(pixelHeight / 2), canvas.width, 1);
    context.fillStyle = style.getPropertyValue('--accent');
    const middle = pixelHeight / 2;
    for (let column = 0; column < peaks.max.length; column += 1) {
      const top = middle - peaks.max[column]! * middle;
      const bottom = middle - peaks.min[column]! * middle;
      context.fillRect(column, top, 1, Math.max(1, bottom - top));
    }
  }, [peaks, height, themeRevision]);
  return <canvas ref={canvasRef} className="audio-waveform" style={{ height }} aria-hidden="true" />;
}
