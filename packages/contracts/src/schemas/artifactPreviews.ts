import { z } from 'zod';
import {
  ARTIFACT_PREVIEW_KINDS,
  type ArtifactPreview,
  type WaveformPeaksPreview,
} from '../artifactPreviews.js';
import { idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const artifactPreviewSchema = namedContractSchema(
  'ArtifactPreview',
  z.strictObject({
    artifactId: idSchema,
    kind: z.enum(ARTIFACT_PREVIEW_KINDS),
    status: z.enum(['queued', 'running', 'ready', 'failed', 'skipped']),
    previewArtifactId: idSchema.nullable(),
    error: z.string().nullable(),
    attempts: z.number().int(),
    updatedAt: timestampSchema,
  }),
);
// Not a route body: the content of a 'waveform-peaks' Artifact, which the web viewer fetches.
export const waveformPeaksPreviewSchema = namedContractSchema(
  'WaveformPeaksPreview',
  z.strictObject({
    version: z.literal(1),
    sampleRate: z.number().int(),
    durationSeconds: z.number(),
    samplesPerPeak: z.number().int(),
    min: z.array(z.number()),
    max: z.array(z.number()),
  }),
);

type _ArtifactPreview = Expect<
  MutuallyAssignable<z.infer<typeof artifactPreviewSchema>, ArtifactPreview>
>;
type _WaveformPeaksPreview = Expect<
  MutuallyAssignable<z.infer<typeof waveformPeaksPreviewSchema>, WaveformPeaksPreview>
>;
