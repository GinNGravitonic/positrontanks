/**
 * Pinned deterministic math for Ruleset r1 (ADR-0005).
 *
 * The ECMAScript spec leaves Math.sin, Math.cos, Math.atan2, Math.hypot and
 * friends implementation-approximated, so their results may differ between
 * Node versions. Everything here is built only from IEEE-754 basic arithmetic
 * (+ - * /, %, comparisons) and Math.sqrt, whose results the spec fixes
 * exactly, so outputs are bit-identical everywhere.
 *
 * Math.floor, ceil, round, abs, min, max and sqrt are also exactly specified
 * and may be used directly; they are not wrapped here.
 *
 * Angles are in degrees, as in the language and the engine. Reduction is
 * done in degrees, which is exact, so multiples of 90 give exact results:
 * sinDeg(180) is 0, cosDeg(90) is 0, atan2Deg(0, -1) is 180.
 *
 * Non-finite inputs give NaN, and results may be NaN or ±Infinity (for
 * example tanDeg(90)); callers such as the language turn those into errors.
 *
 * Do not change any output of this module once engine-r1 is released.
 * Golden bit outputs are pinned in math.test.ts.
 */

const DEG_TO_RAD = 0.017453292519943295; // Math.PI / 180
const RAD_TO_DEG = 57.29577951308232; // 180 / Math.PI
const SQRT1_2 = 0.7071067811865476;
const SQRT3_2 = 0.8660254037844386;

// Kernel polynomials from fdlibm (k_sin.c, k_cos.c, s_atan.c), valid on
// [-pi/4, pi/4] for sin and cos.
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

const ATAN_HI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1,
  9.82793723247329054082e-1, 1.57079632679489655800,
] as const;
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17,
  1.39033110312309984516e-17, 6.12323399573676603587e-17,
] as const;
const AT0 = 3.33333333333329318027e-1;
const AT1 = -1.99999999998764832476e-1;
const AT2 = 1.42857142725034663711e-1;
const AT3 = -1.11111104054623557880e-1;
const AT4 = 9.09088713343650656196e-2;
const AT5 = -7.69187620504482999495e-2;
const AT6 = 6.66107313738753120669e-2;
const AT7 = -5.83357013379057348645e-2;
const AT8 = 4.97687799461593236017e-2;
const AT9 = -3.65315727442169155270e-2;
const AT10 = 1.62858201153657823623e-2;

/** sin(x) for x in radians, |x| <= pi/4. */
function kernelSin(x: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
}

/** cos(x) for x in radians, |x| <= pi/4. */
function kernelCos(x: number): number {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const one = 1 - hz;
  return one + (1 - one - hz + z * r);
}

/** atan(x) in radians for x >= 0. */
function atanNonNegative(x: number): number {
  if (x < 7.450580596923828e-9) return x; // 2^-27: atan(x) rounds to x
  let id: number;
  let t: number;
  if (x < 0.4375) {
    id = -1;
    t = x;
  } else if (x < 0.6875) {
    id = 0;
    t = (2 * x - 1) / (2 + x);
  } else if (x < 1.1875) {
    id = 1;
    t = (x - 1) / (x + 1);
  } else if (x < 2.4375) {
    id = 2;
    t = (x - 1.5) / (1 + 1.5 * x);
  } else {
    id = 3;
    t = -1 / x;
  }
  const z = t * t;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return t - t * (s1 + s2);
  const hi = ATAN_HI[id] as number;
  const lo = ATAN_LO[id] as number;
  return hi - (t * (s1 + s2) - lo - t);
}

/** sin of t degrees, t in [0, 90). */
function sinQuadrant(t: number): number {
  if (t > 45) return cosOctant(90 - t); // exact subtraction (Sterbenz)
  return sinOctant(t);
}

/** cos of t degrees, t in [0, 90). */
function cosQuadrant(t: number): number {
  if (t > 45) return sinOctant(90 - t);
  return cosOctant(t);
}

/** sin of t degrees, t in [0, 45]. */
function sinOctant(t: number): number {
  if (t === 30) return 0.5;
  if (t === 45) return SQRT1_2;
  return kernelSin(t * DEG_TO_RAD);
}

/** cos of t degrees, t in [0, 45]. */
function cosOctant(t: number): number {
  if (t === 30) return SQRT3_2;
  if (t === 45) return SQRT1_2;
  return kernelCos(t * DEG_TO_RAD);
}

/**
 * Splits a >= 0 degrees into a quadrant q in 0..3 and an offset t in [0, 90)
 * with a ≡ 90q + t (mod 360). Every step is exact.
 */
function reduce(a: number): [q: number, t: number] {
  const r = a % 360;
  if (r < 90) return [0, r];
  if (r < 180) return [1, r - 90];
  if (r < 270) return [2, r - 180];
  return [3, r - 270];
}

// 0 - v rather than -v, so that exact zeros come out as +0.
function negate(v: number): number {
  return 0 - v;
}

function sinNonNegative(a: number): number {
  const [q, t] = reduce(a);
  switch (q) {
    case 0:
      return sinQuadrant(t);
    case 1:
      return cosQuadrant(t);
    case 2:
      return negate(sinQuadrant(t));
    default:
      return negate(cosQuadrant(t));
  }
}

function cosNonNegative(a: number): number {
  const [q, t] = reduce(a);
  switch (q) {
    case 0:
      return cosQuadrant(t);
    case 1:
      return negate(sinQuadrant(t));
    case 2:
      return negate(cosQuadrant(t));
    default:
      return sinQuadrant(t);
  }
}

/** Sine of an angle in degrees. */
export function sinDeg(a: number): number {
  if (!Number.isFinite(a)) return NaN;
  return a < 0 ? negate(sinNonNegative(-a)) : sinNonNegative(a);
}

/** Cosine of an angle in degrees. */
export function cosDeg(a: number): number {
  if (!Number.isFinite(a)) return NaN;
  return cosNonNegative(a < 0 ? -a : a);
}

/** Tangent of an angle in degrees; ±Infinity at odd multiples of 90. */
export function tanDeg(a: number): number {
  if (!Number.isFinite(a)) return NaN;
  const abs = a < 0 ? -a : a;
  const t = sinNonNegative(abs) / cosNonNegative(abs) + 0; // tanDeg(180) is +0
  return a < 0 ? negate(t) : t;
}

/**
 * Angle of the point (x, y) in degrees, counter-clockwise from +x, in
 * (-180, 180]. atan2Deg(0, 0) is 0.
 */
export function atan2Deg(y: number, x: number): number {
  if (!Number.isFinite(y) || !Number.isFinite(x)) return NaN;
  if (y === 0 && x === 0) return 0;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  let d =
    ay <= ax
      ? atanNonNegative(ay / ax) * RAD_TO_DEG
      : 90 - atanNonNegative(ax / ay) * RAD_TO_DEG;
  if (x < 0) d = 180 - d;
  return y < 0 ? negate(d) : d;
}

/** Arcsine in degrees, in [-90, 90]; NaN outside [-1, 1]. */
export function asinDeg(x: number): number {
  if (!(x >= -1 && x <= 1)) return NaN;
  if (x === 0.5) return 30; // match sinDeg(30) === 0.5
  if (x === -0.5) return -30;
  return atan2Deg(x, Math.sqrt((1 - x) * (1 + x)));
}

/** Arccosine in degrees, in [0, 180]; NaN outside [-1, 1]. */
export function acosDeg(x: number): number {
  if (!(x >= -1 && x <= 1)) return NaN;
  return atan2Deg(Math.sqrt((1 - x) * (1 + x)), x);
}

/** sqrt(x² + y²) without needless overflow or underflow. */
export function hypot(x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const big = ax > ay ? ax : ay;
  // Scaling by a power of two is exact, so it only guards the squares.
  if (big > TWO_POW_500) return hypotScaled(ax, ay, TWO_POW_MINUS_600);
  if (big < TWO_POW_MINUS_500) return hypotScaled(ax, ay, TWO_POW_600);
  return Math.sqrt(ax * ax + ay * ay);
}

const TWO_POW_500 = 2 ** 500;
const TWO_POW_MINUS_500 = 2 ** -500;
const TWO_POW_600 = 2 ** 600;
const TWO_POW_MINUS_600 = 2 ** -600;

function hypotScaled(ax: number, ay: number, scale: number): number {
  const sx = ax * scale;
  const sy = ay * scale;
  return Math.sqrt(sx * sx + sy * sy) / scale;
}

/** An angle in degrees normalized into (-180, 180]. Exact. */
export function normalizeAngle(a: number): number {
  if (!Number.isFinite(a)) return NaN;
  const r = a % 360;
  if (r <= -180) return r + 360;
  if (r > 180) return r - 360;
  return r;
}

/** An angle in degrees normalized into [0, 360). */
export function normalizeAbsAngle(a: number): number {
  if (!Number.isFinite(a)) return NaN;
  const r = a % 360;
  if (r >= 0) return r + 0; // + 0 turns -0 into +0
  const n = r + 360;
  return n === 360 ? 0 : n; // tiny negative angles round up to 360
}
