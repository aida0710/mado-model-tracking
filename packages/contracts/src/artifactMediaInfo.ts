/**
 * Audio properties of an Artifact. 'header' is read from WAV/FLAC headers at registration without
 * decoding; 'ffprobe' is added later by the preview worker for other formats and never replaces it.
 */
export interface ArtifactMediaInfo {
  artifactId: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  /** null for codecs without a fixed sample width. */
  bitsPerSample: number | null;
  /** ffprobe codec_name, e.g. pcm_s16le or flac. */
  codec: string;
  source: 'header' | 'ffprobe';
}

/** Maximum artifactIds per GET /projects/:p/artifact-media-info request. */
export const ARTIFACT_MEDIA_INFO_BATCH_LIMIT = 200;
