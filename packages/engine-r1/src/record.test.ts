import type { Build } from "@positrontanks/ruleset-data";
import { describe, expect, it } from "vitest";
import type { TickEvent } from "./events.js";
import { createGame, playGame, playTick, type Game, type GameSetup } from "./game.js";
import { hashWorld } from "./hash.js";
import { addFoeDamage, judge } from "./outcome.js";
import { gameRecord, programLogs, replayGame, replayOf, type GameRecord } from "./record.js";
import { armed, bot, boxBuild, discBuild, ruleset, testMap } from "./test-fixtures.js";

interface TestBot {
  readonly build?: Build;
  readonly program: string;
}

interface TestEntry {
  readonly player?: string;
  readonly bots: readonly TestBot[];
}

const idle = "function tick() {}";
const laser = armed(discBuild, { gun: "laser" });

/** A Game with these Entries, Bots named a, b, c, … in order. */
function game(entries: readonly TestEntry[], extra: Partial<GameSetup> = {}): Game {
  let n = 0;
  return createGame({
    ruleset,
    map: testMap(),
    seed: 7,
    timeLimitTicks: 600,
    entries: entries.map((e) => ({
      ...(e.player === undefined ? {} : { player: e.player }),
      bots: e.bots.map((b) => ({ name: String.fromCharCode(97 + n++), build: b.build ?? discBuild, program: b.program })),
    })),
    ...extra,
  });
}

/** One single-Bot Entry per Program, each its own Player. */
function duel(...programs: readonly TestBot[]): TestEntry[] {
  return programs.map((b) => ({ bots: [b] }));
}

function place(g: Game, id: number, x: number, y: number, heading: number): void {
  const b = bot(g.world, id);
  b.x = x;
  b.y = y;
  b.heading = heading;
}

/** Shoots at (40, 50) on the given Ticks. */
function shootOn(...ticks: readonly number[]): TestBot {
  const when = ticks.map((t) => `self.tick == ${String(t)}`).join(" || ");
  return { build: laser, program: `function tick() { if (${when}) { fire("gun", {x: 40, y: 50}); } }` };
}

describe("The end of a Game", () => {
  it("comes when one Player is left standing, who wins; no Tick may be played after", () => {
    const g = game(duel(shootOn(1, 4, 7, 10, 13), { program: idle }));
    place(g, 1, 20, 50, 90);
    place(g, 2, 40, 50, 0);
    expect(playGame(g)).toEqual({
      tick: 13,
      end: "lastStanding",
      winner: "entry:0",
      decidedBy: "survival",
      standings: [
        { player: "entry:0", foeDamage: 100, hitPoints: 100, remaining: true },
        { player: "entry:1", foeDamage: 0, hitPoints: 0, remaining: false },
      ],
    });
    expect(() => playTick(g)).toThrow(/the Game ended in Tick 13/);
  });

  it("counts survival by Player, not by Entry", () => {
    const g = game([
      { player: "ann", bots: [{ program: idle }] },
      { player: "ann", bots: [{ program: idle }] },
    ]);
    expect(g.result).toMatchObject({ tick: 0, end: "lastStanding", winner: "ann", decidedBy: "survival" });
  });

  it("can come in the init phase, as a Draw when every Program halts", () => {
    const halts = "function init() { const x = 1 / 0; } function tick() {}";
    const g = game(duel({ program: halts }, { program: halts }));
    expect(g.result).toMatchObject({ tick: 0, end: "noneStanding", winner: null, decidedBy: null });
  });

  it("comes at the time limit, when the most damage dealt to Foes wins", () => {
    const g = game(duel(shootOn(1), { program: idle }), { timeLimitTicks: 3 });
    place(g, 1, 20, 50, 90);
    place(g, 2, 40, 50, 0);
    playTick(g);
    playTick(g);
    expect(g.result).toBeNull();
    playTick(g);
    expect(g.result).toEqual({
      tick: 3,
      end: "timeLimit",
      winner: "entry:0",
      decidedBy: "foeDamage",
      standings: [
        { player: "entry:0", foeDamage: 20, hitPoints: 100, remaining: true },
        { player: "entry:1", foeDamage: 0, hitPoints: 80, remaining: true },
      ],
    });
  });

  it("does not count damage to Friends, so remaining Hit Points decide next", () => {
    const g = game([{ bots: [shootOn(1), { program: idle }] }, { bots: [{ build: boxBuild, program: idle }] }], { timeLimitTicks: 1 });
    place(g, 1, 20, 50, 90);
    place(g, 2, 40, 50, 0);
    playTick(g);
    expect(g.result).toMatchObject({
      end: "timeLimit",
      winner: "entry:1",
      decidedBy: "hitPoints",
      standings: [
        { player: "entry:0", foeDamage: 0, hitPoints: 180 },
        { player: "entry:1", foeDamage: 0, hitPoints: 200 },
      ],
    });
  });

  it("is a Draw at the time limit when every tiebreak is equal", () => {
    const g = game(duel({ program: idle }, { program: idle }), { timeLimitTicks: 2 });
    expect(playGame(g)).toMatchObject({ tick: 2, end: "timeLimit", winner: null, decidedBy: null });
  });

  it("leaves Players already out of the running out of the time-limit tiebreaks", () => {
    const g = game(duel({ program: idle }, { program: idle }, { program: idle }));
    bot(g.world, 1).status = "disabled";
    // The Player of Bot 1 dealt the most damage, but is out once it is Disabled.
    const before = new Set(g.players);
    expect(judge(g.world, g.players, new Map([["entry:0", 50]]), before, 0)).toMatchObject({
      end: "timeLimit",
      winner: null,
    });
  });

  it("settles the tiebreaks among the last Players when they are all Disabled in the same Tick", () => {
    const g = game(duel({ program: idle }, { program: idle }, { program: idle }));
    for (const b of g.world.bots) b.status = "disabled";
    const before = new Set(["entry:1", "entry:2"]);
    const damage = new Map([
      ["entry:0", 90],
      ["entry:1", 30],
      ["entry:2", 20],
    ]);
    expect(judge(g.world, g.players, damage, before, 600)).toMatchObject({
      end: "noneStanding",
      winner: "entry:1",
      decidedBy: "foeDamage",
    });
  });
});

describe("Foe damage", () => {
  it("counts rams for the other Bot, and not Friends, wrecks or the boundary", () => {
    const g = game([{ bots: [{ program: idle }, { program: idle }] }, { bots: [{ program: idle }] }]);
    const ram = (target: number, other: { kind: "bot" | "wreck"; id: number } | { kind: "boundary" }, dealt: number): TickEvent => ({
      type: "damage",
      tick: 1,
      target: { kind: "bot", id: target },
      source: { kind: "collision", with: other },
      raw: dealt,
      absorbed: 0,
      dealt,
      side: "front",
      point: { x: 0, y: 0 },
      absorber: "chassis",
    });
    const totals = new Map<string, number>();
    const events = [
      ram(1, { kind: "bot", id: 3 }, 7),
      ram(3, { kind: "bot", id: 1 }, 5),
      ram(2, { kind: "bot", id: 1 }, 11),
      ram(3, { kind: "wreck", id: 2 }, 13),
      ram(3, { kind: "boundary" }, 17),
    ];
    addFoeDamage(g.world, g.players, events, totals);
    expect(Object.fromEntries(totals)).toEqual({ "entry:0": 5, "entry:1": 7 });
  });
});

/** Bots that wander at random and fire at any Foe they see. */
const brawler: TestBot = {
  build: armed(discBuild, { gun: "turret", eye: "allSeeing", tail: "cannon" }),
  program: `
    let secretTactic = 0;
    function tick() {
      secretTactic += 1;
      turn(random() * 2 - 1);
      throttle(random());
      const foes = scan().filter((c) => c.isFoe);
      if (foes.length > 0 && random() < 0.3) { fire("gun", foes[0]); }
      fire("tail", 180);
      log(secretTactic);
    }`,
};

function brawl(): Game {
  return game(
    [
      { player: "ann", bots: [brawler] },
      { player: "bob", bots: [brawler] },
      { player: "ann", bots: [brawler] },
    ],
    { timeLimitTicks: 400 },
  );
}

describe("The Game Record", () => {
  // Hashes of the original Game's world after each Tick, from 0.
  const original = brawl();
  const hashes = [hashWorld(original.world)];
  while (original.result === null) {
    playTick(original);
    hashes.push(hashWorld(original.world));
  }
  const record: GameRecord = JSON.parse(JSON.stringify(gameRecord(original))) as GameRecord;
  const end = original.world.tick;

  it("comes from a Game that ran through fire, damage and a result", () => {
    const events = original.history.flatMap((t) => t.events);
    expect(events.some((e) => e.type === "fired" && e.projectile !== null)).toBe(true);
    expect(events.some((e) => e.type === "damage")).toBe(true);
    expect(original.result).not.toBeNull();
    expect(end).toBeGreaterThan(20);
  });

  it("holds the Programs, starting positions, budget usage and result", () => {
    expect(record).toMatchObject({ ruleset: "test", seed: 7, timeLimitTicks: 400, tick: end, result: original.result });
    expect(record.entries.map((e) => e.player)).toEqual(["ann", "bob", "ann"]);
    expect(record.entries[0]?.bots[0]?.program).toBe(brawler.program);
    expect(record.startingPositions).toEqual(original.history[0]?.bots.map((b) => ({ bot: b.id, x: b.x, y: b.y, heading: b.heading })));
    const usage = record.operations[0]?.perTick ?? [];
    expect(usage).toHaveLength(end + 1);
    expect(usage.every((n) => n === null || n > 0)).toBe(true);
  });

  it.each([0, 1, 2, 17, 40])("replays to Tick %i with identical state, and plays on to the same end", (tick) => {
    const g = replayGame(record, ruleset, tick);
    expect(g.world.tick).toBe(tick);
    expect(hashWorld(g.world)).toBe(hashes[tick]);
    expect(playGame(g)).toEqual(original.result);
    expect(hashWorld(g.world)).toBe(hashes[end]);
    expect(replayOf(g)).toEqual(replayOf(original));
    expect(programLogs(g, "ann")).toEqual(programLogs(original, "ann"));
  });

  it("replays to the end of the Game when asked for a later Tick or none", () => {
    expect(replayGame(record, ruleset, end + 50).world.tick).toBe(end);
    expect(hashWorld(replayGame(record, ruleset).world)).toBe(hashes[end]);
  });

  it("refuses another Ruleset version, a Tick before 0, and starting positions the engine does not reproduce", () => {
    expect(() => replayGame(record, { ...ruleset, version: "other" })).toThrow(/needs Ruleset test, not other/);
    expect(() => replayGame(record, ruleset, -1)).toThrow(/0 or more/);
    const [first, ...rest] = record.startingPositions;
    if (first === undefined) throw new Error("no starting positions");
    const moved = { ...record, startingPositions: [{ ...first, x: first.x + 1e-9 }, ...rest] };
    expect(() => replayGame(moved, ruleset, 0)).toThrow(/do not start where the Game Record says/);
  });
});

describe("The Replay", () => {
  const g = brawl();
  playGame(g);
  const replay = replayOf(g);

  it("contains no Program text", () => {
    const text = JSON.stringify(replay);
    expect(text).not.toContain("secretTactic");
    expect(text).not.toContain("program");
    expect(text).not.toContain("function tick");
  });

  it("holds every Build, and every Tick's events and frame from the starting positions on", () => {
    expect(replay).toMatchObject({ ruleset: "test", tickRate: 10, timeLimitTicks: 400, result: g.result });
    expect(replay.entries).toEqual([
      { player: "ann", bots: [{ id: 1, name: "a", build: brawler.build }] },
      { player: "bob", bots: [{ id: 2, name: "b", build: brawler.build }] },
      { player: "ann", bots: [{ id: 3, name: "c", build: brawler.build }] },
    ]);
    expect(replay.ticks.map((t) => t.tick)).toEqual(Array.from({ length: g.world.tick + 1 }, (_, i) => i));
    const last = replay.ticks.at(-1);
    expect(last?.bots).toEqual(g.world.bots.map((b) => ({ id: b.id, x: b.x, y: b.y, heading: b.heading, speed: b.speed, hitPoints: b.hitPoints, status: b.status })));
    expect(last?.projectiles).toEqual(g.world.projectiles.map((p) => ({ id: p.id, x: p.x, y: p.y })));
    const disabled = replay.ticks.flatMap((t) => t.events).filter((e) => e.type === "disabled");
    expect(disabled.length).toBeGreaterThan(0);
  });
});

describe("Program logs", () => {
  it("go to each Bot's owner, with every run from the init phase on", () => {
    const g = game([
      { player: "ann", bots: [{ program: 'function init() { log("ann init"); } function tick() { log(self.tick); }' }] },
      { player: "bob", bots: [{ program: "function tick() { while (true) {} }" }] },
    ]);
    playTick(g);
    playTick(g);
    const [ann] = programLogs(g, "ann");
    expect(programLogs(g, "ann")).toHaveLength(1);
    expect(ann).toMatchObject({ bot: 1, name: "a", player: "ann" });
    expect(ann?.runs.map((r) => [r.tick, r.result.log])).toEqual([
      [0, ["ann init"]],
      [1, ["1"]],
      [2, ["2"]],
    ]);
    const [bob] = programLogs(g, "bob");
    expect(bob?.runs.map((r) => r.result.outcome)).toEqual(["completed", "outOfBudget", "outOfBudget"]);
    expect(bob?.runs[1]?.result.operations).toBe(1000);
  });
});
