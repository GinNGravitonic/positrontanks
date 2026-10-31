import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replayGame, tickCostCheck, type GameRecord, type GameResult, type Replay, type TickCost } from "@positrontanks/engine-r1";
import { validateBuild } from "@positrontanks/ruleset-data";
import { loadRuleset, RULESET_VERSIONS } from "@positrontanks/ruleset-data/rulesets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RULESET, main, USAGE, type Io } from "./cli.js";
import type { BudgetPeak } from "./report.js";

const examples = fileURLToPath(new URL("../examples/", import.meta.url));
const duelMap = fileURLToPath(new URL("../../ruleset-data/maps/duel.json", import.meta.url));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "positrontanks-cli-"));
  for (const file of ["alice.entry.json", "bob.entry.json", "hunter.ptk", "rammer.ptk"]) await copyFile(join(examples, file), join(dir, file));
  await copyFile(duelMap, join(dir, "duel.json"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
  const code = await main(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const at = (file: string) => join(dir, file);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(at(file), "utf8")) as T;

/** The example duel, unthrottled, with a fixed seed, writing into `out`. */
function duel(out = "out", ...extra: string[]): Promise<Run> {
  return cli("run", "--map", at("duel.json"), "--entry", at("alice.entry.json"), "--entry", at("bob.entry.json"), "--unthrottled", "--seed", "1", "--out", at(out), ...extra);
}

const none = { front: null, left: null, right: null, rear: null };
const scout = { chassis: "scout", components: { gun: "pelletGun", eye: "shortRadar", drive: "wheels" }, armor: none };

describe("positrontanks run", () => {
  it("plays a two-Entry Game from files and writes its Game Record, Replay and Program logs", async () => {
    const run = await duel();
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.out).toContain("seed 1");
    expect(run.out).toMatch(/^Result: (alice|bob) wins|^Result: Draw/m);
    expect(run.out).toContain("Budget peaks (operations per Tick):");
    expect(run.out).toMatch(/Pecker\s+alice\s+\d+\/50000/);
    expect(run.out).toMatch(/Anvil\s+bob\s+\d+\/50000/);

    const record = await readJson<GameRecord>("out/game-record.json");
    const replay = await readJson<Replay>("out/replay.json");
    const logs = await readJson<{ name: string; runs: { tick: number }[] }[]>("out/program-logs.json");

    expect(record.ruleset).toBe("r1");
    expect(record.seed).toBe(1);
    expect(record.timeLimitTicks).toBe(1200);
    expect(record.entries.map((e) => e.player)).toEqual(["alice", "bob"]);
    expect(record.entries[0]?.bots[0]?.program).toBe(await readFile(at("hunter.ptk"), "utf8"));
    expect(record.result).not.toBeNull();
    expect(replay.result).toEqual(record.result);
    expect(replay.ticks).toHaveLength((record.result?.tick ?? 0) + 1);
    expect(JSON.stringify(replay)).not.toContain("function tick");
    expect(logs.map((l) => l.name)).toEqual(["Pecker", "Anvil"]);
    expect(logs[1]?.runs[0]?.tick).toBe(0);

    // The Game Record reproduces the Game exactly.
    const replayed = replayGame(record, loadRuleset("r1"));
    expect(replayed.result).toEqual(record.result);
  });

  it("plays the same Game again from the same seed", async () => {
    await duel("a");
    await duel("b");
    expect(await readFile(at("b/game-record.json"), "utf8")).toBe(await readFile(at("a/game-record.json"), "utf8"));
    expect(await readFile(at("b/replay.json"), "utf8")).toBe(await readFile(at("a/replay.json"), "utf8"));
  });

  it("prints a JSON summary with --json", async () => {
    const run = await duel("out", "--json");
    expect(run.code).toBe(0);
    const summary = JSON.parse(run.out) as { seed: number; result: GameResult; budgetPeaks: BudgetPeak[]; costs: number[]; files: { record: string } };
    expect(summary.seed).toBe(1);
    expect(summary.costs).toEqual([74, 181]);
    expect(summary.result).toEqual((await readJson<GameRecord>("out/game-record.json")).result);
    expect(summary.budgetPeaks.map((p) => [p.name, p.player, p.operationBudget, p.init.budget])).toEqual([
      ["Pecker", "alice", 1000, 50000],
      ["Anvil", "bob", 1000, 50000],
    ]);
    expect(summary.budgetPeaks[0]?.peak?.operations).toBeGreaterThan(0);
    expect(summary.files.record).toBe(at("out/game-record.json"));
  });

  it("accepts inline Programs and names the Player after the Entry file", async () => {
    const entry = (name: string, program: string) => ({ bots: [{ name, build: scout, program }] });
    await writeFile(at("carol.entry.json"), JSON.stringify(entry("Idle", "function tick() {}")));
    await writeFile(at("dave.json"), JSON.stringify(entry("Spinner", "function tick() { turn(1); }")));
    const run = await cli("run", "--map", at("duel.json"), "--entry", at("carol.entry.json"), "--entry", at("dave.json"), "--unthrottled", "--time-limit", "2", "--out", at("out"));
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const record = await readJson<GameRecord>("out/game-record.json");
    expect(record.entries.map((e) => e.player)).toEqual(["carol", "dave"]);
    expect(record.timeLimitTicks).toBe(20);
    expect(record.result).toMatchObject({ tick: 20, end: "timeLimit", winner: null });
    expect(run.out).toContain("Result: Draw (time limit) in Tick 20 (2 s)");
  });

  it("keeps real-time Pace, one simulated second per real second, unless unthrottled", async () => {
    const waits: number[] = [];
    await writeFile(at("e.json"), JSON.stringify({ bots: [{ name: "E", build: scout, program: "function tick() {}" }] }));
    await writeFile(at("f.json"), JSON.stringify({ bots: [{ name: "F", build: scout, program: "function tick() {}" }] }));
    const io: Io = { out: () => undefined, err: () => undefined };
    const argv = ["run", "--map", at("duel.json"), "--entry", at("e.json"), "--entry", at("f.json"), "--time-limit", "1", "--out", at("out")];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    expect(await main(argv, io, { now: () => 0, sleep })).toBe(0);
    // Ticks are 100 ms apart; no wait after the last one.
    expect(waits).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    waits.length = 0;
    expect(await main([...argv, "--unthrottled"], io, { now: () => 0, sleep })).toBe(0);
    expect(waits).toEqual([]);
  });

  it("reports every problem with the Entries before playing", async () => {
    const pricey = { chassis: "juggernaut", components: {}, armor: { front: "heavyPlate", left: "heavyPlate", right: "heavyPlate", rear: "heavyPlate" } };
    await writeFile(
      at("bad.entry.json"),
      JSON.stringify({
        ruleset: "r1",
        bots: [
          { name: "Pecker", build: scout, program: "function tick() {}" },
          { name: "Bad", build: { chassis: "scout", components: { gun: "noSuchGun" }, armor: none }, program: "function tick() {}" },
          { name: "Typo", build: scout, programFile: "typo.ptk" },
          { name: "Heavy", build: pricey, program: "function tick() {}" },
        ],
      }),
    );
    await writeFile(at("typo.ptk"), 'function tick() {\n  fire("cannon", 0);\n}\n');
    const run = await cli("run", "--map", at("duel.json"), "--entry", at("alice.entry.json"), "--entry", at("bad.entry.json"), "--point-budget", "300", "--unthrottled", "--out", at("out"));
    expect(run.code).toBe(1);
    expect(run.out).toBe("");
    expect(run.err).toContain('Bot "Pecker": the Bot Name is already used');
    expect(run.err).toContain('Bot "Bad": build.components.gun is the unknown Component "noSuchGun"');
    expect(run.err).toMatch(/typo\.ptk:2:\d+: Bot "Typo": /);
    expect(run.err).toMatch(/over the Point Budget of 300/);
  });

  it("takes one Entry per Player", async () => {
    await writeFile(at("twin.entry.json"), JSON.stringify({ player: "alice", bots: [{ name: "Twin", build: scout, program: "function tick() {}" }] }));
    const run = await cli("run", "--map", at("duel.json"), "--entry", at("alice.entry.json"), "--entry", at("twin.entry.json"), "--unthrottled", "--out", at("out"));
    expect(run.code).toBe(1);
    expect(run.out).toBe("");
    expect(run.err).toContain(`twin.entry.json: Player "alice" already has an Entry in ${at("alice.entry.json")}; a Player may have one Entry in a Game`);
  });

  it("rejects bad input files and arguments", async () => {
    await writeFile(at("r2.json"), JSON.stringify({ ruleset: "r2", bots: [{ name: "X", build: scout, program: "function tick() {}" }] }));
    await writeFile(at("shape.json"), JSON.stringify({ bots: [{ name: "Y", build: scout }], extra: 1 }));
    const run = (...argv: string[]) => cli("run", "--map", at("duel.json"), "--unthrottled", "--out", at("out"), ...argv);

    expect((await run("--entry", at("alice.entry.json"), "--entry", at("r2.json"))).err).toContain("the Entry is for Ruleset r2, but the Game uses r1");
    const shape = await run("--entry", at("shape.json"));
    expect(shape.code).toBe(1);
    expect(shape.err).toContain("entry.extra is not a known field");
    expect(shape.err).toContain("needs exactly one of program (inline source) and programFile (a path)");
    expect((await run("--entry", at("missing.json"))).err).toMatch(/cannot read Entry file .*missing\.json \(ENOENT\)/);
    expect((await run("--entry", at("alice.entry.json"), "--entry", at("bob.entry.json"), "--entry", at("alice.entry.json"))).err).toContain(
      "the Map has 2 Spawn Zones, so at most 2 Entries, not 3",
    );
    // Whole seconds, at least 1, as the server takes them; whole Ticks are not enough.
    for (const limit of ["0.5", "1.5", "0", "-3"]) {
      expect(await run("--entry", at("alice.entry.json"), `--time-limit=${limit}`)).toMatchObject({
        code: 1,
        err: expect.stringContaining(`--time-limit must be a whole number of seconds, at least 1, got ${String(Number(limit))}`) as unknown,
      });
    }
    expect((await run("--entry", at("alice.entry.json"), "--point-budget", "50")).err).toContain("range 100 to 800");
    expect((await run("--entry", at("alice.entry.json"), "--ruleset", "r9")).err).toContain('unknown Ruleset "r9"');
    expect((await run("--entry", at("alice.entry.json"), "--seed", "1.5")).err).toContain("the seed must be a whole number");
    expect((await cli("run", "--map", at("alice.entry.json"), "--entry", at("alice.entry.json"))).err).toMatch(/map\.format is required/);
  });

  it("defaults to the latest Ruleset", async () => {
    const latest = RULESET_VERSIONS[RULESET_VERSIONS.length - 1];
    expect(DEFAULT_RULESET).toBe(latest);
    expect(USAGE).toContain(`--ruleset VERSION     The Ruleset version (default: ${DEFAULT_RULESET}, the latest)`);
    expect(USAGE).toContain(`its ruleset defaults\n                        to ${DEFAULT_RULESET}`);
    const run = await duel("out", "--json");
    expect((JSON.parse(run.out) as { ruleset: string }).ruleset).toBe(latest);
    await writeFile(at("plain.json"), JSON.stringify({ bots: [{ name: "P", build: scout, program: "function tick() {}" }] }));
    const check = JSON.parse((await cli("tick-cost", "--entry", at("plain.json"), "--ticks", "1", "--json")).out) as { bots: { report: TickCost }[] };
    expect(check.bots[0]?.report.rulesetVersion).toBe(latest);
  });

  it("explains its usage", async () => {
    expect(await cli("run", "--entry", "x.json")).toMatchObject({ code: 2, err: expect.stringContaining("--map is required") as unknown });
    expect(await cli("run", "--map", "m.json")).toMatchObject({ code: 2, err: expect.stringContaining("at least one --entry") as unknown });
    expect(await cli("run", "--map", "m.json", "--entry", "e.json", "--bogus")).toMatchObject({ code: 2 });
    expect(await cli("fly")).toMatchObject({ code: 2, err: expect.stringContaining('unknown command "fly"') as unknown });
    expect(await cli("--help")).toMatchObject({ code: 0, out: expect.stringContaining("Usage: positrontanks run") as unknown });
    expect(await cli()).toMatchObject({ code: 2 });
  });
});

describe("positrontanks tick-cost", () => {
  interface Summary {
    player: string;
    bots: { name: string; report: TickCost }[];
  }

  it("reports each Bot's tick cost, as the engine's tick cost check does, with the endpoint's defaults", async () => {
    const run = await cli("tick-cost", "--entry", at("alice.entry.json"), "--json");
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const summary = JSON.parse(run.out) as Summary;
    expect(summary.player).toBe("alice");
    expect(summary.bots.map((b) => b.name)).toEqual(["Pecker"]);
    const r1 = loadRuleset("r1");
    const build = validateBuild(r1, scout);
    if (!build.ok) throw new Error("the scout Build is invalid");
    const expected = tickCostCheck(r1, build.build, await readFile(at("hunter.ptk"), "utf8"), { ticks: 20, seed: 1 });
    expect(summary.bots[0]?.report).toEqual(expected);
    expect(expected.runs).toHaveLength(20);
  });

  it("honours --ticks and --seed and prints a text report", async () => {
    await writeFile(at("steady.json"), JSON.stringify({ bots: [{ name: "Steady", build: scout, program: "function tick() { throttle(1); turn(0.5); }" }, { name: "Idle", build: scout, program: "function tick() {}" }] }));
    const json = JSON.parse((await cli("tick-cost", "--entry", at("steady.json"), "--ticks", "3", "--seed", "7", "--json")).out) as Summary;
    expect(json.bots.map((b) => [b.name, b.report.ticks, b.report.seed, b.report.runs.map((r) => r.operations)])).toEqual([
      ["Steady", 3, 7, [6, 6, 6]],
      ["Idle", 3, 7, [0, 0, 0]],
    ]);

    const text = await cli("tick-cost", "--entry", at("steady.json"), "--ticks", "3");
    expect(text.code).toBe(0);
    expect(text.out).toContain("Ruleset r1");
    expect(text.out).toContain("seed 1, 3 Ticks");
    expect(text.out).toMatch(/Steady\s+0\/50000 \(0%\)\s+6\/1000 \(1%\) at Tick 1/);
    expect(text.out).toMatch(/Steady\s+6 6 6/);
  });

  it("checks the Builds, Programs and options as the server does", async () => {
    const [beam, dome, heavy] = ["beamTurret", "domeRadar", "heavyPlate"];
    // 803 points, over r1's largest Point Budget of 800.
    const pricey = {
      chassis: "juggernaut",
      components: { leftNose: beam, rightNose: beam, leftGun: beam, rightGun: beam, tail: beam, eye: dome, topEye: dome, rearEye: dome, leftDrive: "tracks", rightDrive: "tracks", bay1: "superProcessor", bay2: "fastProcessor" },
      armor: { front: heavy, left: heavy, right: heavy, rear: heavy },
    };
    await writeFile(
      at("bad.json"),
      JSON.stringify({ bots: [{ name: "Typo", build: scout, program: 'function tick() { fire("cannon", 0); }' }, { name: "Heavy", build: pricey, program: "function tick() {}" }] }),
    );
    const bad = await cli("tick-cost", "--entry", at("bad.json"));
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/bad\.json:1:\d+: Bot "Typo": /);
    expect(bad.err).toContain('Bot "Heavy": the Build costs');

    expect((await cli("tick-cost", "--entry", at("alice.entry.json"), "--ticks", "101")).err).toContain("from 1 to 100");
    expect((await cli("tick-cost", "--entry", at("alice.entry.json"), "--ticks", "0")).code).toBe(1);
    expect((await cli("tick-cost", "--entry", at("alice.entry.json"), "--seed=-1")).err).toContain("the seed must be a whole number");
    expect(await cli("tick-cost")).toMatchObject({ code: 2, err: expect.stringContaining("--entry is required") as unknown });
    expect(await cli("tick-cost", "--entry", at("alice.entry.json"), "--map", "m.json")).toMatchObject({ code: 2 });
    expect(await cli("tick-cost", "--help")).toMatchObject({ code: 0, out: expect.stringContaining("positrontanks tick-cost --entry FILE") as unknown });
  });
});
