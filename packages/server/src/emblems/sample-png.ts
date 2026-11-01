/**
 * Builds small PNG files for tests: real, decodable images, plus raw chunks
 * to assemble malformed ones.
 */

import { crc32, deflateSync } from "node:zlib";

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** One chunk: length, type, data and a correct CRC. */
export function pngChunk(type: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

export function ihdr(width: number, height: number, bitDepth = 8, colorType = 6, interlace = 0): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data.set([bitDepth, colorType, 0, 0, interlace], 8);
  return pngChunk("IHDR", data);
}

/** IDAT for an all-transparent 8-bit RGBA image. */
export function rgbaIdat(width: number, height: number): Uint8Array {
  // Each scanline: filter byte 0, then 4 bytes per pixel.
  return pngChunk("IDAT", deflateSync(new Uint8Array(height * (1 + width * 4))));
}

/** A PNG file made of the signature and these chunks. */
export function png(...chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(PNG_SIGNATURE.length + chunks.reduce((n, c) => n + c.length, 0));
  out.set(PNG_SIGNATURE, 0);
  let at = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A valid square RGBA PNG, `size` pixels a side, with the given extra chunks before IDAT. */
export function samplePng(size = 64, ...extra: readonly Uint8Array[]): Uint8Array {
  return png(ihdr(size, size), ...extra, rgbaIdat(size, size), pngChunk("IEND"));
}

/** A tEXt metadata chunk. */
export const textChunk = (keyword: string, text: string): Uint8Array =>
  pngChunk("tEXt", new TextEncoder().encode(`${keyword}\0${text}`));
