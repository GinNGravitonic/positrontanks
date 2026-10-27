/**
 * How a Game ends and who wins it (v1.md section 2, Win condition; the rules
 * are in ruleset-data/spec/r1/engine-r1.md section 11).
 *
 * A Game ends when at most one Player has any Bot not Disabled, or when its
 * time limit is reached. At the time limit, or when the last Players are all
 * Disabled in the same Tick, the tiebreaks decide: damage dealt to Foes, then
 * remaining Hit Points, then a Draw.
 */

import type { TickEvent } from "./events.js";
import type { BotState, World } from "./world.js";

/** Why a Game ended. */
export type GameEnd =
  /** One Player has a Bot not Disabled, and no other Player does. */
  | "lastStanding"
  /** The last Players' Bots were all Disabled in the same Tick. */
  | "noneStanding"
  /** The time limit was reached with several Players remaining. */
  | "timeLimit";

/** One Player's figures at the end of a Game. */
export interface Standing {
  readonly player: string;
  /** Damage the Player's Bots dealt to Foes over the Game. */
  readonly foeDamage: number;
  /** The total Hit Points of the Player's Bots that are not Disabled. */
  readonly hitPoints: number;
  /** Whether the Player has any Bot not Disabled. */
  readonly remaining: boolean;
}

export interface GameResult {
  /** The Tick the Game ended in; 0 if it ended in the init phase. */
  readonly tick: number;
  readonly end: GameEnd;
  /** The winning Player, or null for a Draw. */
  readonly winner: string | null;
  /** What picked the Winner: survival, a tiebreak, or null for a Draw. */
  readonly decidedBy: "survival" | "foeDamage" | "hitPoints" | null;
  /** One per Player, in order of their first Entry. */
  readonly standings: readonly Standing[];
}

/** Whether a Bot still counts toward its Player's survival. */
function standing(bot: BotState): boolean {
  return bot.status !== "disabled";
}

/** The Players with any Bot not Disabled; `players` gives each Entry's Player. */
export function remainingPlayers(world: World, players: readonly string[]): Set<string> {
  return new Set(world.bots.filter(standing).map((b) => players[b.entry] ?? ""));
}

/**
 * Adds the Bot damage in `events` that was dealt to Foes to the dealing
 * Player's total. A shot counts for the Bot that fired it, a ram for the
 * other Bot; damage from a wreck, an Obstacle or the boundary counts for no
 * one, and neither does damage between Friends. `dealt` already leaves out
 * what Armor absorbed and is capped at the target's remaining Hit Points.
 */
export function addFoeDamage(world: World, players: readonly string[], events: readonly TickEvent[], totals: Map<string, number>): void {
  for (const e of events) {
    if (e.type !== "damage" || e.target.kind !== "bot") continue;
    const dealer =
      e.source.kind === "weapon" ? e.source.bot : e.source.with.kind === "bot" ? e.source.with.id : undefined;
    if (dealer === undefined) continue;
    const from = world.bots[dealer - 1];
    const to = world.bots[e.target.id - 1];
    if (from === undefined || to === undefined || from.entry === to.entry) continue;
    const player = players[from.entry] ?? "";
    totals.set(player, (totals.get(player) ?? 0) + e.dealt);
  }
}

/**
 * Judges the Game after Tick `world.tick`, or null if it goes on. `before`
 * holds the Players remaining at the start of that Tick: if none remain at
 * its end, the tiebreaks decide among them.
 */
export function judge(
  world: World,
  players: readonly string[],
  foeDamage: ReadonlyMap<string, number>,
  before: ReadonlySet<string>,
  timeLimitTicks: number,
): GameResult | null {
  const remaining = remainingPlayers(world, players);
  let end: GameEnd;
  if (remaining.size === 1) end = "lastStanding";
  else if (remaining.size === 0) end = "noneStanding";
  else if (world.tick >= timeLimitTicks) end = "timeLimit";
  else return null;

  const standings = [...new Set(players)].map((player): Standing => {
    const bots = world.bots.filter((b) => players[b.entry] === player && standing(b));
    return {
      player,
      foeDamage: foeDamage.get(player) ?? 0,
      hitPoints: bots.reduce((sum, b) => sum + b.hitPoints, 0),
      remaining: bots.length > 0,
    };
  });
  const result = (winner: string | null, decidedBy: GameResult["decidedBy"]): GameResult => ({
    tick: world.tick,
    end,
    winner,
    decidedBy,
    standings,
  });
  if (end === "lastStanding") return result([...remaining][0] ?? null, "survival");

  const candidates = standings.filter((s) => (end === "timeLimit" ? s.remaining : before.has(s.player)));
  const best = (list: readonly Standing[], key: (s: Standing) => number): Standing[] => {
    const top = Math.max(...list.map(key));
    return list.filter((s) => key(s) === top);
  };
  const byDamage = best(candidates, (s) => s.foeDamage);
  if (byDamage.length === 1) return result(byDamage[0]?.player ?? null, "foeDamage");
  const byHitPoints = best(byDamage, (s) => s.hitPoints);
  if (byHitPoints.length === 1) return result(byHitPoints[0]?.player ?? null, "hitPoints");
  return result(null, null);
}
