/**
 * Emblem image checking: PNG only, validated chunk by chunk in plain
 * TypeScript, with no image library.
 *
 * The file must be a well-formed PNG (signature, chunk lengths and CRCs,
 * chunk order) whose IHDR describes a square image of EMBLEM_MIN_SIZE to
 * EMBLEM_MAX_SIZE pixels a side. Only the chunks needed to draw the image
 * are kept (IHDR, PLTE, tRNS, IDAT, IEND); everything else, such as text,
 * EXIF and animation chunks, is dropped. The image data itself is not
 * decoded: a browser that cannot decode it shows nothing, which is harmless.
 */

import { crc32 } from "node:zlib";

export const EMBLEM_MIN_SIZE = 32;
export const EMBLEM_MAX_SIZE = 256;
/** Largest Emblem upload, in bytes. */
export const EMBLEM_MAX_BYTES = 64 * 1024;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KEPT = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
/** Bit depths allowed for each color type (PNG spec, section 11.2.2). */
const BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export type PngCheck = { readonly png: Uint8Array } | { readonly problem: string };

interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
  /** The whole chunk: length, type, data and CRC. */
  readonly raw: Uint8Array;
}

/** Checks an uploaded Emblem and returns the PNG with only the drawing chunks kept. */
export function checkEmblemPng(bytes: Uint8Array): PngCheck {
  if (bytes.length > EMBLEM_MAX_BYTES) return { problem: `must be at most ${String(EMBLEM_MAX_BYTES)} bytes` };
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    return { problem: "is not a PNG file" };
  }

  const chunks: Chunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = SIGNATURE.length;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return { problem: "ends in the middle of a chunk" };
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return { problem: "ends in the middle of a chunk" };
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (!typeBytes.every((b) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a))) {
      return { problem: "has a chunk with an invalid type" };
    }
    const type = String.fromCharCode(...typeBytes);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) {
      return { problem: `has a corrupt ${type} chunk (CRC mismatch)` };
    }
    chunks.push({ type, data: bytes.subarray(offset + 8, end - 4), raw: bytes.subarray(offset, end) });
    offset = end;
    if (type === "IEND") break;
  }
  if (offset !== bytes.length) return { problem: "has data after the IEND chunk" };

  const problem = checkChunks(chunks);
  if (problem !== undefined) return { problem };

  const kept = chunks.filter((c) => KEPT.has(c.type));
  const png = new Uint8Array(SIGNATURE.length + kept.reduce((n, c) => n + c.raw.length, 0));
  png.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const chunk of kept) {
    png.set(chunk.raw, at);
    at += chunk.raw.length;
  }
  return { png };
}

/** The first problem with the chunks' contents or order, if any. */
function checkChunks(chunks: readonly Chunk[]): string | undefined {
  const [ihdr] = chunks;
  if (ihdr?.type !== "IHDR") return "does not start with an IHDR chunk";
  if (ihdr.data.length !== 13) return "has an IHDR chunk of the wrong length";
  const header = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const [bitDepth = 0, colorType = 0, compression, filter, interlace] = ihdr.data.subarray(8);
  if (width !== height) return `must be square, not ${String(width)}×${String(height)} pixels`;
  if (width < EMBLEM_MIN_SIZE || width > EMBLEM_MAX_SIZE) {
    return `must be ${String(EMBLEM_MIN_SIZE)} to ${String(EMBLEM_MAX_SIZE)} pixels a side, not ${String(width)}`;
  }
  if (!(BIT_DEPTHS[colorType]?.includes(bitDepth) ?? false)) {
    return `has an invalid bit depth ${String(bitDepth)} for color type ${String(colorType)}`;
  }
  if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
    return "has an unknown compression, filter or interlace method";
  }

  let palette: number | undefined;
  let transparency = false;
  /** 0: before any IDAT, 1: in the IDAT run, 2: after it. */
  let idat = 0;
  for (const chunk of chunks.slice(1)) {
    const { type, data } = chunk;
    if (idat === 1 && type !== "IDAT") idat = 2;
    switch (type) {
      case "IHDR":
        return "has more than one IHDR chunk";
      case "PLTE":
        if (palette !== undefined || transparency || idat > 0) return "has a misplaced PLTE chunk";
        if (colorType === 0 || colorType === 4) return "has a PLTE chunk in a grayscale image";
        if (data.length === 0 || data.length % 3 !== 0 || data.length > 256 * 3) return "has an invalid PLTE chunk";
        palette = data.length / 3;
        break;
      case "tRNS":
        if (transparency || idat > 0 || (colorType === 3 && palette === undefined)) return "has a misplaced tRNS chunk";
        if (colorType === 4 || colorType === 6) return "has a tRNS chunk in an image with an alpha channel";
        if (
          (colorType === 0 && data.length !== 2) ||
          (colorType === 2 && data.length !== 6) ||
          (colorType === 3 && data.length > (palette ?? 0))
        ) {
          return "has an invalid tRNS chunk";
        }
        transparency = true;
        break;
      case "IDAT":
        if (idat === 2) return "has IDAT chunks that are not consecutive";
        idat = 1;
        break;
      case "IEND":
        if (data.length !== 0) return "has an invalid IEND chunk";
        break;
      default:
        // An uppercase first letter marks a critical chunk a decoder must understand.
        if (/^[A-Z]/.test(type)) return `has an unknown critical chunk ${type}`;
    }
  }
  if (chunks.at(-1)?.type !== "IEND") return "does not end with an IEND chunk";
  if (idat === 0) return "has no image data (IDAT chunk)";
  if (colorType === 3 && palette === undefined) return "is a palette image without a PLTE chunk";
  return undefined;
}
