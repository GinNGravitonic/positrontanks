/**
 * A fingerprint of the simulated state, for checking that the same inputs
 * reach the same world (ADR-0001). Numbers are hashed by their exact IEEE-754
 * bits, so any difference in the last bit shows.
 */

import type { World } from "./world.js";

class Hasher {
  #h1 = 0x811c9dc5;
  #h2 = 0x9e3779b9;
  readonly #view = new DataView(new ArrayBuffer(8));

  word(w: number): void {
    this.#h1 = Math.imul(this.#h1 ^ w, 0x01000193) >>> 0;
    this.#h2 = Math.imul(this.#h2 ^ (w >>> 16) ^ (w << 16), 0x85ebca6b) >>> 0;
  }

  number(v: number): void {
    this.#view.setFloat64(0, v);
    this.word(this.#view.getUint32(0));
    this.word(this.#view.getUint32(4));
  }

  string(s: string): void {
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
  }

  digest(): string {
    return this.#h1.toString(16).padStart(8, "0") + this.#h2.toString(16).padStart(8, "0");
  }
}

/** A hex digest of the Tick, every Bot's state, every live Obstacle's Hit Points and every Projectile. */
export function hashWorld(world: World): string {
  const h = new Hasher();
  h.number(world.tick);
  h.number(world.bots.length);
  for (const bot of world.bots) {
    h.number(bot.id);
    h.number(bot.x);
    h.number(bot.y);
    h.number(bot.heading);
    h.number(bot.speed);
    h.number(bot.turnRate);
    h.number(bot.throttle);
    h.number(bot.turn);
    h.number(bot.hitPoints);
    h.string(bot.status);
    h.string(bot.disabledCause ?? "");
    for (const w of bot.weapons) h.number(w.ticksUntilReady);
  }
  h.number(world.obstacles.length);
  for (const o of world.obstacles) {
    h.string(o.obstacle.id);
    h.number(o.hitPoints ?? -1);
  }
  h.number(world.projectiles.length);
  for (const p of world.projectiles) {
    h.number(p.id);
    h.number(p.x);
    h.number(p.y);
    h.number(p.remaining);
  }
  h.number(world.nextProjectileId);
  return h.digest();
}
