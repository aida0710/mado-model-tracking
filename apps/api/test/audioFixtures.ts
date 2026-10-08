// Builds minimal WAV and FLAC files for header probing tests; sample bytes are silence.

export interface WaveOptions {
  formatTag?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  frames?: number;
  /** WAVE_FORMAT_EXTENSIBLE with this SubFormat code and valid bits. */
  extensible?: { subFormat: number; validBits: number };
  /** Chunk placed between fmt and data, e.g. a large LIST chunk. */
  paddingChunkBytes?: number;
}

function riffChunk(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, Buffer.alloc(body.length % 2)]);
}

export function waveFile(options: WaveOptions = {}): Buffer {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 16000;
  const bits = options.bitsPerSample ?? 16;
  const blockAlign = channels * (bits / 8);
  const format = Buffer.alloc(options.extensible ? 40 : 16);
  format.writeUInt16LE(options.extensible ? 0xfffe : (options.formatTag ?? 1), 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate * blockAlign, 8);
  format.writeUInt16LE(blockAlign, 12);
  format.writeUInt16LE(bits, 14);
  if (options.extensible) {
    format.writeUInt16LE(22, 16);
    format.writeUInt16LE(options.extensible.validBits, 18);
    format.writeUInt32LE(0x3, 20);
    format.writeUInt16LE(options.extensible.subFormat, 24);
  }
  const chunks = [riffChunk('fmt ', format)];
  if (options.paddingChunkBytes) chunks.push(riffChunk('LIST', Buffer.alloc(options.paddingChunkBytes)));
  chunks.push(riffChunk('data', Buffer.alloc((options.frames ?? sampleRate) * blockAlign)));
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

export function flacFile(options: { sampleRate: number; channels: number; bitsPerSample: number; totalSamples: number }): Buffer {
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  const { sampleRate, channels, bitsPerSample, totalSamples } = options;
  streamInfo[10] = (sampleRate >> 12) & 0xff;
  streamInfo[11] = (sampleRate >> 4) & 0xff;
  streamInfo[12] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | ((bitsPerSample - 1) >> 4);
  streamInfo[13] = (((bitsPerSample - 1) & 0x0f) << 4) | Math.floor(totalSamples / 2 ** 32);
  streamInfo.writeUInt32BE(totalSamples % 2 ** 32, 14);
  // Last-metadata-block flag set, type 0 (STREAMINFO), length 34.
  const blockHeader = Buffer.from([0x80, 0, 0, 34]);
  return Buffer.concat([Buffer.from('fLaC', 'ascii'), blockHeader, streamInfo, Buffer.alloc(64)]);
}
