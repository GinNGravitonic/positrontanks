/**
 * Golden Games: fixed Maps, Designs and seeds under the real r1 Ruleset,
 * played and compared against checked-in expectations, so any change in
 * engine-r1 (or interpreter) behaviour fails here (v1.md section 11).
 *
 * Each `golden/<name>.json` holds the Game Record of one golden Game (its
 * inputs, plus the operations each Program used per Tick and the result) and
 * the expected world hashes, event counts and digests of the Replay and the
 * Program logs. The test replays the stored Game Record, so the inputs it
 * plays are exactly the checked-in ones.
 *
 * Updating the goldens must be a deliberate act. When an engine change is
 * meant to change behaviour (which, for a released Ruleset, it normally must
 * not: ADR-0001), regenerate them from the definitions in golden-games.ts with
 *
 *     pnpm golden:update
 *
 * (or set `AUMOHTA_UPDATE_GOLDENS=1` for a test run), review the
 * diff of `packages/engine-r1/golden/`, and commit it with the change.
 * Adding, editing or removing a golden Game is done the same way, in
 * golden-games.ts.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { validateBuild } from "@aumohta/ruleset-data";
import { loadRuleset } from "@aumohta/ruleset-data/rulesets";
import { describe, expect, it } from "vitest";
import { createGame, playTick, type Game } from "./game.js";
import { GOLDEN_GAMES, type GoldenGame } from "./golden-games.js";
import { hashWorld } from "./hash.js";
import { gameRecord, replayGame, replayOf, type GameRecord } from "./record.js";

const r1 = loadRuleset("r1");
// `pnpm golden:update` runs Vitest with `--mode update-goldens`, which Vitest exposes as MODE.
const UPDATE = process.env["MODE"] === "update-goldens" || process.env["AUMOHTA_UPDATE_GOLDENS"] === "1";
const goldenDir = new URL("../golden/", import.meta.url);

/** World hashes are kept for Tick 0, every `HASH_EVERY` Ticks, and the last Tick. */
const HASH_EVERY = 25;

interface Expected {
  /** Events of each type over the whole Game, from the init phase. */
  readonly eventCounts: Readonly<Record<string, number>>;
  /** How each Bot's Program runs ended, by Bot Name. */
  readonly programRuns: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** `hashWorld` after the Ticks listed, by Tick. */
  readonly worldHashes: Readonly<Record<string, string>>;
  /** SHA-256 of every Tick's `hashWorld`, from Tick 0, one per line. */
  readonly allWorldHashes: string;
  /** SHA-256 of the Replay's JSON. */
  readonly replay: string;
  /** SHA-256 of the Program logs' JSON. */
  readonly programLogs: string;
}

interface GoldenFile {
  readonly name: string;
  readonly description: string;
  readonly record: GameRecord;
  readonly expected: Expected;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Drops what JSON cannot hold (such as -0), so live values compare with stored ones. */
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Plays `game` to its end, returning what is checked of it. */
function observe(game: Game): { record: GameRecord; expected: Expected } {
  const hashes = [hashWorld(game.world)];
  while (game.result === null) {
    playTick(game);
    hashes.push(hashWorld(game.world));
  }
  const last = hashes.length - 1;
  const worldHashes: Record<string, string> = {};
  hashes.forEach((h, tick) => {
    if (tick % HASH_EVERY === 0 || tick === last) worldHashes[String(tick)] = h;
  });
  const eventCounts: Record<string, number> = {};
  for (const tick of game.history) for (const e of tick.events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
  const programRuns: Record<string, Record<string, number>> = {};
  for (const log of game.logs) {
    const counts: Record<string, number> = {};
    for (const { result } of log.runs) {
      const key = result.halt === null ? result.outcome : "halted";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    programRuns[log.name] = counts;
  }
  return {
    record: viaJson(gameRecord(game)),
    expected: {
      eventCounts: sortKeys(eventCounts),
      programRuns,
      worldHashes,
      allWorldHashes: sha256(hashes.join("\n")),
      replay: sha256(JSON.stringify(replayOf(game))),
      programLogs: sha256(JSON.stringify(game.logs)),
    },
  };
}

function sortKeys<T>(r: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The inputs of a golden Game, as its Game Record holds them. */
function inputs(g: GoldenGame | GameRecord): unknown {
  return viaJson({
    map: g.map,
    entries: g.entries.map((e, i) => ({ player: e.player ?? `entry:${String(i)}`, bots: e.bots.map((b) => ({ name: b.name, build: b.build, program: b.program })) })),
    seed: g.seed,
    timeLimitTicks: g.timeLimitTicks,
  });
}

const plain = (v: unknown) => v === null || typeof v !== "object";

/** JSON on one line, with a space after each comma and colon. */
function oneLine(value: unknown): string {
  if (plain(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(oneLine).join(", ")}]`;
  const fields = Object.entries(value as Record<string, unknown>);
  return fields.length === 0 ? "{}" : `{ ${fields.map(([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`).join(", ")} }`;
}

/** JSON with two-space indents, but lists of plain values and other short values on one line. */
function format(value: unknown, indent = ""): string {
  const line = oneLine(value);
  if (plain(value) || (Array.isArray(value) && value.every(plain)) || indent.length + line.length <= 120) return line;
  const inner = indent + "  ";
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + format(v, inner)).join(",\n")}\n${indent}]`;
  const fields = Object.entries(value as Record<string, unknown>);
  return `{\n${fields.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${format(v, inner)}`).join(",\n")}\n${indent}}`;
}

/** Plays every definition afresh and rewrites `golden/`. */
function regenerate(): void {
  mkdirSync(goldenDir, { recursive: true });
  const names = new Set(GOLDEN_GAMES.map((g) => g.name));
  for (const file of readdirSync(goldenDir)) {
    if (file.endsWith(".json") && !names.has(file.slice(0, -5))) rmSync(new URL(file, goldenDir));
  }
  for (const def of GOLDEN_GAMES) {
    for (const entry of def.entries) {
      for (const bot of entry.bots) {
        const validated = validateBuild(r1, bot.build);
        if (!validated.ok) throw new Error(`golden Game ${def.name}: the Build of ${bot.name} is invalid: ${JSON.stringify(validated.errors)}`);
      }
    }
    const game = createGame({ ruleset: r1, map: def.map, entries: def.entries, seed: def.seed, timeLimitTicks: def.timeLimitTicks });
    const file: GoldenFile = { name: def.name, description: def.description, ...observe(game) };
    writeFileSync(new URL(`${def.name}.json`, goldenDir), format(file) + "\n");
  }
}

if (UPDATE) regenerate();

function readGolden(name: string): GoldenFile {
  return JSON.parse(readFileSync(new URL(`${name}.json`, goldenDir), "utf8")) as GoldenFile;
}

const UPDATE_HINT = "if this change in behaviour is intended, run `pnpm golden:update` and review the diff";

describe("the golden Games", () => {
  it("are exactly the definitions in golden-games.ts, with the same inputs", () => {
    const files = readdirSync(goldenDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    expect(files, UPDATE_HINT).toEqual(GOLDEN_GAMES.map((g) => g.name).sort());
    for (const def of GOLDEN_GAMES) expect(inputs(readGolden(def.name).record), `${def.name}: ${UPDATE_HINT}`).toEqual(inputs(def));
  });

  it("are varied: every end of a Game, a Draw, every weapon category and Terrain of r1 appears", () => {
    const records = GOLDEN_GAMES.map((g) => readGolden(g.name).record);
    const ends = new Set(records.map((r) => r.result?.end));
    expect(ends).toEqual(new Set(["lastStanding", "noneStanding", "timeLimit"]));
    expect(records.some((r) => r.result?.winner === null), "some golden Game ends in a Draw").toBe(true);
    const components = new Set(records.flatMap((r) => r.entries.flatMap((e) => e.bots.flatMap((b) => Object.values(b.build.components)))));
    const categories = new Set(r1.components.filter((c) => components.has(c.id) && c.kind === "weapon").map((c) => c.stats["category"]));
    expect(categories).toEqual(new Set(["melee", "projectile", "beam"]));
    const terrains = new Set(records.flatMap((r) => [r.map.baseTerrain, ...r.map.terrainRegions.map((t) => t.terrain)]));
    expect(terrains).toEqual(new Set(r1.terrains.map((t) => t.name)));
  });
});

describe.each(GOLDEN_GAMES.map((g) => g.name))("the golden Game %s", (name) => {
  const golden = readGolden(name);
  // replayGame also checks that every Bot starts where the record says.
  const played = observe(replayGame(golden.record, r1, 0));

  it("ends with the recorded result in the recorded Tick", () => {
    expect({ tick: played.record.tick, result: played.record.result }, UPDATE_HINT).toEqual({ tick: golden.record.tick, result: golden.record.result });
  });

  it("produces the recorded events and Program runs", () => {
    expect({ eventCounts: played.expected.eventCounts, programRuns: played.expected.programRuns }, UPDATE_HINT).toEqual({
      eventCounts: golden.expected.eventCounts,
      programRuns: golden.expected.programRuns,
    });
  });

  it("reaches the recorded world state at every Tick", () => {
    expect(played.expected.worldHashes, UPDATE_HINT).toEqual(golden.expected.worldHashes);
    expect(played.expected.allWorldHashes, UPDATE_HINT).toBe(golden.expected.allWorldHashes);
  });

  it("uses the recorded operations every Tick", () => {
    expect(played.record.operations, UPDATE_HINT).toEqual(golden.record.operations);
  });

  it("produces the recorded Replay and Program logs", () => {
    expect(played.expected.replay, UPDATE_HINT).toBe(golden.expected.replay);
    expect(played.expected.programLogs, UPDATE_HINT).toBe(golden.expected.programLogs);
  });
});
