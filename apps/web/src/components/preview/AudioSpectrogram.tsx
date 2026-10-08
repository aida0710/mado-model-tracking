import { useEffect, useRef } from 'react';
import { SPECTROGRAM_DB_FLOOR, type Spectrogram } from '../../lib/audioAnalysis';

// A magma-like ramp: readable on both themes because silence is near-black and loud bins are pale.
const COLOR_STOPS: Array<[number, [number, number, number]]> = [
  [0, [0, 0, 4]],
  [0.25, [59, 15, 112]],
  [0.5, [140, 41, 129]],
  [0.75, [222, 73, 104]],
  [0.9, [254, 159, 109]],
  [1, [252, 253, 191]],
];
const COLOR_LEVELS = 256;

function buildColorTable(): Uint8ClampedArray {
  const table = new Uint8ClampedArray(COLOR_LEVELS * 3);
  for (let level = 0; level < COLOR_LEVELS; level += 1) {
    const position = level / (COLOR_LEVELS - 1);
    const upper = COLOR_STOPS.findIndex(([stop]) => stop >= position);
    const [highStop, highColor] = COLOR_STOPS[Math.max(1, upper)]!;
    const [lowStop, lowColor] = COLOR_STOPS[Math.max(0, upper - 1)]!;
    const ratio = highStop === lowStop ? 0 : (position - lowStop) / (highStop - lowStop);
    for (let component = 0; component < 3; component += 1)
      table[level * 3 + component] = lowColor[component]! + (highColor[component]! - lowColor[component]!) * ratio;
  }
  return table;
}
const colorTable = buildColorTable();

export function AudioSpectrogram({ spectrogram, height }: { spectrogram: Spectrogram; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const { frameCount, binCount, values } = spectrogram;
    canvas.width = Math.max(1, frameCount);
    canvas.height = Math.max(1, binCount);
    if (frameCount === 0) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    // One pixel per frame and bin; CSS stretches it to the drawn size. Low frequencies at the bottom.
    const image = context.createImageData(frameCount, binCount);
    for (let frame = 0; frame < frameCount; frame += 1)
      for (let bin = 0; bin < binCount; bin += 1) {
        const level = Math.round(
          ((values[frame * binCount + bin]! - SPECTROGRAM_DB_FLOOR) / -SPECTROGRAM_DB_FLOOR) * (COLOR_LEVELS - 1),
        );
        const pixel = ((binCount - 1 - bin) * frameCount + frame) * 4;
        image.data[pixel] = colorTable[level * 3]!;
        image.data[pixel + 1] = colorTable[level * 3 + 1]!;
        image.data[pixel + 2] = colorTable[level * 3 + 2]!;
        image.data[pixel + 3] = 255;
      }
    context.putImageData(image, 0, 0);
  }, [spectrogram]);
  return <canvas ref={canvasRef} className="audio-spectrogram" style={{ height }} aria-hidden="true" />;
}
