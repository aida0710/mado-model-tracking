// Reads duration, sample rate, and channel count from WAV and FLAC headers without decoding.
// Anything that cannot be read from the header alone returns null instead of an estimate.

/** Only this many leading bytes are read; WAV chunks or FLAC blocks beyond it are not followed. */
export const AUDIO_HEADER_PROBE_BYTES = 64 * 1024;

export interface AudioHeaderInfo {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  /** Valid bits per sample; null for codecs whose samples have no fixed width. */
  bitsPerSample: number | null;
  /** ffprobe codec_name, so header and ffprobe results share one vocabulary. */
  codec: string;
}

export interface AudioHeaderProbeInput {
  /** The first bytes of the file, at most AUDIO_HEADER_PROBE_BYTES are inspected. */
  header: Uint8Array;
  /** Size of the whole file, used to bound a data chunk whose declared size runs past the end. */
  totalSize: number;
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_ALAW = 0x0006;
const WAVE_FORMAT_MULAW = 0x0007;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
// RIFF chunk header: 4-byte id and 4-byte little-endian size.
const RIFF_CHUNK_HEADER_BYTES = 8;
// The first chunk follows "RIFF", the RIFF size, and "WAVE".
const RIFF_FIRST_CHUNK_OFFSET = 12;
// WAVEFORMAT fields up to wBitsPerSample.
const WAVE_FORMAT_MIN_BYTES = 16;
// WAVEFORMATEXTENSIBLE: cbSize (2) + 22 bytes of extension ending with the SubFormat GUID.
const WAVE_FORMAT_EXTENSIBLE_MIN_BYTES = 40;
const WAVE_EXTENSIBLE_VALID_BITS_OFFSET = 18;
// The first two bytes of the SubFormat GUID carry the format code.
const WAVE_EXTENSIBLE_SUBFORMAT_OFFSET = 24;

const FLAC_STREAMINFO_TYPE = 0;
const FLAC_STREAMINFO_BYTES = 34;
// "fLaC" (4) + metadata block header (4).
const FLAC_STREAMINFO_OFFSET = 8;
const UINT32_RANGE = 2 ** 32;

function ascii(view: DataView, offset: number, length: number): string {
  if (offset + length > view.byteLength) return '';
  let value = '';
  for (let index = 0; index < length; index += 1)
    value += String.fromCharCode(view.getUint8(offset + index));
  return value;
}

interface WaveFormat {
  formatCode: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  containerBits: number;
  validBits: number;
}

function readWaveFormat(view: DataView, offset: number, size: number): WaveFormat | null {
  if (size < WAVE_FORMAT_MIN_BYTES || offset + WAVE_FORMAT_MIN_BYTES > view.byteLength) return null;
  const tag = view.getUint16(offset, true);
  const containerBits = view.getUint16(offset + 14, true);
  const format = {
    channels: view.getUint16(offset + 2, true),
    sampleRate: view.getUint32(offset + 4, true),
    blockAlign: view.getUint16(offset + 12, true),
    containerBits,
  };
  if (tag !== WAVE_FORMAT_EXTENSIBLE) return { ...format, formatCode: tag, validBits: containerBits };
  if (size < WAVE_FORMAT_EXTENSIBLE_MIN_BYTES || offset + WAVE_FORMAT_EXTENSIBLE_MIN_BYTES > view.byteLength)
    return null;
  const validBits = view.getUint16(offset + WAVE_EXTENSIBLE_VALID_BITS_OFFSET, true);
  return {
    ...format,
    formatCode: view.getUint16(offset + WAVE_EXTENSIBLE_SUBFORMAT_OFFSET, true),
    // Zero means the writer did not narrow the container width.
    validBits: validBits || containerBits,
  };
}

/** Maps a WAV format to the ffprobe codec name; null for compressed or unknown formats. */
function waveCodec(format: WaveFormat): string | null {
  const bits = format.containerBits;
  if (format.formatCode === WAVE_FORMAT_PCM) {
    if (bits === 8) return 'pcm_u8';
    if ([16, 24, 32, 64].includes(bits)) return `pcm_s${bits}le`;
    return null;
  }
  if (format.formatCode === WAVE_FORMAT_IEEE_FLOAT) return [32, 64].includes(bits) ? `pcm_f${bits}le` : null;
  if (format.formatCode === WAVE_FORMAT_ALAW && bits === 8) return 'pcm_alaw';
  if (format.formatCode === WAVE_FORMAT_MULAW && bits === 8) return 'pcm_mulaw';
  return null;
}

function probeWave(view: DataView, totalSize: number): AudioHeaderInfo | null {
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') return null;
  let format: WaveFormat | null = null;
  for (let offset = RIFF_FIRST_CHUNK_OFFSET; offset + RIFF_CHUNK_HEADER_BYTES <= view.byteLength; ) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + RIFF_CHUNK_HEADER_BYTES;
    if (id === 'fmt ') {
      format = readWaveFormat(view, body, size);
      if (!format) return null;
    } else if (id === 'data') {
      // A data chunk before fmt is malformed; the sample layout is unknown.
      if (!format) return null;
      return waveInfo(format, Math.min(size, Math.max(0, totalSize - body)));
    }
    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }
  return null;
}

function waveInfo(format: WaveFormat, dataBytes: number): AudioHeaderInfo | null {
  const codec = waveCodec(format);
  if (!codec || format.channels < 1 || format.sampleRate < 1) return null;
  if (format.blockAlign !== format.channels * (format.containerBits / 8)) return null;
  const frames = Math.floor(dataBytes / format.blockAlign);
  return {
    durationSeconds: frames / format.sampleRate,
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.validBits,
    codec,
  };
}

function probeFlac(view: DataView): AudioHeaderInfo | null {
  if (ascii(view, 0, 4) !== 'fLaC' || FLAC_STREAMINFO_OFFSET + FLAC_STREAMINFO_BYTES > view.byteLength)
    return null;
  // STREAMINFO must be the first metadata block.
  const blockType = view.getUint8(4) & 0x7f;
  const blockLength = (view.getUint8(5) << 16) | (view.getUint8(6) << 8) | view.getUint8(7);
  if (blockType !== FLAC_STREAMINFO_TYPE || blockLength !== FLAC_STREAMINFO_BYTES) return null;
  // Byte 10 of STREAMINFO onward: 20-bit rate, 3-bit channels-1, 5-bit bits-1, 36-bit samples.
  const fields = FLAC_STREAMINFO_OFFSET + 10;
  const byte0 = view.getUint8(fields);
  const byte1 = view.getUint8(fields + 1);
  const byte2 = view.getUint8(fields + 2);
  const byte3 = view.getUint8(fields + 3);
  const sampleRate = (byte0 << 12) | (byte1 << 4) | (byte2 >> 4);
  const channels = ((byte2 >> 1) & 0x07) + 1;
  const bitsPerSample = (((byte2 & 0x01) << 4) | (byte3 >> 4)) + 1;
  const totalSamples = (byte3 & 0x0f) * UINT32_RANGE + view.getUint32(fields + 4, false);
  // A zero sample count means the encoder did not know the length.
  if (sampleRate < 1 || totalSamples === 0) return null;
  return { durationSeconds: totalSamples / sampleRate, sampleRate, channels, bitsPerSample, codec: 'flac' };
}

export function probeAudioHeader(input: AudioHeaderProbeInput): AudioHeaderInfo | null {
  const length = Math.min(input.header.byteLength, AUDIO_HEADER_PROBE_BYTES);
  const view = new DataView(input.header.buffer, input.header.byteOffset, length);
  return probeWave(view, input.totalSize) ?? probeFlac(view);
}
