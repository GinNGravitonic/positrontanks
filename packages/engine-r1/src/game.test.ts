import type { Build, Ruleset } from "@positrontanks/ruleset-data";
import { describe, expect, it } from "vitest";
import type { DamageEvent, TickEvent } from "./events.js";
import { createGame, playTick, type Game, type GameSetup, type TickReport } from "./game.js";
import { hashWorld } from "./hash.js";
import { armed, bot, discBuild, ruleset, testMap } from "./test-fixtures.js";

interface TestBot {
  readonly build?: Build;
  readonly program: string;
}

const idle = "function tick() {}";

/** A Game with one Entry per inner list, Bots named a, b, c, … in order. */
function game(entries: readonly (readonly TestBot[])[], extra: Partial<GameSetup> = {}): Game {
  let n = 0;
  return createGame({
    ruleset,
    map: testMap(),
    seed: 7,
    timeLimitTicks: 600,
    entries: entries.map((bots) => ({
      bots: bots.map((b) => ({ name: String.fromCharCode(97 + n++), build: b.build ?? discBuild, program: b.program })),
    })),
    ...extra,
  });
}

/** Moves a Bot, as tests of geometry need known positions. */
function place(g: Game, id: number, x: number, y: number, heading: number): void {
  const b = bot(g.world, id);
  b.x = x;
  b.y = y;
  b.heading = heading;
}

function logOf(report: TickReport, id: number): readonly string[] {
  return report.runs.find((r) => r.bot === id)?.result.log ?? [];
}

function runOf(report: TickReport, id: number) {
  const run = report.runs.find((r) => r.bot === id);
  if (run === undefined) throw new Error(`Bot ${String(id)} did not run`);
  return run.result;
}

function ofType<T extends TickEvent["type"]>(events: readonly TickEvent[], type: T): Extract<TickEvent, { type: T }>[] {
  return events.filter((e): e is Extract<TickEvent, { type: T }> => e.type === type);
}

describe("Programs driving Bots", () => {
  it("hunt down a Foe end to end", () => {
    const hunter = `
      let shots = 0;
      function tick() {
        const foes = scan().filter((c) => c.isFoe);
        if (foes.length == 0) { return; }
        const t = foes[0];
        turn(clamp(t.bearing / 20, -1, 1));
        throttle(t.distance > 15 ? 1 : 0);
        if (fire("gun", t)) { shots += 1; }
      }`;
    const g = game([[{ build: armed(discBuild, { eye: "allSeeing", gun: "laser" }), program: hunter }], [{ program: idle }]]);
    const damage: DamageEvent[] = [];
    while (bot(g.world, 2).status === "active" && g.world.tick < 300) damage.push(...ofType(playTick(g).events, "damage"));
    expect(bot(g.world, 2)).toMatchObject({ status: "disabled", disabledCause: "destroyed", hitPoints: 0 });
    expect(damage.length).toBe(5);
    expect(damage.every((d) => d.source.kind === "weapon" && d.source.bot === 1)).toBe(true);
    expect(bot(g.world, 1).status).toBe("active");
  });

  it("see the same snapshot and resolve together", () => {
    // Each Bot logs where the other is, then both drive: neither sees the other's move first.
    const program = `function tick() { log(str(scan()[0].x)); throttle(1); }`;
    const seer = armed(discBuild, { eye: "allSeeing" });
    const g = game([[{ build: seer, program }], [{ build: seer, program }]]);
    const [x1, x2] = [bot(g.world, 1).x, bot(g.world, 2).x];
    const report = playTick(g);
    expect(logOf(report, 1)).toEqual([String(x2)]);
    expect(logOf(report, 2)).toEqual([String(x1)]);
  });

  it("keep throttle and turn until changed, and keep commands issued before running out of budget", () => {
    const g = game([[{ program: "function tick() { if (self.tick == 1) { throttle(1); turn(0.5); } while (true) {} }" }], [{ program: idle }]]);
    expect(runOf(playTick(g), 1).outcome).toBe("outOfBudget");
    playTick(g);
    expect(bot(g.world, 1)).toMatchObject({ throttle: 1, turn: 0.5, speed: 2, turnRate: 90 });
  });

  it("fire the last legal aim of the Tick, and learn whether each shot is legal", () => {
    const program = `function tick() {
      log(fire("gun", 180));
      log(fire("gun", {x: 40, y: 50}));
      log(fire("gun", 179));
    }`;
    const g = game([[{ build: armed(discBuild, { gun: "laser" }), program }], [{ program: idle }]]);
    place(g, 1, 20, 50, 90);
    place(g, 2, 40, 50, 0);
    const report = playTick(g);
    expect(logOf(report, 1)).toEqual(["false", "true", "false"]);
    expect(ofType(report.events, "fired")).toMatchObject([{ bot: 1, weapon: "gun", absBearing: 90 }]);
    expect(bot(g.world, 2).hitPoints).toBe(80);
  });

  it("report misuse of commands as runtime errors", () => {
    const program = `function tick() {
      if (self.tick == 1) { const w = "no" + "pe"; fire(w, 0); }
      if (self.tick == 2) { fire("gun", "ahead"); }
      if (self.tick == 3) { throttle("full"); }
    }`;
    const g = game([[{ build: armed(discBuild, { gun: "laser" }), program }], [{ program: idle }]]);
    const messages = [1, 2, 3].map(() => runOf(playTick(g), 1).error?.message);
    expect(messages).toEqual([
      "this Bot has no weapon in Slot 'nope'",
      "'fire' needs a bearing or a record with numeric x and y, got string",
      "'throttle' needs a number as argument 1, got string",
    ]);
  });
});

describe("Program bindings", () => {
  it("give self, game and map, and the Terrain built-ins", () => {
    const rock = { id: "rock", destructible: true as const, hitPoints: 50, shape: "circle" as const, x: 50, y: 20, radius: 2 };
    const program = `
      function init() {
        log(self.name + " " + str(self.tick) + " " + str(self.maxHitPoints) + " " + str(self.mass));
        log(self.weapons);
        log(self.sensors);
        log(self.motorTerrain);
        log(self.armor);
        log(game);
        log(map.obstacles);
        log(terrainAt(50, 70));
        log(terrainTable());
      }
      function tick() { log(self.tick); log(terrainHere()); log(checkTerrain(0, 0) == terrainHere()); }`;
    const build = armed(discBuild, { gun: "laser", eye: "radar" });
    const g = game([[{ build, program }], [{ program: idle }]], { map: testMap({ obstacles: [rock] }) });
    expect(logOf(g.start, 1)).toEqual([
      "a 0 100 50",
      '[{"id":"gun","category":"beam","arcWidth":30,"range":50,"reloadTicks":3,"ticksUntilReady":0}]',
      '[{"id":"eye","kind":"radar","arcWidth":90,"range":30}]',
      '{"sand":{"speed":0.5,"accel":1}}',
      '{"front":0,"left":0,"right":0,"rear":0}',
      '{"tickRate":10,"timeLimitTicks":600,"playerCount":2}',
      '[{"id":"rock","destructible":true,"shape":"circle","x":50,"y":20,"radius":2}]',
      "sand",
      '{"grass":{"speed":1,"accel":1},"sand":{"speed":0.5,"accel":0.5},"road":{"speed":1.2,"accel":1}}',
    ]);
    expect(logOf(playTick(g), 1)).toEqual(["1", "grass", "true"]);
  });

  it("measure bearings and distances from the Bot, with pinned math", () => {
    const program = `function tick() {
      log(sin(90)); log(atan2(1, 0)); log(bearingTo(self.x + 1, self.y)); log(absBearingTo(self.x, self.y + 1));
      log(distanceTo(self.x + 3, self.y + 4)); log(normalizeAngle(270));
      if (self.tick == 1) { log(tan(90)); }
      if (self.tick == 2) { log(terrainAt(-1, 0)); }
    }`;
    const g = game([[{ program }], [{ program: idle }]]);
    place(g, 1, 20, 50, 0);
    const first = runOf(playTick(g), 1);
    expect(first.log).toEqual(["1", "90", "90", "180", "5", "-90"]);
    expect(first.error?.message).toBe("the result of 'tan' is not a finite number");
    expect(runOf(playTick(g), 1).error?.message).toBe("'terrainAt': the point (-1, 0) is outside the Map");
  });

  it("tell Friends from Foes in scan()", () => {
    const program = `function tick() { log(scan().map((c) => c.name + ":" + str(c.isFoe)).join(",")); }`;
    const g = game([[{ build: armed(discBuild, { eye: "allSeeing" }), program }, { program: idle }], [{ program: idle }]]);
    expect(logOf(playTick(g), 1)).toEqual(["b:false,c:true"]);
  });

  it("budget operations from the Chassis or a Processor", () => {
    const program = "function init() { log(budgetRemaining()); } function tick() { log(budgetRemaining()); }";
    const g = game([[{ program }], [{ build: armed(discBuild, { bay: "cpu" }), program }]]);
    expect([logOf(g.start, 1), logOf(g.start, 2)]).toEqual([["19999"], ["59999"]]);
    const report = playTick(g);
    expect([logOf(report, 1), logOf(report, 2)]).toEqual([["999"], ["2999"]]);
  });

  it("give each Bot its own random stream, so Games replay exactly", () => {
    const program = "function tick() { turn(random() * 2 - 1); throttle(random()); }";
    const play = () => {
      const g = game([[{ program }], [{ program }]]);
      for (let i = 0; i < 50; i++) playTick(g);
      return g;
    };
    const [g1, g2] = [play(), play()];
    expect(hashWorld(g1.world)).toBe(hashWorld(g2.world));
    expect(bot(g1.world, 1).turn).not.toBe(bot(g1.world, 2).turn);
  });
});

describe("Halting", () => {
  it("Disables a Bot whose init phase fails, which then shows as a wreck in map.obstacles", () => {
    const g = game([[{ program: "function init() { const x = 1 / 0; } function tick() {}" }], [{ program: "function tick() { log(map.obstacles.map((o) => o.id)); }" }], [{ program: idle }]]);
    expect(g.start.events).toEqual([{ type: "disabled", tick: 0, bot: 1, cause: "programHalted" }]);
    expect(runOf(g.start, 1).halt).toMatch(/init phase failed/);
    const report = playTick(g);
    expect(report.runs.map((r) => r.bot)).toEqual([2, 3]);
    expect(logOf(report, 2)).toEqual(['["wreck:1"]']);
  });

  it("Disables a Bot over the memory cap before its commands take effect", () => {
    const small: Ruleset = { ...ruleset, limits: { ...ruleset.limits, memoryCells: 50 } };
    const program = "let xs = []; function tick() { throttle(1); for (let i = 0; i < 60; i++) { xs.push(i); } }";
    const g = game([[{ program }], [{ program: idle }], [{ program: idle }]], { ruleset: small });
    const { x, y } = bot(g.world, 1);
    const report = playTick(g);
    expect(runOf(report, 1).halt).toMatch(/memory cap/);
    expect(report.events[0]).toEqual({ type: "disabled", tick: 1, bot: 1, cause: "programHalted" });
    expect(bot(g.world, 1)).toMatchObject({ x, y, speed: 0, throttle: 0, status: "disabled" });
    expect(playTick(g).runs.map((r) => r.bot)).toEqual([2, 3]);
  });

  it("refuses a Program that does not check against its Build", () => {
    expect(() => game([[{ program: 'function tick() { fire("gun", 0); }' }]])).toThrow(/Program of Bot "a" does not check.*no weapon/);
  });
});
