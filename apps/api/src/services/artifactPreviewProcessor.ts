import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Artifact, ArtifactPreviewKind } from '@mmt/contracts';
import type { ArtifactStores } from '@mmt/platform';
import { transaction, type Database } from '../db/database.js';
import { projectArtifactBackend, registerStoredArtifact } from './artifactRegistration.js';
import {
  claimNextPreviewJob,
  markPreviewFinished,
  markPreviewReady,
  retryPreviewLater,
  type PreviewJob,
} from './artifactPreviewQueue.js';
import { probeMediaFile, type MediaProbe } from './mediaProbe.js';
import { MediaToolFailedError, MediaToolUnavailableError } from './mediaTools.js';
import { renderAudioPreviews, renderVideoPoster } from './previewRenderer.js';

export interface PreviewTools {
  ffmpegPath: string;
  ffprobePath: string;
  /** Upper bound for each ffprobe/ffmpeg run. */
  timeoutMs: number;
}

interface PreviewFile {
  fileName: string;
  mimeType: string;
  body: Buffer;
}

/** Why a preview ended without a file; stored in artifact_previews.error. */
type PreviewFailure =
  | { status: 'skipped'; error: 'ffmpeg_unavailable' | 'no_audio_stream' | 'no_video_stream' }
  | { status: 'failed'; error: 'probe_failed' | 'render_failed' | 'render_timeout' };

/** Lost claims are not errors: the newer claim owns the row, so this result is discarded. */
class PreviewClaimLostError extends Error {
  override readonly name = 'PreviewClaimLostError';
}

const AUDIO_KINDS: ReadonlySet<ArtifactPreviewKind> = new Set(['waveform-peaks', 'spectrogram']);

function toolFailure(error: unknown, stage: 'probe' | 'render'): PreviewFailure {
  if (error instanceof MediaToolUnavailableError)
    return { status: 'skipped', error: 'ffmpeg_unavailable' };
  if (stage === 'probe') return { status: 'failed', error: 'probe_failed' };
  if (error instanceof MediaToolFailedError && error.reason === 'timeout')
    return { status: 'failed', error: 'render_timeout' };
  return { status: 'failed', error: 'render_failed' };
}

function logPreviewEvent(event: string, details: Record<string, unknown>): void {
  // Tool output and storage locations are not logged; the Artifact id identifies the file.
  console.error(JSON.stringify({ event, ...details }));
}

/**
 * Generates the claimed previews of one Artifact: downloads it to a private temp directory,
 * probes it with ffprobe, records media info the header probe could not read, renders each kind
 * and stores the result as an Artifact without a Run. The source Artifact is never modified.
 */
export class ArtifactPreviewProcessor {
  constructor(
    private readonly options: {
      database: Database;
      stores: ArtifactStores;
      tools: PreviewTools;
      /** Parent of the per-job temp directories; it needs room for the largest source file. */
      workDirectory: string;
    },
  ) {}

  /** Processes one Artifact's previews; false when the queue is empty. */
  async processNext(): Promise<boolean> {
    // Created before claiming, so an unusable work directory leaves no row stuck in 'running'.
    const directory = await mkdtemp(path.join(this.options.workDirectory, 'mmt-preview-'));
    try {
      const job = await claimNextPreviewJob(this.options.database);
      if (!job) return false;
      await this.process(job, path.join(directory, 'source'));
      return true;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async process(job: PreviewJob, sourcePath: string): Promise<void> {
    try {
      await this.download(job.artifact, sourcePath);
    } catch (error) {
      logPreviewEvent('artifact_preview_source_unreadable', { artifactId: job.artifact.id, name: (error as Error).name });
      for (const [kind, attempts] of job.attempts)
        await retryPreviewLater(this.options.database, { artifactId: job.artifact.id, kind, attempts, error: 'source_unreadable' });
      return;
    }
    let probe: MediaProbe;
    try {
      probe = await probeMediaFile({
        ffprobePath: this.options.tools.ffprobePath,
        filePath: sourcePath,
        timeoutMs: this.options.tools.timeoutMs,
      });
    } catch (error) {
      await this.finishAll(job, toolFailure(error, 'probe'));
      return;
    }
    await this.recordMediaInfo(job.artifact, probe);
    const audioKinds = [...job.attempts.keys()].filter((kind) => AUDIO_KINDS.has(kind));
    if (audioKinds.length > 0) await this.renderAudio(job, { sourcePath, probe, kinds: audioKinds });
    if (job.attempts.has('video-poster')) await this.renderPoster(job, { sourcePath, probe });
  }

  private async renderAudio(
    job: PreviewJob,
    input: { sourcePath: string; probe: MediaProbe; kinds: ArtifactPreviewKind[] },
  ): Promise<void> {
    if (!input.probe.audio) {
      await this.finishKinds(job, input.kinds, { status: 'skipped', error: 'no_audio_stream' });
      return;
    }
    let files: Map<ArtifactPreviewKind, PreviewFile>;
    try {
      const previews = await renderAudioPreviews({
        tools: this.options.tools,
        filePath: input.sourcePath,
        sampleRate: input.probe.audio.sampleRate,
      });
      files = new Map([
        ['waveform-peaks', { fileName: 'waveform-peaks.json', mimeType: 'application/json', body: Buffer.from(JSON.stringify(previews.peaks)) }],
        ['spectrogram', { fileName: 'spectrogram.png', mimeType: 'image/png', body: previews.spectrogramPng }],
      ]);
    } catch (error) {
      await this.finishKinds(job, input.kinds, toolFailure(error, 'render'));
      return;
    }
    for (const kind of input.kinds) await this.storePreview(job, kind, files.get(kind)!);
  }

  private async renderPoster(job: PreviewJob, input: { sourcePath: string; probe: MediaProbe }): Promise<void> {
    const video = input.probe.video;
    if (!video) {
      await this.finishKinds(job, ['video-poster'], { status: 'skipped', error: 'no_video_stream' });
      return;
    }
    let poster: Buffer;
    try {
      poster = await renderVideoPoster({
        tools: this.options.tools,
        filePath: input.sourcePath,
        durationSeconds: input.probe.durationSeconds,
        width: video.width,
      });
    } catch (error) {
      await this.finishKinds(job, ['video-poster'], toolFailure(error, 'render'));
      return;
    }
    await this.storePreview(job, 'video-poster', { fileName: 'poster.png', mimeType: 'image/png', body: poster });
  }

  private async download(artifact: Artifact, destination: string): Promise<void> {
    const content = await this.options.stores.read({ backend: artifact.backend, key: artifact.storageKey });
    await pipeline(content.body, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  }

  /**
   * Fills media info for formats the registration-time header probe does not read. A header row
   * already present is kept: ON CONFLICT DO NOTHING never overwrites it.
   */
  private async recordMediaInfo(artifact: Artifact, probe: MediaProbe): Promise<void> {
    if (!probe.audio || probe.durationSeconds === null) return;
    try {
      await this.options.database.query(
        `INSERT INTO artifact_media_info(artifact_id,project_id,duration_seconds,sample_rate,channels,
          bits_per_sample,codec,source) VALUES($1,$2,$3,$4,$5,$6,$7,'ffprobe')
         ON CONFLICT (artifact_id) DO NOTHING`,
        [
          artifact.id,
          artifact.projectId,
          probe.durationSeconds,
          probe.audio.sampleRate,
          probe.audio.channels,
          probe.audio.bitsPerSample,
          probe.audio.codec,
        ],
      );
    } catch (error) {
      logPreviewEvent('artifact_media_info_failed', { artifactId: artifact.id, name: (error as Error).name });
    }
  }

  /** Writes the file, then registers it and marks the preview ready in one transaction. */
  private async storePreview(job: PreviewJob, kind: ArtifactPreviewKind, file: PreviewFile): Promise<void> {
    const { database, stores } = this.options;
    const source = job.artifact;
    const outcome = { artifactId: source.id, kind, attempts: job.attempts.get(kind)! };
    const id = randomUUID();
    let reference: { backend: Artifact['backend']; key: string } | null = null;
    try {
      // The Project's current backend, like any new Artifact; a disabled one fails and retries.
      const backend = await projectArtifactBackend(database, source.projectId, stores);
      reference = { backend, key: `${source.projectId}/${id}/content` };
      const stored = await stores.put({ ...reference, body: Readable.from(file.body), mimeType: file.mimeType });
      const storedReference = reference;
      await transaction(database, async (connection) => {
        await registerStoredArtifact(
          connection,
          {
            id,
            projectId: source.projectId,
            runId: null,
            path: `.previews/${source.id}/${file.fileName}`,
            backend: storedReference.backend,
            storageKey: storedReference.key,
            mimeType: file.mimeType,
            size: stored.size,
            sha256: stored.sha256,
          },
          { stores },
        );
        if (!(await markPreviewReady(connection, { ...outcome, previewArtifactId: id })))
          throw new PreviewClaimLostError();
      });
    } catch (error) {
      if (reference) await stores.remove(reference).catch(() => logPreviewEvent('artifact_cleanup_failed', { artifactId: id }));
      if (error instanceof PreviewClaimLostError) return;
      logPreviewEvent('artifact_preview_store_failed', { artifactId: source.id, kind, name: (error as Error).name });
      await retryPreviewLater(database, { ...outcome, error: 'storage_failed' });
    }
  }

  private finishAll(job: PreviewJob, failure: PreviewFailure): Promise<void> {
    return this.finishKinds(job, [...job.attempts.keys()], failure);
  }

  private async finishKinds(job: PreviewJob, kinds: ArtifactPreviewKind[], failure: PreviewFailure): Promise<void> {
    for (const kind of kinds)
      await markPreviewFinished(this.options.database, {
        artifactId: job.artifact.id,
        kind,
        attempts: job.attempts.get(kind)!,
        ...failure,
      });
  }
}
