import { MediaToolFailedError, runMediaTool } from './mediaTools.js';

/** What the preview worker needs from ffprobe; values outside sane ranges are left out. */
export interface MediaProbe {
  durationSeconds: number | null;
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
    bitsPerSample: number | null;
  } | null;
  video: { codec: string; width: number; height: number } | null;
}

// Bounds reject garbage from damaged containers instead of storing it as media info.
const MAX_DURATION_SECONDS = 31 * 24 * 60 * 60;
// DSD files decode to 352.8 kHz; 768 kHz is the highest PCM rate in use.
const MAX_SAMPLE_RATE = 768_000;
// ffmpeg's own channel layout limit for ambisonics and multichannel arrays.
const MAX_CHANNELS = 1024;
const MAX_BITS_PER_SAMPLE = 64;
// 16K video is 15360 wide; anything larger is a corrupt header.
const MAX_VIDEO_DIMENSION = 16_384;
// ffprobe codec_name values are short identifiers such as pcm_s16le, mp3, opus, h264.
const CODEC_NAME = /^[a-z0-9_.-]{1,32}$/;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ffprobe prints most numbers as strings ("44100", "12.345000"); both forms are accepted. */
function numberField(source: JsonObject, key: string): number | null {
  const value = source[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function integerInRange(source: JsonObject, key: string, max: number): number | null {
  const value = numberField(source, key);
  return value !== null && Number.isInteger(value) && value > 0 && value <= max ? value : null;
}

function durationField(source: JsonObject | undefined): number | null {
  if (!source) return null;
  const value = numberField(source, 'duration');
  return value !== null && value >= 0 && value <= MAX_DURATION_SECONDS ? value : null;
}

function codecField(stream: JsonObject): string | null {
  const value = stream.codec_name;
  return typeof value === 'string' && CODEC_NAME.test(value) ? value : null;
}

function parseAudioStream(stream: JsonObject): MediaProbe['audio'] {
  const codec = codecField(stream);
  const sampleRate = integerInRange(stream, 'sample_rate', MAX_SAMPLE_RATE);
  const channels = integerInRange(stream, 'channels', MAX_CHANNELS);
  if (!codec || !sampleRate || !channels) return null;
  // Lossy codecs report 0 here; PCM reports bits_per_sample, FLAC bits_per_raw_sample.
  const bitsPerSample =
    integerInRange(stream, 'bits_per_raw_sample', MAX_BITS_PER_SAMPLE) ??
    integerInRange(stream, 'bits_per_sample', MAX_BITS_PER_SAMPLE);
  return { codec, sampleRate, channels, bitsPerSample };
}

function parseVideoStream(stream: JsonObject): MediaProbe['video'] {
  const codec = codecField(stream);
  const width = integerInRange(stream, 'width', MAX_VIDEO_DIMENSION);
  const height = integerInRange(stream, 'height', MAX_VIDEO_DIMENSION);
  // Cover art in MP3/M4A is a one-frame "video" stream; it is not a playable video.
  const disposition = isObject(stream.disposition) ? stream.disposition : {};
  if (!codec || !width || !height || disposition.attached_pic === 1) return null;
  return { codec, width, height };
}

/**
 * Validates `ffprobe -print_format json -show_format -show_streams` output. Returns null when
 * the output is not that shape at all; individual implausible values are dropped.
 */
export function parseFfprobeOutput(output: string): MediaProbe | null {
  let document: unknown;
  try {
    document = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isObject(document) || !Array.isArray(document.streams)) return null;
  const streams = document.streams.filter(isObject);
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');
  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const audio = audioStream ? parseAudioStream(audioStream) : null;
  const video = videoStream ? parseVideoStream(videoStream) : null;
  const format = isObject(document.format) ? document.format : undefined;
  return {
    durationSeconds: durationField(format) ?? durationField(audioStream) ?? durationField(videoStream),
    audio,
    video,
  };
}

export async function probeMediaFile(probe: {
  ffprobePath: string;
  filePath: string;
  timeoutMs: number;
}): Promise<MediaProbe> {
  const output = await runMediaTool({
    command: probe.ffprobePath,
    args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', probe.filePath],
    timeoutMs: probe.timeoutMs,
  });
  const parsed = parseFfprobeOutput(output.toString('utf8'));
  if (!parsed) throw new MediaToolFailedError('output');
  return parsed;
}
