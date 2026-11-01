import { describe, expect, it } from "vitest";
import { checkImagePng, IMAGE_MAX_BYTES } from "./png.js";
import { ihdr, png, pngChunk, rgbaIdat, samplePng, textChunk } from "./sample-png.js";

const problemOf = (bytes: Uint8Array): string | undefined => {
  const result = checkImagePng(bytes);
  return "problem" in result ? result.problem : undefined;
};

describe("checkImagePng", () => {
  it("accepts a square PNG of 32 to 256 pixels unchanged", () => {
    for (const size of [32, 64, 256]) {
      const file = samplePng(size);
      expect(checkImagePng(file)).toEqual({ png: file });
    }
  });

  it("drops metadata chunks and keeps the drawing chunks in order", () => {
    const palette = pngChunk("PLTE", Uint8Array.of(0, 0, 0, 255, 255, 255));
    const alpha = pngChunk("tRNS", Uint8Array.of(0));
    const idat = pngChunk("IDAT", Uint8Array.of(1, 2, 3));
    const iend = pngChunk("IEND");
    const exif = pngChunk("eXIf", Uint8Array.of(1));
    const file = png(ihdr(32, 32, 8, 3), textChunk("Author", "Ada"), palette, alpha, exif, idat, textChunk("Comment", "hi"), iend);
    expect(checkImagePng(file)).toEqual({ png: png(ihdr(32, 32, 8, 3), palette, alpha, idat, iend) });
  });

  it("accepts IDAT split over several chunks", () => {
    const idat = (byte: number) => pngChunk("IDAT", Uint8Array.of(byte));
    expect(problemOf(png(ihdr(32, 32), idat(1), idat(2), pngChunk("IEND")))).toBeUndefined();
  });

  it("rejects files that are not PNGs", () => {
    expect(problemOf(new TextEncoder().encode("GIF89a........"))).toBe("is not a PNG file");
    expect(problemOf(new Uint8Array())).toBe("is not a PNG file");
  });

  it("rejects files over the size limit", () => {
    const big = samplePng(64, pngChunk("zzZz", new Uint8Array(IMAGE_MAX_BYTES)));
    expect(problemOf(big)).toMatch(/at most/);
  });

  it("rejects non-square and out-of-range sizes", () => {
    expect(problemOf(png(ihdr(64, 32), rgbaIdat(64, 32), pngChunk("IEND")))).toMatch(/must be square/);
    expect(problemOf(samplePng(31))).toMatch(/32 to 256 pixels/);
    expect(problemOf(samplePng(257))).toMatch(/32 to 256 pixels/);
  });

  it("rejects a corrupt CRC", () => {
    const file = samplePng(32);
    const last = file.length - 1;
    file[last] = (file[last] ?? 0) ^ 0xff;
    expect(problemOf(file)).toMatch(/corrupt IEND chunk/);
  });

  it("rejects truncated files and data after IEND", () => {
    const file = samplePng(32);
    expect(problemOf(file.subarray(0, file.length - 4))).toMatch(/middle of a chunk/);
    expect(problemOf(png(ihdr(32, 32), rgbaIdat(32, 32)))).toMatch(/IEND/);
    const trailing = new Uint8Array(file.length + 3);
    trailing.set(file);
    expect(problemOf(trailing)).toMatch(/after the IEND/);
  });

  it("rejects chunks out of order", () => {
    const idat = rgbaIdat(32, 32);
    const iend = pngChunk("IEND");
    const palette = pngChunk("PLTE", Uint8Array.of(0, 0, 0));
    expect(problemOf(png(idat, ihdr(32, 32), iend))).toMatch(/start with an IHDR/);
    expect(problemOf(png(ihdr(32, 32), ihdr(32, 32), idat, iend))).toMatch(/more than one IHDR/);
    expect(problemOf(png(ihdr(32, 32, 8, 2), idat, palette, iend))).toMatch(/misplaced PLTE/);
    expect(problemOf(png(ihdr(32, 32), idat, textChunk("a", "b"), idat, iend))).toMatch(/not consecutive/);
    expect(problemOf(png(ihdr(32, 32, 8, 3), idat, iend))).toMatch(/without a PLTE/);
    expect(problemOf(png(ihdr(32, 32), iend))).toMatch(/no image data/);
  });

  it("rejects invalid headers and unknown critical chunks", () => {
    const rest = [rgbaIdat(32, 32), pngChunk("IEND")];
    expect(problemOf(png(ihdr(32, 32, 7, 6), ...rest))).toMatch(/bit depth/);
    expect(problemOf(png(ihdr(32, 32, 8, 6, 2), ...rest))).toMatch(/interlace/);
    expect(problemOf(png(ihdr(32, 32), pngChunk("ABCD"), ...rest))).toMatch(/unknown critical chunk ABCD/);
  });
});
