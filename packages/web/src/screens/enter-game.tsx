/**
 * The Enter Game screen (frontend spec section 5): pick Bot Designs from the
 * Garage at their latest Revision, name each Bot, and see the running total
 * against the Point Budget. Problems the API reports against a Bot, or the
 * Entry as a whole, are shown by it; submitting goes back to the Game's page.
 */

import { useState, type SubmitEvent } from "react";
import { ApiError } from "../api/client.js";
import {
  botField,
  designsForRuleset,
  entryFromFields,
  entryProblemFields,
  entryTotal,
  newBotName,
  submitEntry,
  takenBotNames,
  BOT_NAME_MAX_LENGTH,
  type BotDesignSummary,
  type EntryBotFields,
  type EntryProblems,
} from "../entries.js";
import { formProblems, gameActions, getGame, problemText, STATE_TEXT, type Game } from "../games.js";
import { Link, useLoad, useServices, useSession } from "../hooks.js";
import { gameRoute } from "./game.js";
import { Icon } from "./icon.js";

export function EnterGameScreen({ id }: { readonly id: string }) {
  const { api } = useServices();
  const playerId = useSession()?.player.id ?? "";
  const game = useLoad(() => getGame(api, id), id);
  const back = (
    <p>
      <Link to={gameRoute(id)}>Back to the Game</Link>
    </p>
  );

  if (game.status === "loading") return <p>Loading…</p>;
  if (game.status === "failed") {
    return (
      <>
        <h2>Enter Game</h2>
        <p className="error" role="alert">
          {game.error instanceof ApiError && game.error.status === 404 ? `There is no Game ${id}.` : problemText(game.error)}
        </p>
        {back}
      </>
    );
  }
  const reason = cannotEnter(game.value, playerId);
  if (reason !== undefined) {
    return (
      <>
        <h2>Enter Game</h2>
        <p>{reason}</p>
        {back}
      </>
    );
  }
  return <EntryLoader game={game.value} />;
}

/** Why the Player cannot enter `game`, if they cannot. */
export function cannotEnter(game: Game, playerId: string): string | undefined {
  if (game.state !== "open") return `This Game is ${STATE_TEXT[game.state]}, so it takes no more Entries.`;
  if (game.entries.some((entry) => entry.player.id === playerId)) return "You have already entered this Game.";
  if (!gameActions(game, playerId).enter) return "This Game is full.";
  return undefined;
}

function EntryLoader({ game }: { readonly game: Game }) {
  const { api } = useServices();
  const designs = useLoad(() => designsForRuleset(api, game.rulesetVersion), game.rulesetVersion);
  if (designs.status === "loading") return <p>Loading your Garage…</p>;
  if (designs.status === "failed") {
    return (
      <p className="error" role="alert">
        {problemText(designs.error)}
      </p>
    );
  }
  return <EntryForm game={game} designs={designs.value} />;
}

function EntryForm({ game, designs }: { readonly game: Game; readonly designs: readonly BotDesignSummary[] }) {
  const { api, router } = useServices();
  const [bots, setBots] = useState<readonly EntryBotFields[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [problems, setProblems] = useState<EntryProblems>({ fields: {} });
  const [busy, setBusy] = useState(false);

  const onAdd = (design: BotDesignSummary) => {
    // Row problems are by index, so changing the rows drops them.
    setProblems({ fields: {} });
    setBots((b) => [...b, { key: nextKey, designId: design.id, name: newBotName(design, [...takenBotNames(game), ...b.map((bot) => bot.name)]) }]);
    setNextKey((k) => k + 1);
  };
  const onRemove = (key: number) => {
    setProblems({ fields: {} });
    setBots((b) => b.filter((bot) => bot.key !== key));
  };
  const onRename = (index: number, name: string) => {
    const field = botField(index, "name");
    setProblems((p) => (p.fields[field] === undefined ? p : { ...p, fields: { ...p.fields, [field]: undefined } }));
    setBots((b) => b.map((bot, i) => (i === index ? { ...bot, name } : bot)));
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const checked = entryFromFields(bots, designs);
    if ("problems" in checked) {
      setProblems(checked.problems);
      return;
    }
    setBusy(true);
    setProblems({ fields: {} });
    submitEntry(api, game.id, checked.entry).then(
      () => {
        router.navigate(gameRoute(game.id));
      },
      (error: unknown) => {
        const { fields, aliases } = entryProblemFields(bots.length);
        setProblems(formProblems(error, fields, aliases));
        setBusy(false);
      },
    );
  };

  return (
    <EnterGameView
      game={game}
      designs={designs}
      bots={bots}
      problems={problems}
      busy={busy}
      onAdd={onAdd}
      onRemove={onRemove}
      onRename={onRename}
      onSubmit={submit}
    />
  );
}

export interface EnterGameViewProps {
  readonly game: Game;
  /** The Player's Bot Designs for the Game's Ruleset. */
  readonly designs: readonly BotDesignSummary[];
  readonly bots: readonly EntryBotFields[];
  readonly problems: EntryProblems;
  /** True while the Entry is being submitted. */
  readonly busy: boolean;
  readonly onAdd: (design: BotDesignSummary) => void;
  readonly onRemove: (key: number) => void;
  readonly onRename: (index: number, name: string) => void;
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
}

export function EnterGameView({ game, designs, bots, problems, busy, onAdd, onRemove, onRename, onSubmit }: EnterGameViewProps) {
  const total = entryTotal(bots, designs);
  const over = total > game.pointBudget;
  const problem = (name: string) => {
    const text = problems.fields[name];
    return text === undefined ? null : (
      <p className="error" id={`${name}-problem`}>
        {text}
      </p>
    );
  };
  const invalid = (name: string) => (problems.fields[name] === undefined ? {} : { "aria-invalid": true, "aria-describedby": `${name}-problem` });

  return (
    <form className="enter-game" onSubmit={onSubmit} noValidate>
      <h2>Enter Game</h2>
      <p>
        <Link to={gameRoute(game.id)}>{game.map.name}</Link>, Ruleset {game.rulesetVersion}: {String(game.entryCount)} of {String(game.playerCount)} Entries,
        Point Budget {String(game.pointBudget)}.
      </p>
      {problems.form === undefined ? null : (
        <p className="error" role="alert">
          {problems.form}
        </p>
      )}

      <section aria-labelledby="garage-heading">
        <h3 id="garage-heading">Your Garage</h3>
        {designs.length === 0 ? (
          <p>
            You have no Bot Designs for Ruleset {game.rulesetVersion}. Make one with the CLI: <code>positrontanks designs create</code>
          </p>
        ) : (
          <table className="designs">
            <thead>
              <tr>
                <th>Bot Design</th>
                <th>Revision</th>
                <th>Cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {designs.map((design) => (
                <tr key={design.id}>
                  <td>
                    <Icon icon={design.icon} name={design.name} size={20} />
                    {design.name}
                  </td>
                  <td>{String(design.latestRevision.number)}</td>
                  <td>{String(design.latestRevision.cost)}</td>
                  <td>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Add a ${design.name} Bot`}
                      onClick={() => {
                        onAdd(design);
                      }}
                    >
                      Add
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="entry-heading">
        <h3 id="entry-heading">Your Entry</h3>
        {bots.length === 0 ? <p>No Bots yet: add them from your Garage.</p> : null}
        <ol className="entry-bots">
          {bots.map((bot, i) => {
            const design = designs.find((d) => d.id === bot.designId);
            const name = botField(i, "name");
            return (
              <li key={bot.key} className={problems.fields[botField(i, "designId")] === undefined ? undefined : "invalid"}>
                <label>
                  Bot Name
                  <input
                    name={name}
                    value={bot.name}
                    maxLength={BOT_NAME_MAX_LENGTH}
                    onChange={(event) => {
                      onRename(i, event.target.value);
                    }}
                    {...invalid(name)}
                  />
                </label>
                <span>
                  {design?.name ?? bot.designId}, Revision {String(design?.latestRevision.number ?? "?")}, {String(design?.latestRevision.cost ?? 0)} points
                </span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${bot.name === "" ? "this Bot" : bot.name}`}
                  onClick={() => {
                    onRemove(bot.key);
                  }}
                >
                  Remove
                </button>
                {problem(name)}
                {problem(botField(i, "designId"))}
              </li>
            );
          })}
        </ol>
        <p className={["total", ...(over ? ["over"] : []), ...(problems.fields.bots === undefined ? [] : ["invalid"])].join(" ")} aria-live="polite">
          Total: {String(total)} of {String(game.pointBudget)} points{over ? `, ${String(total - game.pointBudget)} over the Point Budget` : ""}
        </p>
        {problem("bots")}
      </section>

      <button type="submit" disabled={busy}>
        {busy ? "Entering…" : "Submit Entry"}
      </button>
    </form>
  );
}
