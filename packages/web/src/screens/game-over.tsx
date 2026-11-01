/**
 * Game Over (frontend spec section 7, Game Over): shown over the final frame
 * when a Game ends. The Winner, or a Draw, and how the Game was decided; one
 * row per Entry with its Emblem, Player, damage dealt to Foes, remaining Hit
 * Points and whether any of its Bots is still standing; under each Entry its
 * Bots, each with its Icon, the damage each dealt and took and, if Disabled, the Tick and
 * cause; and the buttons to watch again or go back to the Games.
 */

import { entryColor } from "../draw/colors.js";
import type { Game } from "../games.js";
import { Link } from "../hooks.js";
import { botFigures, disabledCauseText, disabledTick, entryFigures } from "../viewer/figures.js";
import { clockText } from "../viewer/playback.js";
import type { ViewerReplay } from "../viewer/scene.js";
import { figureText } from "./bot-inset.js";
import { Emblem, type EmblemOwner } from "./emblem.js";
import { Icon } from "./icon.js";

export type GameResult = NonNullable<Game["result"]>;

/** Why the Game ended, as a clause. */
const END_CLAUSE: Record<GameResult["end"], string> = {
  last_standing: "was the last standing",
  none_standing: "no Bot was left standing",
  time_limit: "the time limit was reached",
};

/** The Game's outcome as Game Over heads it: the Winner or a Draw, then how the Game was decided. */
export function outcomeText(result: GameResult): { readonly title: string; readonly how: string } {
  const { winner, end, decidedBy } = result;
  if (winner === null) {
    return { title: "Draw", how: `${capitalized(END_CLAUSE[end])}, and the Players were tied on damage dealt to Foes and remaining Hit Points.` };
  }
  const title = `${winner.username} wins`;
  switch (decidedBy) {
    case "foe_damage":
      return { title, how: `${capitalized(END_CLAUSE[end])}; decided on damage dealt to Foes.` };
    case "hit_points":
      return { title, how: `${capitalized(END_CLAUSE[end])}; decided on remaining Hit Points, after a tie on damage dealt to Foes.` };
    case "survival":
    case null:
      return { title, how: `${winner.username} ${END_CLAUSE.last_standing}.` };
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface GameOverProps {
  readonly result: GameResult;
  readonly replay: ViewerReplay;
  /** Each Player, by Player id. */
  readonly players: ReadonlyMap<string, EmblemOwner>;
  /** Each Bot's Icon hash, or null for none, by Bot Name. */
  readonly icons: ReadonlyMap<string, string | null>;
  /** Watches the Replay again from Tick 0. */
  readonly onWatchAgain: () => void;
}

export function GameOver({ result, replay, players, icons, onWatchAgain }: GameOverProps) {
  const { title, how } = outcomeText(result);
  const figures = entryFigures(replay);
  const final = replay.scene(replay.lastTick);
  return (
    <section className="game-over" aria-label="Game Over">
      <h3>{title}</h3>
      <p>
        {how} Ended at {clockText(result.tick, replay.tickRate)} (Tick {result.tick}).
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Player and Bots</th>
            <th scope="col">Damage dealt to Foes</th>
            <th scope="col">Damage taken</th>
            <th scope="col">Hit Points</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        {replay.entries.map((entry, i) => {
          const player = players.get(entry.player) ?? { id: entry.player, username: entry.player, emblem: null };
          const totals = figures[i];
          const won = result.winner?.id === entry.player;
          return (
            <tbody key={entry.player} className={won ? "game-over-winner" : undefined}>
              <tr className="game-over-entry">
                <th scope="row">
                  <Emblem player={player} color={entryColor(i)} size={24} /> {player.username}
                  {won ? <span className="game-over-badge">Winner</span> : null}
                </th>
                <td>{figureText(totals?.dealtToFoes ?? 0)}</td>
                <td />
                <td>{figureText(totals?.hitPoints ?? 0)}</td>
                <td>{totals?.standing === true ? "Still standing" : "All Disabled"}</td>
              </tr>
              {entry.bots.map((bot) => {
                const f = botFigures(replay, bot.id, replay.lastTick);
                const hitPoints = final.bots.find((b) => b.id === bot.id)?.hitPoints ?? 0;
                return (
                  <tr key={bot.id} className="game-over-bot">
                    <th scope="row">
                      <Icon icon={icons.get(bot.name)} name={bot.name} size={20} />
                      {bot.name}
                    </th>
                    <td>{figureText(f.dealtToFoes)}</td>
                    <td>{figureText(f.taken)}</td>
                    <td>{f.disabled === undefined ? figureText(hitPoints) : ""}</td>
                    <td>
                      {f.disabled === undefined
                        ? "Standing"
                        : `Disabled in Tick ${String(disabledTick(f.disabled))}: ${disabledCauseText(f.disabled.cause)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
      <p className="game-over-actions">
        <button type="button" onClick={onWatchAgain}>
          Watch again
        </button>
        <Link to="/">Back to Games</Link>
      </p>
    </section>
  );
}
