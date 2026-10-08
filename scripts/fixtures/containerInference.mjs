/** A dependency-free inference image command used by the real Docker verification. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const parameters = JSON.parse(await readFile(process.env.MMT_PARAMETERS_FILE, 'utf8'));
const weights = JSON.parse(await readFile(process.env.MMT_MODEL_FILE, 'utf8'));
const { inputDatasets } = JSON.parse(
  await readFile(process.env.MMT_DATASET_VERSIONS_FILE, 'utf8'),
);
const samples = inputDatasets[0]?.metadata.samples ?? [0, 1, 2, 3];
const expected = inputDatasets[0]?.metadata.expected ?? [1, 3, 5, 7];
const MILLISECONDS_PER_SECOND = 1000;
if (!Number.isFinite(weights.weight) || !Number.isFinite(weights.bias)) {
  throw new Error('The registered model weights must be finite numbers');
}
console.log('container started');

// Exercise forced container cancellation with a process that ignores graceful shutdown.
if (parameters.hold) {
  process.on('SIGTERM', () => {});
  await new Promise(() => setInterval(() => {}, MILLISECONDS_PER_SECOND));
}
if (parameters.delaySeconds) {
  await new Promise((resolve) =>
    setTimeout(resolve, parameters.delaySeconds * MILLISECONDS_PER_SECOND),
  );
}

const predictions = samples.map((sample) => weights.weight * sample + weights.bias);
const meanSquaredError =
  predictions.reduce((sum, prediction, index) => sum + (prediction - expected[index]) ** 2, 0) /
  predictions.length;
const outputDirectory = process.env.MMT_OUTPUTS_DIR ?? '/mmt/outputs';
await mkdir(join(outputDirectory, 'artifacts'), { recursive: true });
const predictionContent = JSON.stringify({
  samples,
  predictions,
  modelVersionId: process.env.MMT_MODEL_VERSION_ID,
});
await saveCompletedFile(
  join(outputDirectory, 'artifacts', 'predictions.json'),
  predictionContent,
);
await saveCompletedFile(
  process.env.MMT_RESULT_FILE ?? join(outputDirectory, 'result.json'),
  JSON.stringify({
    version: 1,
    complete: true,
    artifacts: [{
      path: 'artifacts/predictions.json',
      size: Buffer.byteLength(predictionContent),
      sha256: createHash('sha256').update(predictionContent).digest('hex'),
      mimeType: 'application/json',
    }],
    metrics: [
      { name: 'inference.samples', value: predictions.length, step: 0 },
      { name: 'evaluation.mse', value: meanSquaredError, step: 0 },
    ],
  }),
);
console.log('container results complete');

async function saveCompletedFile(path, content) {
  const incompletePath = path + '.partial';
  await writeFile(incompletePath, content);
  await rename(incompletePath, path);
}
