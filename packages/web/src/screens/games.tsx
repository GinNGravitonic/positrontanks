/**
 * The Games screen (frontend spec section 5): Open Games to browse, with the
 * API's filters, and My Games by state. The tab and filters live in the
 * route's query (`?tab=mine&state=open,running`), so a filtered list can be
 * bookmarked and reloaded.
 */

import { useState, type SubmitEvent } from "react";
import type { Schema } from "../api/client.js";
import { Link, useLoad, usePages, useRoute, useServices } from "../hooks.js";
import {
  browseGames,
  filtersFromSearch,
  GAME_STATES,
  localTime,
  myGames,
  outcomeText,
  PACE_TEXT,
  problemText,
  searchFromFilters,
  STATE_TEXT,
  statesFromSearch,
  type BrowseFilters,
  type GameState,
  type GameSummary,
} from "../games.js";

/** The route for a tab of the Games screen with `search` as its query. */
function gamesRoute(search: URLSearchParams): string {
  const text = search.toString();
  return text === "" ? "/" : `/?${text}`;
}

export function GamesScreen() {
  const route = useRoute();
  const mine = route.search.get("tab") === "mine";
  return (
    <>
      <h2>Games</h2>
      <nav className="tabs" aria-label="Games">
        <Link to="/" className={mine ? undefined : "current"}>
          Open Games
        </Link>
        <Link to="/?tab=mine" className={mine ? "current" : undefined}>
          My Games
        </Link>
      </nav>
      {mine ? <MyGames states={statesFromSearch(route.search)} /> : <BrowseGames filters={filtersFromSearch(route.search)} />}
    </>
  );
}

function BrowseGames({ filters }: { readonly filters: BrowseFilters }) {
  const { api } = useServices();
  const key = searchFromFilters(filters).toString();
  const pages = usePages(async (cursor) => {
    const list = await browseGames(api, filters, cursor);
    return { items: list.games, nextCursor: list.nextCursor };
  }, key);
  return (
    <>
      <BrowseFilterForm key={key} filters={filters} />
      <GameTable pages={pages} empty="No Open Games match. Try fewer filters, or create one." showState={false} />
    </>
  );
}

const field = (value: string | number | undefined) => (value === undefined ? "" : String(value));

/** The browse filters; applying them changes the route, which reloads the list. */
function BrowseFilterForm({ filters }: { readonly filters: BrowseFilters }) {
  const { api, router } = useServices();
  const rulesets = useLoad(() => api.request<Schema<"RulesetList">>("GET", "/rulesets"), "rulesets");
  const maps = useLoad(() => api.request<Schema<"MapList">>("GET", "/maps", { query: { limit: 200 } }), "maps");
  const [values, setValues] = useState({
    ruleset: field(filters.rulesetVersion),
    map: field(filters.mapId),
    players: field(filters.playerCount),
    minBudget: field(filters.minPointBudget),
    maxBudget: field(filters.maxPointBudget),
  });
  const set = (name: keyof typeof values) => (event: { readonly target: { readonly value: string } }) => {
    setValues((v) => ({ ...v, [name]: event.target.value }));
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    router.navigate(gamesRoute(searchFromFilters(filtersFromSearch(new URLSearchParams(values)))), { replace: true });
  };

  return (
    <form className="filters" onSubmit={submit}>
      <label>
        Ruleset
        <select value={values.ruleset} onChange={set("ruleset")}>
          <option value="">Any</option>
          {rulesets.status === "loaded"
            ? rulesets.value.rulesets.map((r) => (
                <option key={r.version} value={r.version}>
                  {r.version}
                </option>
              ))
            : null}
        </select>
      </label>
      <label>
        Map
        <select value={values.map} onChange={set("map")}>
          <option value="">Any</option>
          {maps.status === "loaded"
            ? maps.value.maps.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))
            : null}
          {values.map !== "" && maps.status === "loaded" && !maps.value.maps.some((m) => m.id === values.map) ? (
            <option value={values.map}>{values.map}</option>
          ) : null}
        </select>
      </label>
      <label>
        Players
        <input type="number" min={2} inputMode="numeric" value={values.players} onChange={set("players")} />
      </label>
      <label>
        Point Budget from
        <input type="number" min={0} inputMode="numeric" value={values.minBudget} onChange={set("minBudget")} />
      </label>
      <label>
        to
        <input type="number" min={0} inputMode="numeric" value={values.maxBudget} onChange={set("maxBudget")} />
      </label>
      <button type="submit">Filter</button>
    </form>
  );
}

function MyGames({ states }: { readonly states: readonly GameState[] }) {
  const { api, router } = useServices();
  const key = states.join(",");
  const pages = usePages(async (cursor) => {
    const list = await myGames(api, states, cursor);
    return { items: list.games, nextCursor: list.nextCursor };
  }, key);

  const toggle = (state: GameState) => {
    const next = states.includes(state) ? states.filter((s) => s !== state) : GAME_STATES.filter((s) => s === state || states.includes(s));
    const search = new URLSearchParams({ tab: "mine" });
    if (next.length > 0) search.set("state", next.join(","));
    router.navigate(gamesRoute(search), { replace: true });
  };

  return (
    <>
      <fieldset className="filters">
        <legend>States</legend>
        {GAME_STATES.map((state) => (
          <label key={state}>
            <input
              type="checkbox"
              checked={states.includes(state)}
              onChange={() => {
                toggle(state);
              }}
            />
            {STATE_TEXT[state]}
          </label>
        ))}
      </fieldset>
      <GameTable pages={pages} empty="You have not initiated or entered any Games like these." showState />
    </>
  );
}

/** A page of Games, newest first, each linking to its Game page, with "Load more" while the server has more. */
export function GameTable({
  pages,
  empty,
  showState,
}: {
  readonly pages: { readonly items: readonly GameSummary[]; readonly status: string; readonly error?: unknown; readonly more: boolean; readonly loadMore: () => void };
  readonly empty: string;
  readonly showState: boolean;
}) {
  if (pages.status === "loading" && pages.items.length === 0) return <p>Loading…</p>;
  return (
    <>
      {pages.items.length === 0 && pages.status === "loaded" ? (
        <p>{empty}</p>
      ) : pages.items.length === 0 ? null : (
        <table className="games">
          <thead>
            <tr>
              <th>Map</th>
              {showState ? <th>State</th> : null}
              <th>Ruleset</th>
              <th>Entries</th>
              <th>Point Budget</th>
              <th>Time limit</th>
              <th>Initiator</th>
              <th>{showState ? "Outcome" : "Fills by"}</th>
            </tr>
          </thead>
          <tbody>
            {pages.items.map((game) => (
              <tr key={game.id}>
                <td>
                  <Link to={`/games/${encodeURIComponent(game.id)}`}>{game.map.name}</Link>
                </td>
                {showState ? <td>{STATE_TEXT[game.state]}</td> : null}
                <td>{game.rulesetVersion}</td>
                <td>
                  {String(game.entryCount)}/{String(game.playerCount)}
                </td>
                <td>{String(game.pointBudget)}</td>
                <td>
                  {String(game.timeLimitSeconds)} s, {PACE_TEXT[game.pace]}
                </td>
                <td>{game.initiator.username}</td>
                <td>{showState ? outcomeText(game) : localTime(game.fillDeadline)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pages.status === "failed" ? (
        <p className="error" role="alert">
          {problemText(pages.error)}
        </p>
      ) : null}
      {pages.more ? (
        <button type="button" disabled={pages.status === "loading"} onClick={pages.loadMore}>
          {pages.status === "loading" ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </>
  );
}
