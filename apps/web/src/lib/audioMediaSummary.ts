import type { ArtifactMediaInfo } from '@mmt/contracts';

/** The audio properties the viewer lists, from decoding or, before that, from the stored header. */
export interface AudioMediaSummary {
  sampleRate: number;
  /** False when the decoder could not read the file's rate and reports its own output rate. */
  sampleRateFromFile: boolean;
  channelCount: number;
  durationSeconds: number;
}

/** Decoded values win: they describe what is actually played even if the header disagrees. */
export function summarizeAudioMedia(
  decoded: AudioMediaSummary | null,
  header: ArtifactMediaInfo | null,
): AudioMediaSummary | null {
  if (decoded) return decoded;
  if (!header) return null;
  return {
    sampleRate: header.sampleRate,
    sampleRateFromFile: true,
    channelCount: header.channels,
    durationSeconds: header.durationSeconds,
  };
}
