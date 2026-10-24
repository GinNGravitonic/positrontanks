/**
 * ObjectStore backed by a local directory: key `a/b/c` is the file
 * `<root>/a/b/c`. Writes go to a temporary file in the target directory and
 * are renamed into place, so readers never see a partial object.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertValidKey, assertValidPrefix, type ObjectStore } from "./object-store.js";

const isErrno = (error: unknown, ...codes: string[]): boolean =>
  error instanceof Error && "code" in error && codes.includes(String(error.code));

export class LocalObjectStore implements ObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The file for `key`, refusing anything that would land outside the root. */
  private path(key: string): string {
    assertValidKey(key);
    const path = resolve(this.root, ...key.split("/"));
    // Defence in depth: assertValidKey already rules out `..`, absolute paths and separators.
    if (!path.startsWith(this.root + sep)) throw new Error(`Object key escapes the storage root: ${key}`);
    return path;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.tmp-${randomUUID()}`);
    try {
      await writeFile(temporary, body);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const path = this.path(key);
    try {
      const buffer = await readFile(path);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if (isErrno(error, "ENOENT", "ENOTDIR", "EISDIR")) return undefined;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const path = this.path(key);
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (isErrno(error, "ENOENT", "ENOTDIR")) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    try {
      if (!(await stat(path)).isFile()) return;
    } catch (error) {
      if (isErrno(error, "ENOENT", "ENOTDIR")) return;
      throw error;
    }
    await rm(path, { force: true });
    // Prune directories the delete left empty, so the tree mirrors the keys.
    for (let dir = dirname(path); dir !== this.root; dir = dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        break; // Not empty (or already gone): stop pruning.
      }
    }
  }

  async list(prefix = ""): Promise<string[]> {
    assertValidPrefix(prefix);
    // Only walk the deepest directory the prefix fully names.
    const slash = prefix.lastIndexOf("/");
    const start = slash < 0 ? this.root : resolve(this.root, ...prefix.slice(0, slash).split("/"));
    let entries;
    try {
      entries = await readdir(start, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT", "ENOTDIR")) return [];
      throw error;
    }
    const keys: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const key = relative(this.root, join(entry.parentPath, entry.name)).split(sep).join("/");
      if (!key.startsWith(prefix)) continue;
      try {
        assertValidKey(key); // Skips temporary files and anything else not written through this store.
      } catch {
        continue;
      }
      keys.push(key);
    }
    return keys.sort();
  }
}
