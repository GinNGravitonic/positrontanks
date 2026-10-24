/**
 * Password hashing and bearer token generation.
 *
 * Passwords are hashed with scrypt from `node:crypto` (no native
 * dependencies). The stored form records its own parameters,
 * `scrypt$<N>$<r>$<p>$<salt>$<hash>` with base64url salt and hash, so the
 * cost can be raised later without invalidating existing hashes.
 *
 * Session tokens and API keys are 256 random bits: far too many to guess, so
 * a single fast SHA-256 is enough to store them safely, and lets them be
 * looked up by hash. Each kind has a recognisable prefix so leaked keys are
 * easy to spot and so the server knows which table to look in.
 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function scrypt(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFC"), salt, length, { ...options, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** True if `password` matches `stored`; false for a mismatch or an unreadable hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (N === undefined || r === undefined || p === undefined || ![N, r, p].every(Number.isSafeInteger)) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (expected.length === 0) return false;
  const actual = await scrypt(password, salt, expected.length, { N, r, p });
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends the same time as checking a real password, so a failed login for
 * an unknown username cannot be told apart from a wrong password by timing.
 */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString("base64url"));
  await verifyPassword(password, await dummyHash);
}

export const SESSION_TOKEN_PREFIX = "aus_";
export const API_KEY_PREFIX = "auk_";

/** A new random bearer token with the given prefix. */
export function generateToken(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** The form a token is stored and looked up in. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}
