/**
 * The Game page (frontend spec section 5), by state: an Open Game's Entries
 * with entering, withdrawing and cancelling; links into the viewer for a
 * Running or Finished Game; why and when a Cancelled Game was cancelled.
 * A failed action shows the API's problem, and a 409 reloads the Game, whose
 * state has changed under the page.
 */

import { useState } from "react";
import { ApiError } from "../api/client.js";
import { Link, useLoad, useServices, useSession } from "../hooks.js";
import {
  cancelGame,
  cancelReasonText,
  gameActions,
  getGame,
  localTime,
  PACE_TEXT,
  problemText,
  resultText,
  STATE_TEXT,
  withdrawEntry,
  type Game,
} from "../games.js";

export const gameRoute = (id: string, sub?: "enter" | "watch") => `/games/${encodeURIComponent(id)}${sub === undefined ? "" : `/${sub}`}`;

export function GamePage({ id }: { readonly id: string }) {
  const { api } = useServices();
  const playerId = useSession()?.player.id ?? "";
  const game = useLoad(() => getGame(api, id), id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  if (game.status === "loading") return <p>Loading…</p>;
  if (game.status === "failed") {
    if (game.error instanceof ApiError && game.error.status === 404) {
      return (
        <>
          <h2>No such Game</h2>
          <p>
            There is no Game {id}. <Link to="/">Back to Games</Link>
          </p>
        </>
      );
    }
    return (
      <p className="error" role="alert">
        {problemText(game.error)}
      </p>
    );
  }

  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    action().then(
      () => {
        setBusy(false);
        game.reload();
      },
      (error: unknown) => {
        setBusy(false);
        setProblem(problemText(error));
        if (error instanceof ApiError && error.status === 409) game.reload();
      },
    );
  };

  return (
    <GameView
      game={game.value}
      playerId={playerId}
      busy={busy}
      {...(problem === undefined ? {} : { problem })}
      onCancel={() => {
        act(() => cancelGame(api, id));
      }}
      onWithdraw={(entryId) => {
        act(() => withdrawEntry(api, id, entryId));
      }}
      onRefresh={game.reload}
    />
  );
}

export interface GameViewProps {
  readonly game: Game;
  /** The signed-in Player. */
  readonly playerId: string;
  /** True while an action is being sent. */
  readonly busy: boolean;
  /** The last action's failure, in words. */
  readonly problem?: string;
  readonly onCancel: () => void;
  readonly onWithdraw: (entryId: string) => void;
  readonly onRefresh: () => void;
}

export function GameView({ game, playerId, busy, problem, onCancel, onWithdraw, onRefresh }: GameViewProps) {
  return (
    <article className="game">
      <h2>
        {game.map.name} <span className={`state ${game.state}`}>{STATE_TEXT[game.state]}</span>
      </h2>
      <dl>
        <dt>Initiator</dt>
        <dd>{game.initiator.username}</dd>
        <dt>Ruleset</dt>
        <dd>{game.rulesetVersion}</dd>
        <dt>Map</dt>
        <dd>
          {game.map.name}, Revision {String(game.map.revision)}
        </dd>
        <dt>Entries</dt>
        <dd>
          {String(game.entryCount)} of {String(game.playerCount)}
        </dd>
        <dt>Point Budget</dt>
        <dd>{String(game.pointBudget)}</dd>
        <dt>Time limit</dt>
        <dd>
          {String(game.timeLimitSeconds)} s, {PACE_TEXT[game.pace]}
        </dd>
        <dt>Created</dt>
        <dd>{localTime(game.createdAt)}</dd>
        {game.state === "open" ? (
          <>
            <dt>Fills by</dt>
            <dd>{localTime(game.fillDeadline)}</dd>
          </>
        ) : null}
        {game.startedAt === null ? null : (
          <>
            <dt>Started</dt>
            <dd>{localTime(game.startedAt)}</dd>
          </>
        )}
        {game.endedAt === null ? null : (
          <>
            <dt>{game.state === "cancelled" ? "Cancelled" : "Ended"}</dt>
            <dd>{localTime(game.endedAt)}</dd>
          </>
        )}
      </dl>

      {problem === undefined ? null : (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <StatePanel game={game} playerId={playerId} busy={busy} onCancel={onCancel} onWithdraw={onWithdraw} onRefresh={onRefresh} />
      <Entries game={game} playerId={playerId} />
    </article>
  );
}

function StatePanel({ game, playerId, busy, onCancel, onWithdraw, onRefresh }: Omit<GameViewProps, "problem">) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  switch (game.state) {
    case "open": {
      const actions = gameActions(game, playerId);
      return (
        <div className="actions">
          {actions.enter ? <Link to={gameRoute(game.id, "enter")}>Enter this Game</Link> : null}
          {actions.withdrawEntryId === undefined ? null : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (actions.withdrawEntryId !== undefined) onWithdraw(actions.withdrawEntryId);
              }}
            >
              Withdraw my Entry
            </button>
          )}
          {!actions.cancel ? null : confirmCancel ? (
            <span>
              Cancel this Game for everyone?{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmCancel(false);
                  onCancel();
                }}
              >
                Yes, cancel it
              </button>{" "}
              <button
                type="button"
                onClick={() => {
                  setConfirmCancel(false);
                }}
              >
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmCancel(true);
              }}
            >
              Cancel Game
            </button>
          )}
        </div>
      );
    }
    case "running":
      return game.pace === "realtime" ? (
        <p>
          This Game is being played now. <Link to={gameRoute(game.id, "watch")}>Watch it live</Link>
        </p>
      ) : (
        <p>
          This Game is being played at unthrottled Pace, so it cannot be watched live; its Replay comes when it is Finished.{" "}
          <Link to={gameRoute(game.id, "watch")}>Wait for the Replay</Link>{" "}
          <button type="button" onClick={onRefresh}>
            Check again
          </button>
        </p>
      );
    case "finished":
      return (
        <p>
          {game.result === null ? "Finished." : `${resultText(game.result)}.`} <Link to={gameRoute(game.id, "watch")}>Watch the Replay</Link>
        </p>
      );
    case "cancelled":
      return <p>{cancelReasonText(game)}</p>;
  }
}

function Entries({ game, playerId }: { readonly game: Game; readonly playerId: string }) {
  if (game.entries.length === 0) return <p>No Entries yet.</p>;
  return (
    <table className="entries">
      <thead>
        <tr>
          <th>Player</th>
          <th>Bots</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {game.entries.map((entry) => (
          <tr key={entry.id}>
            <td>
              {entry.player.username}
              {entry.player.id === playerId ? " (you)" : ""}
            </td>
            <td>{entry.bots.map((bot) => bot.name).join(", ")}</td>
            <td>{entry.cost === undefined ? "hidden" : String(entry.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
