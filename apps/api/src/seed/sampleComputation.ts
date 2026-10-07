import type { MetricPoint } from '@mmt/contracts';

export function trainLinearSample(): {
  metrics: MetricPoint[];
  weights: { weight: number; bias: number };
} {
  const samples = Array.from({ length: 21 }, (_, index) => (index - 10) / 10);
  let weight = 0;
  let bias = 0;
  const metrics: MetricPoint[] = [];
  // This is a small actual CPU calculation, matching the bundled Python example.
  const learningRate = 0.2;
  const steps = 60;
  for (let step = 0; step < steps; step++) {
    const errors = samples.map((input) => weight * input + bias - (2 * input + 1));
    metrics.push({
      name: 'loss',
      value: errors.reduce((sum, error) => sum + error ** 2, 0) / samples.length,
      step,
      timestamp: new Date().toISOString(),
    });
    weight -=
      (learningRate * 2 * errors.reduce((sum, error, index) => sum + error * samples[index]!, 0)) /
      samples.length;
    bias -= (learningRate * 2 * errors.reduce((sum, error) => sum + error, 0)) / samples.length;
  }
  return { metrics, weights: { weight, bias } };
}

export function createSampleWave(): Buffer {
  const sampleRate = 16000;
  const seconds = 1;
  const sampleCount = sampleRate * seconds;
  const amplitude = 0.2;
  const frequency = 440;
  const bytesPerSample = 2;
  const headerSize = 44;
  const wave = Buffer.alloc(headerSize + sampleCount * bytesPerSample);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wave.writeUInt16LE(bytesPerSample, 32);
  wave.writeUInt16LE(bytesPerSample * 8, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(sampleCount * bytesPerSample, 40);
  for (let sample = 0; sample < sampleCount; sample++)
    wave.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * frequency * sample) / sampleRate) * amplitude * 32767),
      headerSize + sample * bytesPerSample,
    );
  return wave;
}
