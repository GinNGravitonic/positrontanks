/**
 * Object storage for blobs (ADR-0003): Game Records, Replays and, later,
 * images. Structured data stays in SQLite; anything large or write-once goes
 * here, keyed by a slash-separated path such as `games/<id>/record.json`.
 *
 * Bodies are whole byte arrays rather than streams. Game Records are a few
 * kilobytes and Replays at most a few megabytes, and both are produced and
 * consumed whole (serialised once at Game end, parsed whole on load or
 * resume), so streaming would add complexity on both backends without saving
 * anything. Whole-object writes also make atomicity simple: a reader sees the
 * old object or the new one, never a partial write.
 */

export interface ObjectStore {
  /** Stores `body` under `key`, replacing any existing object. */
  put(key: string, body: Uint8Array): Promise<void>;
  /** The object's bytes, or undefined if there is no object at `key`. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;
  /** Removes the object at `key`; removing a missing object is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Every key starting with `prefix` (plain string prefix, as in S3; pass
   * `games/` for everything under `games`), in ascending order.
   */
  list(prefix?: string): Promise<string[]>;
}

/** Thrown for a key or prefix that is not in the safe key alphabet. */
export class InvalidKeyError extends Error {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`Invalid object key ${JSON.stringify(key)}: ${reason}`);
    this.name = "InvalidKeyError";
  }
}

export const maxKeyLength = 512;

/**
 * A key segment: letters, digits, `.`, `_` and `-`, not starting with `.`.
 * Banning a leading dot rules out `.` and `..` (so no path traversal) and
 * keeps the local backend's temporary files out of the key space. Callers
 * should use one letter case per key, since the local backend may run on a
 * case-insensitive file system.
 */
const segmentPattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Keys are one or more non-empty segments joined by `/`. A key must not also
 * be a leading segment path of another key (`games/1` and `games/1/record`),
 * because the local backend stores keys as nested files and directories.
 */
export function assertValidKey(key: string): void {
  if (key.length === 0) throw new InvalidKeyError(key, "must not be empty");
  if (key.length > maxKeyLength) throw new InvalidKeyError(key, `must be at most ${String(maxKeyLength)} characters`);
  for (const segment of key.split("/")) {
    if (!segmentPattern.test(segment)) {
      throw new InvalidKeyError(key, "segments must be non-empty, use only A-Z a-z 0-9 . _ - and not start with '.'");
    }
  }
}

/** A list prefix is empty, or a key, or a key followed by `/`. */
export function assertValidPrefix(prefix: string): void {
  if (prefix === "") return;
  assertValidKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}
