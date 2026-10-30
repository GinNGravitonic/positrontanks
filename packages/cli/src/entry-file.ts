/**
 * The Entry file the CLI runner reads with `--entry` (v1.md section 10).
 *
 * An Entry file is JSON describing one Entry: its Player and its Bots, each
 * with a Bot Name, a Build and a Program. The Program is either inline source
 * (`program`) or a path to a source file (`programFile`), resolved relative to
 * the Entry file:
 *
 * ```json
 * {
 *   "ruleset": "r1",
 *   "player": "alice",
 *   "bots": [
 *     {
 *       "name": "Pecker",
 *       "build": { "chassis": "scout", "components": { "gun": "pelletGun" }, "armor": { "front": null, "left": null, "right": null, "rear": null } },
 *       "programFile": "hunter.ptk"
 *     }
 *   ]
 * }
 * ```
 *
 * `ruleset` is optional; when given it must be the Game's Ruleset version.
 * `player` is optional and defaults to the file name without `.json` and
 * `.entry` (so `alice.entry.json` is Player `alice`). Entries with the same
 * Player belong to one Player, as on the server.
 *
 * Reading an Entry file only checks its shape; the Builds, Programs and
 * Point Budget are checked against the Ruleset by `loadGame` (run.ts).
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Build } from "@positrontanks/ruleset-data";

export interface EntryFileBot {
  readonly name: string;
  /** Unvalidated: checked against the Ruleset later. */
  readonly build: unknown;
  readonly program: string;
  /** Where the Program came from, for messages: the Program file, or the Entry file for inline source. */
  readonly programSource: string;
}

export interface EntryFile {
  /** The Entry file's path, for messages. */
  readonly path: string;
  readonly ruleset: string | null;
  readonly player: string;
  readonly bots: readonly EntryFileBot[];
}

/** A Bot whose Build has been validated. */
export interface ValidBot extends EntryFileBot {
  readonly build: Build;
}

/** A problem with a file the CLI was given, reported to the user as is. */
export class InputError extends Error {
  override readonly name = "InputError";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The default Player of an Entry file: its name without `.json` and `.entry`. */
export function defaultPlayer(path: string): string {
  return basename(path).replace(/\.json$/i, "").replace(/\.entry$/i, "");
}

const ENTRY_KEYS = new Set(["ruleset", "player", "bots"]);
const BOT_KEYS = new Set(["name", "build", "program", "programFile"]);

/** Reads and shape-checks an Entry file, loading any Program files it names. Throws InputError. */
export async function readEntryFile(path: string): Promise<EntryFile> {
  const text = await readText(path, "Entry file");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (e) {
    throw new InputError(`${path}: not valid JSON: ${(e as Error).message}`);
  }
  const errors: string[] = [];
  const fail = (where: string, message: string) => errors.push(`${where} ${message}`);
  if (!isRecord(input)) throw new InputError(`${path}: an Entry file must be a JSON object`);
  for (const key of Object.keys(input)) if (!ENTRY_KEYS.has(key)) fail(`entry.${key}`, "is not a known field");

  let ruleset: string | null = null;
  if (input.ruleset !== undefined) {
    if (typeof input.ruleset === "string") ruleset = input.ruleset;
    else fail("entry.ruleset", "must be a string");
  }
  let player = defaultPlayer(path);
  if (input.player !== undefined) {
    if (typeof input.player === "string" && input.player.length > 0) player = input.player;
    else fail("entry.player", "must be a non-empty string");
  }

  const bots: EntryFileBot[] = [];
  if (!Array.isArray(input.bots) || input.bots.length === 0) {
    fail("entry.bots", "must be a non-empty list of Bots");
  } else {
    for (const [i, bot] of (input.bots as unknown[]).entries()) {
      const where = `entry.bots[${String(i)}]`;
      if (!isRecord(bot)) {
        fail(where, "must be an object");
        continue;
      }
      for (const key of Object.keys(bot)) if (!BOT_KEYS.has(key)) fail(`${where}.${key}`, "is not a known field");
      const { name, build, program, programFile } = bot;
      if (typeof name !== "string" || name.length === 0) fail(`${where}.name`, "must be a non-empty string (the Bot Name)");
      if (build === undefined) fail(`${where}.build`, "is required");
      let source: { program: string; from: string } | undefined;
      if ((program === undefined) === (programFile === undefined)) {
        fail(where, "needs exactly one of program (inline source) and programFile (a path)");
      } else if (program !== undefined) {
        if (typeof program === "string") source = { program, from: path };
        else fail(`${where}.program`, "must be a string");
      } else if (typeof programFile === "string" && programFile.length > 0) {
        const file = resolve(dirname(path), programFile);
        source = { program: await readText(file, "Program file"), from: file };
      } else {
        fail(`${where}.programFile`, "must be a non-empty string");
      }
      if (typeof name === "string" && name.length > 0 && build !== undefined && source !== undefined) {
        bots.push({ name, build, program: source.program, programSource: source.from });
      }
    }
  }
  if (errors.length > 0) throw new InputError(`${path}:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  return { path, ruleset, player, bots };
}

/** Reads a UTF-8 text file, turning a failure into an InputError. */
export async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new InputError(`cannot read ${what} ${path}${code === undefined ? "" : ` (${code})`}`);
  }
}
