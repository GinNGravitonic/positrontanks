/**
 * Per-Bot figures (frontend spec sections 7 and 8, Bot inset and Game Over),
 * computed from the Replay's events up to a moment of the Game: the damage a
 * Bot dealt to Foes and took, and whether it is Disabled, when and why.
 *
 * Damage counts as the engine counts it toward a Player's Foe damage: Hit
 * Points actually removed, a shot for the Bot that fired it and a ram for the
 * other Bot. Damage between Friends (Bots of one Entry) is dealt to no Foe,
 * though the Bot hit still takes it, as it does damage dealt by no Bot.
 */

import type { Disablement, Time, ViewerReplay } from "./scene.js";

export interface BotFigures {
  readonly dealtToFoes: number;
  readonly taken: number;
  /** Set once the Bot is Disabled. */
  readonly disabled?: Disablement;
}

/** `bot`'s figures at `time`, counting the events that have happened by then. */
export function botFigures(replay: Pick<ViewerReplay, "entries" | "damage" | "disablements">, bot: number, time: Time): BotFigures {
  const entryOf = new Map<number, number>();
  replay.entries.forEach((entry, i) => {
    for (const b of entry.bots) entryOf.set(b.id, i);
  });
  let dealtToFoes = 0;
  let taken = 0;
  for (const d of replay.damage) {
    if (d.time > time) break;
    if (d.target === bot) taken += d.amount;
    else if (d.dealer === bot && entryOf.get(d.target) !== entryOf.get(bot)) dealtToFoes += d.amount;
  }
  const disabled = replay.disablements.find((d) => d.bot === bot && d.time <= time);
  return disabled === undefined ? { dealtToFoes, taken } : { dealtToFoes, taken, disabled };
}

/**
 * An Entry's figures at the end of the Game (frontend spec section 7, Game
 * Over), as the engine counts them for the result: the damage its Bots dealt
 * to Foes, the Hit Points of those not Disabled, and whether any is.
 */
export interface EntryFigures {
  readonly player: string;
  readonly dealtToFoes: number;
  readonly hitPoints: number;
  readonly standing: boolean;
}

/** Each Entry's figures in the final frame, in Entry order. */
export function entryFigures(replay: Pick<ViewerReplay, "entries" | "damage" | "disablements" | "lastTick" | "scene">): EntryFigures[] {
  const final = replay.scene(replay.lastTick);
  return replay.entries.map((entry) => {
    const bots = new Set(entry.bots.map((b) => b.id));
    const live = final.bots.filter((b) => bots.has(b.id) && !b.disabled);
    return {
      player: entry.player,
      dealtToFoes: entry.bots.reduce((sum, b) => sum + botFigures(replay, b.id, replay.lastTick).dealtToFoes, 0),
      hitPoints: live.reduce((sum, b) => sum + b.hitPoints, 0),
      standing: live.length > 0,
    };
  });
}

/** The Tick in which a Bot was Disabled. */
export function disabledTick(disablement: Disablement): number {
  return Math.ceil(disablement.time);
}

/** Why a Bot was Disabled, in words. */
export function disabledCauseText(cause: string): string {
  switch (cause) {
    case "destroyed":
      return "destroyed";
    case "programHalted":
      return "its Program halted";
    default:
      return cause;
  }
}
