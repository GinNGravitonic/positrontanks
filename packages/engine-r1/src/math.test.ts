import { describe, expect, it } from "vitest";
import {
  acosDeg,
  asinDeg,
  atan2Deg,
  cosDeg,
  hypot,
  normalizeAbsAngle,
  normalizeAngle,
  sinDeg,
  tanDeg,
} from "./math.js";

function bits(v: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

// Golden outputs, as IEEE-754 bit patterns. These pin engine-r1 forever:
// if one changes, a frozen Ruleset would play differently (ADR-0005).
const unary: Record<keyof typeof unaryFns, [number, string][]> = {
  sinDeg: [
    [0, "0000000000000000"],
    [1, "3f91df0b2b89dd1e"],
    [7.5, "3fc0b5150f6da2d0"],
    [15, "3fd0907dc1930690"],
    [22.5, "3fd87de2a6aea963"],
    [33.3, "3fe191984d01e95b"],
    [44.999, "3fe6a08484bb5f49"],
    [45.001, "3fe6a0b848257db4"],
    [59.9, "3febaf52082dea11"],
    [89.99, "3feffffff7d2af5f"],
    [91, "3feffec097f5af8a"],
    [123.456, "3feab2a9b25a9ab9"],
    [179.5, "3f81df37c4954c21"],
    [200, "bfd5e3a8748a0bf5"],
    [271.3, "bfeffde4366ead9f"],
    [359.9, "bf5c98701025f245"],
    [-12.25, "bfcb28a3516d3a75"],
    [-135, "bfe6a09e667f3bcd"],
    [1000.75, "bfef703bd1058b52"],
    [1e-9, "3db330aa445be654"],
    [12345.678, "3feecf38ac55ffcc"],
  ],
  cosDeg: [
    [0, "3ff0000000000000"],
    [1, "3feffec097f5af8a"],
    [7.5, "3fefb9ea92ec689b"],
    [15, "3feee8dd4748bf15"],
    [22.5, "3fed906bcf328d46"],
    [33.3, "3feabeef145aa617"],
    [44.999, "3fe6a0b848257db4"],
    [45.001, "3fe6a08484bb5f49"],
    [59.9, "3fe00c603ed62ac6"],
    [89.99, "3f26e05a676cba85"],
    [91, "bf91df0b2b89dd1e"],
    [123.456, "bfe1a43870d371f9"],
    [179.5, "bfefffb02599c9cd"],
    [200, "bfee11f642522d1c"],
    [271.3, "3f973b592eea064a"],
    [359.9, "3feffffcce4c8e64"],
    [-12.25, "3fef457a2b5c83e4"],
    [-135, "bfe6a09e667f3bcd"],
    [1000.75, "3fc7e0050549a812"],
    [1e-9, "3ff0000000000000"],
    [12345.678, "bfd14b76097b9194"],
  ],
  tanDeg: [
    [0, "0000000000000000"],
    [1, "3f91dfbd9410a422"],
    [7.5, "3fc0d9fd31c98bf8"],
    [15, "3fd126145e9ecd56"],
    [22.5, "3fda827999fcef33"],
    [33.3, "3fe5052361766d10"],
    [44.999, "3fefffb6cbff36a7"],
    [45.001, "3ff000249a542038"],
    [59.9, "3ffb99f885908420"],
    [89.99, "40b66193f0cdd3e1"],
    [91, "c04ca51d76749a71"],
    [123.456, "bff836b7ec216d46"],
    [179.5, "bf81df645e10066f"],
    [200, "3fd74b49cf3902d4"],
    [271.3, "c046087665ae4b79"],
    [359.9, "bf5c9872eada828a"],
    [-12.25, "bfcbcaa1560c58a5"],
    [-135, "3ff0000000000000"],
    [1000.75, "c015119038ace5ed"],
    [1e-9, "3db330aa445be654"],
    [12345.678, "c00c80bef754706a"],
  ],
  asinDeg: [
    [-1, "c056800000000000"],
    [-0.99, "c05478fc13a61584"],
    [-0.75, "c0484b9180b27b48"],
    [-0.3, "c03175257a72ef10"],
    [0, "0000000000000000"],
    [0.1, "4016f4e91b081e45"],
    [0.25, "402cf47c7a2c0560"],
    [0.7, "404636a8112d5c60"],
    [0.875, "404e85c1c2e9fd50"],
    [0.999999, "40567ad06df13c0d"],
    [1, "4056800000000000"],
  ],
  acosDeg: [
    [-1, "4066800000000000"],
    [-0.99, "40657c7e09d30ac2"],
    [-0.75, "406152e4602c9ed2"],
    [-0.3, "405add495e9cbbc4"],
    [0, "4056800000000000"],
    [0.1, "405510b16e4f7e1c"],
    [0.25, "4052e17070ba7f54"],
    [0.7, "4046c957eed2a3a0"],
    [0.875, "403cf47c7a2c0560"],
    [0.999999, "3fb4be483b0fcd42"],
    [1, "0000000000000000"],
  ],
};

const binary: Record<keyof typeof binaryFns, [number, number, string][]> = {
  atan2Deg: [
    [1, 2, "403a90a731a61dc4"],
    [-3, 4, "c0426f58ce59e23c"],
    [5, -0.5, "4057ed7a5ba394ac"],
    [-0.25, -7, "c0663e8c037f2898"],
    [1e-10, 1, "3e389bbcd20626ed"],
    [3, 3.0000001, "40467ffff7fd4de1"],
    [1000000, -2, "40568001e0a1bfe6"],
    [-2, 1e-12, "c0567ffffffff820"],
    [0.6, 0.8, "40426f58ce59e23b"],
    [123.4, 567.8, "402885d921f45ee3"],
  ],
  hypot: [
    [1, 2, "4001e3779b97f4a8"],
    [-3, 4, "4014000000000000"],
    [5, -0.5, "401419894c2329f0"],
    [-0.25, -7, "401c0491e9ab92bf"],
    [1e-10, 1, "3ff0000000000000"],
    [3, 3.0000001, "4010f876d19e39b4"],
    [1000000, -2, "412e84800000431c"],
    [-2, 1e-12, "4000000000000000"],
    [0.6, 0.8, "3ff0000000000000"],
    [123.4, 567.8, "4082286fbc6344c3"],
  ],
};

const unaryFns = { sinDeg, cosDeg, tanDeg, asinDeg, acosDeg };
const binaryFns = { atan2Deg, hypot };

describe("golden bit outputs", () => {
  for (const [name, rows] of Object.entries(unary)) {
    const fn = unaryFns[name as keyof typeof unaryFns];
    it.each(rows)(`${name}(%s)`, (x, expected) => {
      expect(bits(fn(x))).toBe(expected);
    });
  }
  for (const [name, rows] of Object.entries(binary)) {
    const fn = binaryFns[name as keyof typeof binaryFns];
    it.each(rows)(`${name}(%s, %s)`, (a, b, expected) => {
      expect(bits(fn(a, b))).toBe(expected);
    });
  }
});

describe("exact values", () => {
  it("trig is exact at multiples of 90 and at 30 and 45", () => {
    expect([0, 90, 180, 270, 360, -90, -180, 720].map(sinDeg)).toEqual([0, 1, 0, -1, 0, -1, 0, 0]);
    expect([0, 90, 180, 270, 360, -90, -180, 720].map(cosDeg)).toEqual([1, 0, -1, 0, 1, 0, -1, 1]);
    expect(sinDeg(30)).toBe(0.5);
    expect(cosDeg(60)).toBe(0.5);
    expect(sinDeg(45)).toBe(cosDeg(45));
    expect(tanDeg(45)).toBe(1);
    expect(tanDeg(-45)).toBe(-1);
    expect(Object.is(tanDeg(180), 0)).toBe(true);
    expect(tanDeg(90)).toBe(Infinity);
    expect(tanDeg(270)).toBe(-Infinity);
  });

  it("exact zeros are +0", () => {
    for (const a of [180, 360, -180, -360, 540]) expect(Object.is(sinDeg(a), 0)).toBe(true);
    for (const a of [90, 270, -90, -270]) expect(Object.is(cosDeg(a), 0)).toBe(true);
  });

  it("atan2Deg is exact on the axes and returns (-180, 180]", () => {
    expect(atan2Deg(0, 0)).toBe(0);
    expect(atan2Deg(0, 1)).toBe(0);
    expect(atan2Deg(1, 0)).toBe(90);
    expect(atan2Deg(-1, 0)).toBe(-90);
    expect(atan2Deg(0, -1)).toBe(180);
    expect(atan2Deg(-0, -1)).toBe(180);
    expect(atan2Deg(1, 1)).toBe(45);
    expect(atan2Deg(-1, -1)).toBe(-135);
  });

  it("asinDeg and acosDeg are exact at their landmarks", () => {
    expect([-1, -0.5, 0, 0.5, 1].map(asinDeg)).toEqual([-90, -30, 0, 30, 90]);
    expect([-1, 0, 0.5, 1].map(acosDeg)).toEqual([180, 90, 60, 0]);
  });

  it("hypot gives exact Pythagorean triples", () => {
    expect(hypot(3, 4)).toBe(5);
    expect(hypot(-5, 12)).toBe(13);
    expect(hypot(0, -7)).toBe(7);
    expect(hypot(3 * 2 ** 600, 4 * 2 ** 600)).toBe(5 * 2 ** 600);
    expect(hypot(3 * 2 ** -600, -4 * 2 ** -600)).toBe(5 * 2 ** -600);
    expect(hypot(1e300, 1e-300)).toBe(1e300);
  });
});

describe("normalization", () => {
  it("normalizeAngle maps into (-180, 180]", () => {
    expect([-180, 180, 540, -540, 190, -190, 359, 0].map(normalizeAngle)).toEqual([
      180, 180, 180, 180, -170, 170, -1, 0,
    ]);
  });

  it("normalizeAbsAngle maps into [0, 360)", () => {
    expect([0, 360, -90, 725, -720].map(normalizeAbsAngle)).toEqual([0, 0, 270, 5, 0]);
    expect(Object.is(normalizeAbsAngle(-0), 0)).toBe(true);
    expect(normalizeAbsAngle(-1e-20)).toBe(0);
  });
});

describe("domain", () => {
  it("non-finite inputs give NaN", () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(sinDeg(v)).toBeNaN();
      expect(cosDeg(v)).toBeNaN();
      expect(tanDeg(v)).toBeNaN();
      expect(atan2Deg(v, 1)).toBeNaN();
      expect(atan2Deg(1, v)).toBeNaN();
      expect(hypot(v, 1)).toBeNaN();
      expect(normalizeAngle(v)).toBeNaN();
      expect(normalizeAbsAngle(v)).toBeNaN();
    }
  });

  it("asinDeg and acosDeg give NaN outside [-1, 1]", () => {
    for (const v of [1.0000001, -2, NaN]) {
      expect(asinDeg(v)).toBeNaN();
      expect(acosDeg(v)).toBeNaN();
    }
  });
});

describe("accuracy against Math", () => {
  // Math.* is not pinned, but it is accurate enough to catch a broken kernel.
  const rad = Math.PI / 180;
  const angles = Array.from({ length: 20000 }, (_, i) => (i * 0.0731) % 1440 - 720);

  it("sinDeg and cosDeg are within 1e-15", () => {
    for (const a of angles) {
      // Reduce first: a * rad loses precision for large angles.
      const r = (a % 360) * rad;
      expect(Math.abs(sinDeg(a) - Math.sin(r))).toBeLessThan(1e-15);
      expect(Math.abs(cosDeg(a) - Math.cos(r))).toBeLessThan(1e-15);
    }
  });

  it("atan2Deg, asinDeg and acosDeg are within a few ulps", () => {
    for (let i = 0; i < 20000; i++) {
      const y = Math.sin(i * 1.7) * 10 ** ((i % 9) - 4);
      const x = Math.cos(i * 0.9) * 10 ** ((i % 7) - 3);
      const expected = Math.atan2(y, x) / rad;
      expect(Math.abs(atan2Deg(y, x) - expected)).toBeLessThanOrEqual(4 * ulp(expected));
    }
    for (let i = -1000; i <= 1000; i++) {
      const x = i / 1000;
      expect(Math.abs(asinDeg(x) - Math.asin(x) / rad)).toBeLessThan(1e-13);
      expect(Math.abs(acosDeg(x) - Math.acos(x) / rad)).toBeLessThan(1e-13);
    }
  });

  it("hypot is within 2 ulps", () => {
    for (let i = 1; i < 20000; i++) {
      const x = Math.sin(i * 1.7) * 10 ** ((i % 9) - 4);
      const y = Math.cos(i * 0.9) * 10 ** ((i % 7) - 3);
      const expected = Math.hypot(x, y);
      expect(Math.abs(hypot(x, y) - expected)).toBeLessThanOrEqual(2 * ulp(expected));
    }
  });
});

function ulp(v: number): number {
  const a = Math.abs(v);
  if (a === 0) return Number.MIN_VALUE;
  return 2 ** Math.max(Math.floor(Math.log2(a)) - 52, -1074);
}
