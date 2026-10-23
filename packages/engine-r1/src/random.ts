/**
 * Pinned seeded random numbers for Ruleset r1.
 *
 * xoshiro128** seeded through SplitMix32, using only 32-bit integer
 * operations, so sequences are identical on every JavaScript engine. Each
 * stream (such as one per Bot) is derived from the Game seed and a stream id,
 * and streams never affect each other.
 *
 * Do not change any output of this module once engine-r1 is released.
 * Golden sequences are pinned in random.test.ts.
 */

const TWO_POW_26 = 67108864;
const TWO_POW_53 = 9007199254740992;

function assertUint32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an integer in [0, 2^32), got ${String(value)}`);
  }
}

/** The SplitMix32 / murmur3 finalizer: a bijective 32-bit mix. */
function mix32(x: number): number {
  let z = x;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export class SeededRandom {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;

  /** A stream derived from `seed` and `stream`, both integers in [0, 2^32). */
  constructor(seed: number, stream = 0) {
    assertUint32("seed", seed);
    assertUint32("stream", stream);
    let state = mix32(seed ^ mix32(stream ^ 0x632be5ab));
    const next = (): number => {
      state = (state + 0x9e3779b9) >>> 0;
      return mix32(state);
    };
    this.#s0 = next();
    this.#s1 = next();
    this.#s2 = next();
    this.#s3 = next();
    if ((this.#s0 | this.#s1 | this.#s2 | this.#s3) === 0) this.#s0 = 1;
  }

  /** The next integer in [0, 2^32). */
  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.#s1, 5), 7), 9) >>> 0;
    const t = this.#s1 << 9;
    this.#s2 ^= this.#s0;
    this.#s3 ^= this.#s1;
    this.#s1 ^= this.#s2;
    this.#s0 ^= this.#s3;
    this.#s2 ^= t;
    this.#s3 = rotl(this.#s3, 11);
    return result;
  }

  /** The next number in [0, 1), with 53 random bits. */
  next(): number {
    const hi = this.nextUint32() >>> 5; // 27 bits
    const lo = this.nextUint32() >>> 6; // 26 bits
    return (hi * TWO_POW_26 + lo) / TWO_POW_53;
  }

  /** The next integer in [0, n), for an integer n in [1, 2^32]. */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 0x100000000) {
      throw new RangeError(`n must be an integer in [1, 2^32], got ${String(n)}`);
    }
    return Math.floor(this.next() * n);
  }
}
