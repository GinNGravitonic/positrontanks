/**
 * Running Bots' Programs against the r1 world (language-r1 sections 5 to 7;
 * the rules are in ruleset-data/spec/r1/engine-r1.md section 10).
 *
 * A Game holds the world and one interpreter per Bot. `createGame` runs every
 * Program's init phase; `playTick` then runs every active Bot's `tick()`
 * against the snapshot at the start of the Tick, collects the commands they
 * issued, and steps the world. Programs see the world only through the
 * built-in values and functions bound here.
 *
 * After each Tick the Game is judged (outcome.ts), and once it has a result
 * no further Tick may be played. The Game also keeps what its Replay and its
 * Program logs are made of (record.ts).
 */

import {
  check,
  fromHost,
  Interpreter,
  ProgramError,
  R1_LANGUAGE,
  RecordValue,
  typeName,
  type HostData,
  type HostFunction,
  type ProgramSlots,
  type RunResult,
  type Value,
} from "@positrontanks/language";
import type { BotSpec } from "./bot-spec.js";
import { disableBot } from "./damage.js";
import type { TickEvent } from "./events.js";
import { absBearing, headingVector, type Point, type WorldShape } from "./geometry.js";
import { addFoeDamage, judge, remainingPlayers, type GameResult } from "./outcome.js";
import { acosDeg, asinDeg, atan2Deg, cosDeg, hypot, normalizeAbsAngle, normalizeAngle, sinDeg, tanDeg } from "./math.js";
import { SeededRandom } from "./random.js";
import { replayTick, type ReplayTick } from "./replay.js";
import { incoming, rangefind, scan } from "./sensors.js";
import { terrainAt } from "./terrain.js";
import { step, type BotCommands } from "./tick.js";
import { canFire, type FireTarget } from "./weapons.js";
import { botShape, createWorld, type BotSetup, type BotState, type World, type WorldSetup } from "./world.js";

export interface ProgramBotSetup extends BotSetup {
  /** The Program's source, which must pass `check` against the r1 language and this Build. */
  readonly program: string;
}

export interface ProgramEntrySetup {
  /**
   * The Player who submitted the Entry. A Player may have several Entries;
   * an Entry without one is a Player of its own, `entry:<Entry index>`.
   */
  readonly player?: string;
  readonly bots: readonly ProgramBotSetup[];
}

export interface GameSetup extends WorldSetup {
  readonly entries: readonly ProgramEntrySetup[];
  /** The Game's time limit, in Ticks; Programs read it as `game.timeLimitTicks`. */
  readonly timeLimitTicks: number;
}

/** How one Bot's Program ran in the init phase or one Tick. */
export interface ProgramRun {
  readonly bot: number;
  readonly result: RunResult;
}

export interface TickReport {
  /** 0 for the init phase. */
  readonly tick: number;
  /** One per Program that ran, in Bot id order. */
  readonly runs: readonly ProgramRun[];
  readonly events: readonly TickEvent[];
}

/** The commands one Program has issued so far in the current run. */
export interface IssuedCommands {
  throttle?: number;
  turn?: number;
  /** The last legal aim per weapon id. */
  readonly fire: Map<string, FireTarget>;
}

/** What a Program's built-ins collect during one run. */
export interface RunState {
  issued: IssuedCommands;
  /** Sensor readings already taken this Tick, by built-in call. */
  readonly readings: Map<string, Value>;
}

/** One Bot's Program. */
export interface BotProgram {
  readonly bot: BotState;
  readonly interpreter: Interpreter;
  readonly run: RunState;
}

/** One Bot's Program log, which only its owner may see (language-r1 section 10.5). */
export interface ProgramLog {
  readonly bot: number;
  readonly name: string;
  readonly player: string;
  /** Every run of the Program, from the init phase (Tick 0), in Tick order. */
  readonly runs: { readonly tick: number; readonly result: RunResult }[];
}

export interface Game {
  readonly setup: GameSetup;
  /** The Player of each Entry, by Entry index. */
  readonly players: readonly string[];
  readonly world: World;
  readonly timeLimitTicks: number;
  /** The init phase: each Program's run, and the Bots it Disabled. */
  readonly start: TickReport;
  /** In Bot id order. */
  readonly programs: readonly BotProgram[];
  /** The `game` value, the same for every run. */
  readonly gameValue: Value;
  /** Damage each Player's Bots have dealt to Foes so far, by Player. */
  readonly foeDamage: Map<string, number>;
  /** Every Tick played, from the init phase, for the Replay. */
  readonly history: ReplayTick[];
  /** One per Bot, in Bot id order. */
  readonly logs: readonly ProgramLog[];
  /** Set once the Game has ended; then no Tick may be played. */
  result: GameResult | null;
}

/** The Slot ids a Program may name in `fire`, `fireAbs` and `rangefind`, for `check`. */
export function programSlots(spec: BotSpec): ProgramSlots {
  return {
    weapons: spec.weapons.map((w) => w.id),
    rangefinders: spec.sensors.filter((s) => s.kind === "rangefinder").map((s) => s.id),
  };
}

/** A circle or polygon as Maps give them. */
type MapShape =
  | { readonly shape: "circle"; readonly x: number; readonly y: number; readonly radius: number }
  | { readonly shape: "polygon"; readonly points: readonly Point[] };

/** A shape's geometry fields: `x, y, radius` for a circle, `points` for a polygon. */
function geometry(s: MapShape): { [key: string]: HostData } {
  return s.shape === "circle" ? { x: s.x, y: s.y, radius: s.radius } : { points: s.points.map((p) => ({ x: p.x, y: p.y })) };
}

/**
 * The `map` value for the world as it stands: live Obstacles in Map order,
 * then wrecks in Bot id order, with ids `wreck:<Bot id>`.
 */
function mapValue(world: World): Value {
  const { map } = world;
  const obstacle = (id: string, destructible: boolean, s: WorldShape) => ({ id, destructible, shape: s.shape, ...geometry(s) });
  return fromHost({
    width: map.width,
    height: map.height,
    baseTerrain: map.baseTerrain,
    terrainRegions: map.terrainRegions.map((r) => ({ terrain: r.terrain, shape: r.shape, ...geometry(r) })),
    obstacles: [
      ...world.obstacles.map((o) => obstacle(o.obstacle.id, o.obstacle.destructible, o.shape)),
      ...world.bots.filter((b) => b.status === "disabled").map((b) => obstacle(`wreck:${String(b.id)}`, false, botShape(b))),
    ],
    spawnZones: map.spawnZones.map((z) => ({ shape: z.shape, heading: z.heading, capacity: z.capacity, ...geometry(z) })),
  });
}

/** The `self` value: the Bot's state as it stands, during Tick `tick` (0 in the init phase). */
function selfValue(bot: BotState, tick: number): Value {
  const { spec } = bot;
  return fromHost({
    name: bot.name,
    tick,
    x: bot.x,
    y: bot.y,
    heading: bot.heading,
    speed: bot.speed,
    turnRate: bot.turnRate,
    throttle: bot.throttle,
    turn: bot.turn,
    hitPoints: bot.hitPoints,
    maxHitPoints: spec.maxHitPoints,
    mass: spec.mass,
    armor: { front: spec.armor.front, left: spec.armor.left, right: spec.armor.right, rear: spec.armor.rear },
    weapons: spec.weapons.map((w, i) => ({
      id: w.id,
      category: w.category,
      arcWidth: w.arcWidth,
      range: w.range,
      reloadTicks: w.reloadTicks,
      ticksUntilReady: bot.weapons[i]?.ticksUntilReady ?? 0,
    })),
    sensors: spec.sensors.map((s) => ({ id: s.id, kind: s.kind, arcWidth: s.arcWidth, range: s.range })),
    motorTerrain: Object.fromEntries(Object.entries(spec.motorTerrain).map(([name, m]) => [name, { speed: m.speed, accel: m.accel }])),
  });
}

function argNumber(name: string, args: readonly Value[], i: number): number {
  const v = args[i] ?? null;
  if (typeof v !== "number") throw new ProgramError(`'${name}' needs a number as argument ${String(i + 1)}, got ${typeName(v)}`);
  return v;
}

function argString(name: string, args: readonly Value[], i: number): string {
  const v = args[i] ?? null;
  if (typeof v !== "string") throw new ProgramError(`'${name}' needs a string as argument ${String(i + 1)}, got ${typeName(v)}`);
  return v;
}

function finite(name: string, v: number): number {
  if (!Number.isFinite(v)) throw new ProgramError(`the result of '${name}' is not a finite number`);
  return v;
}

/** The built-ins the interpreter leaves to its host, bound to one Bot. */
function hostFunctions(world: World, bot: BotState, run: RunState, random: SeededRandom): Record<string, HostFunction> {
  const math = (name: string, f: (...xs: number[]) => number, arity: number): HostFunction => {
    return (args) => finite(name, f(...Array.from({ length: arity }, (_, i) => argNumber(name, args, i))));
  };
  const onMap = (name: string, x: number, y: number): string => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > world.map.width || y > world.map.height) {
      throw new ProgramError(`'${name}': the point (${String(x)}, ${String(y)}) is outside the Map`);
    }
    return terrainAt(world.map, { x, y });
  };
  /** Takes a sensor reading once per Tick, so repeated calls return the same data. */
  const reading = (key: string, take: () => HostData): Value => {
    const { readings } = run;
    const cached = readings.get(key);
    if (cached !== undefined) return cached;
    const value = fromHost(take());
    readings.set(key, value);
    return value;
  };
  const weapon = (name: string, args: readonly Value[]): string => {
    const id = argString(name, args, 0);
    if (!bot.spec.weapons.some((w) => w.id === id)) throw new ProgramError(`this Bot has no weapon in Slot '${id}'`);
    return id;
  };
  const fire = (id: string, target: FireTarget): boolean => {
    if (!canFire(world, bot, id, target)) return false;
    run.issued.fire.set(id, target);
    return true;
  };

  return {
    throttle: (args) => {
      run.issued.throttle = Math.max(-1, Math.min(1, argNumber("throttle", args, 0)));
      return null;
    },
    turn: (args) => {
      run.issued.turn = Math.max(-1, Math.min(1, argNumber("turn", args, 0)));
      return null;
    },
    fire: (args) => {
      const id = weapon("fire", args);
      const target = args[1] ?? null;
      if (typeof target === "number") return fire(id, { kind: "bearing", bearing: target });
      if (target instanceof RecordValue) {
        const x = target.fields.get("x") ?? null;
        const y = target.fields.get("y") ?? null;
        if (typeof x === "number" && typeof y === "number") return fire(id, { kind: "point", x, y });
      }
      throw new ProgramError(`'fire' needs a bearing or a record with numeric x and y, got ${typeName(target)}`);
    },
    fireAbs: (args) => fire(weapon("fireAbs", args), { kind: "absBearing", bearing: argNumber("fireAbs", args, 1) }),
    scan: () =>
      reading("scan", () =>
        scan(world, bot).map((c) => ({
          id: c.id,
          name: c.name,
          x: c.x,
          y: c.y,
          distance: c.distance,
          bearing: c.bearing,
          absBearing: c.absBearing,
          heading: c.heading,
          speed: c.speed,
          isFoe: c.isFoe,
        })),
      ),
    rangefind: (args) => {
      const id = argString("rangefind", args, 0);
      if (!bot.spec.sensors.some((s) => s.id === id && s.kind === "rangefinder")) {
        throw new ProgramError(`this Bot has no rangefinder in Slot '${id}'`);
      }
      return reading(`rangefind:${id}`, () => {
        const r = rangefind(world, bot, id);
        return r === null ? null : { distance: r.distance, hit: r.hit };
      });
    },
    incoming: () =>
      reading("incoming", () =>
        incoming(world, bot).map((p) => ({ bearing: p.bearing, ticksToImpact: p.ticksToImpact, category: p.category })),
      ),
    terrainHere: () => terrainAt(world.map, bot),
    terrainAt: (args) => onMap("terrainAt", argNumber("terrainAt", args, 0), argNumber("terrainAt", args, 1)),
    checkTerrain: (args) => {
      const bearing = argNumber("checkTerrain", args, 0);
      const distance = argNumber("checkTerrain", args, 1);
      const v = headingVector(normalizeAbsAngle(bot.heading + bearing));
      return onMap("checkTerrain", bot.x + v.x * distance, bot.y + v.y * distance);
    },
    terrainTable: () =>
      fromHost(Object.fromEntries(world.ruleset.terrains.map((t) => [t.name, { speed: t.speed, accel: t.accel }]))),
    sin: math("sin", sinDeg, 1),
    cos: math("cos", cosDeg, 1),
    tan: math("tan", tanDeg, 1),
    asin: math("asin", asinDeg, 1),
    acos: math("acos", acosDeg, 1),
    atan2: math("atan2", atan2Deg, 2),
    hypot: math("hypot", hypot, 2),
    normalizeAngle: math("normalizeAngle", normalizeAngle, 1),
    bearingTo: math("bearingTo", (x, y) => normalizeAngle(absBearing(bot, { x, y }) - bot.heading), 2),
    absBearingTo: math("absBearingTo", (x, y) => absBearing(bot, { x, y }), 2),
    distanceTo: math("distanceTo", (x, y) => hypot(x - bot.x, y - bot.y), 2),
    random: () => random.next(),
  };
}

/**
 * Creates the world, checks and prepares every Bot's Program, and runs each
 * init phase in Bot id order. A Program whose init phase fails halts, and its
 * Bot is Disabled before the first Tick. Throws if a Program does not check.
 */
export function createGame(setup: GameSetup): Game {
  const { ruleset, timeLimitTicks } = setup;
  if (!Number.isInteger(timeLimitTicks) || timeLimitTicks < 1) throw new Error("the time limit must be a whole number of Ticks, at least 1");
  const world = createWorld(setup);
  const sources = setup.entries.flatMap((e) => e.bots.map((b) => b.program));
  const { limits } = ruleset;

  const programs = world.bots.map((bot, i): BotProgram => {
    const checked = check(sources[i] ?? "", { language: R1_LANGUAGE, maxSourceBytes: limits.maxSourceBytes, slots: programSlots(bot.spec) });
    if (!checked.ok) {
      const errors = checked.errors.map((e) => `${String(e.line)}:${String(e.column)} ${e.message}`).join("; ");
      throw new Error(`the Program of Bot "${bot.name}" does not check: ${errors}`);
    }
    const run: RunState = { issued: { fire: new Map() }, readings: new Map() };
    const host = hostFunctions(world, bot, run, new SeededRandom(world.seed, bot.id));
    return { bot, interpreter: new Interpreter(checked.program, { language: R1_LANGUAGE, limits, host }), run };
  });

  const gameValue = fromHost({ tickRate: ruleset.tickRate, timeLimitTicks, playerCount: setup.entries.length });
  const map = mapValue(world);
  const players = setup.entries.map((e, i) => e.player ?? `entry:${String(i)}`);
  const before = remainingPlayers(world, players);
  const runs: ProgramRun[] = [];
  const events: TickEvent[] = [];
  for (const p of programs) {
    const result = p.interpreter.init({
      budget: limits.initBudgetMultiplier * p.bot.spec.operationBudget,
      values: { self: selfValue(p.bot, 0), game: gameValue, map },
    });
    runs.push({ bot: p.bot.id, result });
    if (result.halt !== null) disableBot(p.bot, "programHalted", 0, events);
  }
  const game: Game = {
    setup,
    players,
    world,
    timeLimitTicks,
    start: { tick: 0, runs, events },
    programs,
    gameValue,
    foeDamage: new Map(players.map((p) => [p, 0])),
    history: [],
    logs: world.bots.map((b) => ({ bot: b.id, name: b.name, player: players[b.entry] ?? "", runs: [] })),
    result: null,
  };
  finishTick(game, game.start, before);
  return game;
}

/** Records a Tick just played and judges the Game; `before` holds the Players remaining at its start. */
function finishTick(game: Game, report: TickReport, before: ReadonlySet<string>): void {
  const { world, players } = game;
  for (const run of report.runs) game.logs[run.bot - 1]?.runs.push({ tick: report.tick, result: run.result });
  game.history.push(replayTick(world, report.events));
  addFoeDamage(world, players, report.events, game.foeDamage);
  game.result = judge(world, players, game.foeDamage, before, game.timeLimitTicks);
}

/**
 * Plays one Tick: runs `tick()` for every active Bot whose Program has not
 * halted, in Bot id order, against the world as it stands, then steps the
 * world with the commands they issued. A Program that halts at the end of its
 * run Disables its Bot before the Tick resolves, so its commands are dropped.
 * Then the Game is judged, setting `game.result` if it has ended. Throws if
 * the Game had already ended.
 */
export function playTick(game: Game): TickReport {
  const { world } = game;
  if (game.result !== null) throw new Error(`the Game ended in Tick ${String(game.result.tick)}`);
  const before = remainingPlayers(world, game.players);
  const tick = world.tick + 1;
  const map = mapValue(world);
  const runs: ProgramRun[] = [];
  const commands = new Map<number, BotCommands>();
  const halted: BotState[] = [];
  for (const p of game.programs) {
    if (p.bot.status !== "active" || p.interpreter.halted) continue;
    p.run.issued = { fire: new Map() };
    p.run.readings.clear();
    const result = p.interpreter.tick({
      budget: p.bot.spec.operationBudget,
      values: { self: selfValue(p.bot, tick), game: game.gameValue, map },
    });
    runs.push({ bot: p.bot.id, result });
    if (result.halt !== null) {
      halted.push(p.bot);
      continue;
    }
    const { throttle, turn, fire } = p.run.issued;
    commands.set(p.bot.id, {
      ...(throttle === undefined ? {} : { throttle }),
      ...(turn === undefined ? {} : { turn }),
      ...(fire.size === 0 ? {} : { fire: Object.fromEntries(fire) }),
    });
  }
  const events: TickEvent[] = [];
  for (const bot of halted) disableBot(bot, "programHalted", tick, events);
  events.push(...step(world, commands));
  const report = { tick, runs, events };
  finishTick(game, report, before);
  return report;
}

/** Plays Ticks until the Game ends, and returns its result. */
export function playGame(game: Game): GameResult {
  while (game.result === null) playTick(game);
  return game.result;
}
