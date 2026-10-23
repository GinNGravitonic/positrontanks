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
export { ARMOR_SIDES, MOTOR_KIND, WEAPON_CATEGORIES, WEAPON_KIND, checkRuleset, deriveBotSpec } from "./bot-spec.js";
export type { BotSpec, WeaponCategory, WeaponSpec } from "./bot-spec.js";
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
export { headingVector, placeShape } from "./geometry.js";
export type { LocalShape, Point, WorldShape } from "./geometry.js";
export { hashWorld } from "./hash.js";
export { terrainAt } from "./terrain.js";
export { MAX_SUBSTEPS, MIN_RAM_SPEED, RAM_DAMAGE_PER_JOULE, SUBSTEP_LENGTH, step, terrainMultipliers } from "./tick.js";
export type { BotCommands } from "./tick.js";
export { canFire, inFiringArc, muzzle, weaponOf } from "./weapons.js";
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
