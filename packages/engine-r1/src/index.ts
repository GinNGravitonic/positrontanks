export {
  acosDeg,
  asinDeg,
  atan2Deg,
  cosDeg,
  hypot,
  normalizeAbsAngle,
  normalizeAngle,
  sinDeg,
  tanDeg,
} from "./math.js";
export { SeededRandom } from "./random.js";
export {
  ARMOR_SIDES,
  MOTOR_KIND,
  PROCESSOR_KIND,
  SENSOR_KIND,
  SENSOR_KINDS,
  WEAPON_CATEGORIES,
  WEAPON_KIND,
  checkRuleset,
  deriveBotSpec,
} from "./bot-spec.js";
export type { BotSpec, SensorKind, SensorSpec, WeaponCategory, WeaponSpec } from "./bot-spec.js";
export { createGame, playGame, playTick, programSlots } from "./game.js";
export type {
  BotProgram,
  Game,
  GameSetup,
  IssuedCommands,
  ProgramBotSetup,
  ProgramEntrySetup,
  ProgramLog,
  ProgramRun,
  RunState,
  TickReport,
} from "./game.js";
export { addFoeDamage, judge, remainingPlayers } from "./outcome.js";
export type { GameEnd, GameResult, Standing } from "./outcome.js";
export { gameRecord, programLogs, replayGame, replayOf } from "./record.js";
export type { GameRecord, RecordedBot, RecordedEntry, StartingPosition } from "./record.js";
export { replayTick } from "./replay.js";
export type { BotFrame, ProjectileFrame, Replay, ReplayBot, ReplayEntry, ReplayTick } from "./replay.js";
export { incoming, rangefind, scan } from "./sensors.js";
export type { IncomingProjectile, RadarContact, RangefinderReading } from "./sensors.js";
export { damageBot, damageObstacle, disableBot, struckSide } from "./damage.js";
export type {
  Collider,
  CollisionEvent,
  CollisionSource,
  DamageEvent,
  DamageSource,
  DamageTarget,
  DisabledEvent,
  FiredEvent,
  ImpactEvent,
  ObstacleDestroyedEvent,
  TickEvent,
  WeaponSource,
} from "./events.js";
export { absBearing, headingVector, inArc, placeShape } from "./geometry.js";
export type { LocalShape, Point, WorldShape } from "./geometry.js";
export { hashWorld } from "./hash.js";
export { terrainAt } from "./terrain.js";
export { MAX_SUBSTEPS, MIN_RAM_SPEED, RAM_DAMAGE_PER_JOULE, SUBSTEP_LENGTH, step, terrainMultipliers } from "./tick.js";
export type { BotCommands } from "./tick.js";
export { canFire, inFiringArc, weaponOf } from "./weapons.js";
export type { FireTarget } from "./weapons.js";
export { SPAWN_ATTEMPTS, WORLD_STREAM, botShape, createWorld, obstacleShape } from "./world.js";
export type {
  BotSetup,
  BotState,
  BotStatus,
  DisabledCause,
  EntrySetup,
  ObstacleState,
  ProjectileState,
  WeaponState,
  World,
  WorldSetup,
} from "./world.js";
