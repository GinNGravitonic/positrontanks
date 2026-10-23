import { describe, expect, it } from "vitest";
import { SeededRandom } from "./random.js";

function bits(v: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

describe("SeededRandom", () => {
  // Golden sequences: these pin engine-r1 forever.
  it.each([
    [0, 0, [1888058268, 1752813595, 3575008327], ["3fb96b0f823d15d0", "3fd6e20cf789da22"]],
    [42, 0, [1742624535, 3353886633, 3744483068], ["3fe38ecb129aa0e3", "3f82504a0d8a0840"]],
    [42, 1, [379468143, 3348921170, 432769252], ["3fe4fe2eddf22f0e", "3fd5aea5b5890004"]],
    [4294967295, 7, [3746753046, 2490192601, 2382661655], ["3fef16b6a5386ffb", "3fd91abf479af792"]],
  ])("seed %s stream %s gives its pinned sequence", (seed, stream, ints, floats) => {
    const rng = new SeededRandom(seed, stream);
    expect([rng.nextUint32(), rng.nextUint32(), rng.nextUint32()]).toEqual(ints);
    expect([rng.next(), rng.next()].map(bits)).toEqual(floats);
  });

  it("stream defaults to 0", () => {
    expect(new SeededRandom(42).nextUint32()).toBe(new SeededRandom(42, 0).nextUint32());
  });

  it("streams are independent of each other's calls", () => {
    const a = new SeededRandom(7, 1);
    const b = new SeededRandom(7, 2);
    const alone = new SeededRandom(7, 2);
    for (let i = 0; i < 100; i++) a.next();
    for (let i = 0; i < 10; i++) expect(b.next()).toBe(alone.next());
  });

  it("next() stays in [0, 1) and nextInt(n) in [0, n)", () => {
    const rng = new SeededRandom(123, 4);
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(v >= 0 && v < 1).toBe(true);
      const k = rng.nextInt(6);
      expect(Number.isInteger(k) && k >= 0 && k < 6).toBe(true);
    }
  });

  it("rejects seeds, streams and bounds outside their ranges", () => {
    expect(() => new SeededRandom(-1)).toThrow(RangeError);
    expect(() => new SeededRandom(2 ** 32)).toThrow(RangeError);
    expect(() => new SeededRandom(1.5)).toThrow(RangeError);
    expect(() => new SeededRandom(1, -1)).toThrow(RangeError);
    expect(() => new SeededRandom(1).nextInt(0)).toThrow(RangeError);
    expect(() => new SeededRandom(1).nextInt(2.5)).toThrow(RangeError);
  });
});
