import { crc32, deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BIT_DEPTH = 8;
const COLOR_TYPE_RGB = 2;
const BYTES_PER_PIXEL = 3;
const FILTER_NONE = 0;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

/** Encodes 8-bit RGB pixels (row-major, top row first) as a PNG without a native image library. */
export function encodeRgbPng(image: { width: number; height: number; pixels: Uint8Array }): Buffer {
  const { width, height, pixels } = image;
  if (width < 1 || height < 1 || pixels.length !== width * height * BYTES_PER_PIXEL)
    throw new RangeError('pixels must hold width × height RGB triples');
  const rowBytes = width * BYTES_PER_PIXEL;
  const scanlines = Buffer.alloc(height * (rowBytes + 1));
  for (let row = 0; row < height; row += 1) {
    scanlines[row * (rowBytes + 1)] = FILTER_NONE;
    scanlines.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = BIT_DEPTH;
  header[9] = COLOR_TYPE_RGB;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
