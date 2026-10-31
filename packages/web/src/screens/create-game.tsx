/**
 * The Create Game screen (frontend spec section 5): a Map picker with a
 * preview, player count, Point Budget, time limit, Pace and fill timeout.
 * The form starts from the CLI's defaults; problems the API reports against
 * a field are shown by it, and creating the Game goes to its page.
 */

import { validateMap, type MapFormat1 } from "@positrontanks/ruleset-data";
import { useState, type SubmitEvent } from "react";
import type { Schema } from "../api/client.js";
import { MapPreview } from "../draw/preview.js";
import { useLoad, useServices } from "../hooks.js";
import {
  createGame,
  formProblems,
  newGameFields,
  newGameFromFields,
  playableMaps,
  problemText,
  type FormProblems,
  type MapSummary,
  type NewGameField,
  type NewGameFields,
  type RulesetSummary,
} from "../games.js";
import { gameRoute } from "./game.js";

export const CREATE_GAME_ROUTE = "/games/new";

const FIELDS: readonly NewGameField[] = ["rulesetVersion", "mapId", "playerCount", "pointBudget", "timeLimitSeconds", "pace", "fillTimeoutSeconds"];

export function CreateGameScreen() {
  const { api } = useServices();
  const rulesets = useLoad(() => api.request<Schema<"RulesetList">>("GET", "/rulesets"), "rulesets");
  const maps = useLoad(() => api.request<Schema<"MapList">>("GET", "/maps", { query: { limit: 200 } }), "maps");
  const failed = rulesets.status === "failed" ? rulesets.error : maps.status === "failed" ? maps.error : undefined;

  return (
    <>
      <h2>Create Game</h2>
      {failed !== undefined ? (
        <p className="error" role="alert">
          {problemText(failed)}
        </p>
      ) : rulesets.status !== "loaded" || maps.status !== "loaded" ? (
        <p>Loading…</p>
      ) : (
        <CreateGameForm rulesets={rulesets.value.rulesets} maps={maps.value.maps} />
      )}
    </>
  );
}

function CreateGameForm({ rulesets, maps }: { readonly rulesets: readonly RulesetSummary[]; readonly maps: readonly MapSummary[] }) {
  const { api, router } = useServices();
  const [values, setValues] = useState(() => newGameFields(rulesets, maps));
  const [problems, setProblems] = useState<FormProblems<NewGameField>>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const mapId = values.mapId;
  const map = useLoad(async () => (mapId === "" ? undefined : api.request<Schema<"Map">>("GET", `/maps/${encodeURIComponent(mapId)}`)), mapId);
  const loadedMap = map.status === "loaded" ? map.value : undefined;
  const checked = loadedMap === undefined ? undefined : validateMap(loadedMap.latestRevision.map);

  const onChange = (name: NewGameField, value: string) => {
    // A problem shown by a field goes once the field is changed.
    setProblems((p) => (p.fields[name] === undefined ? p : { ...p, fields: { ...p.fields, [name]: undefined } }));
    setValues((v) => {
      if (name !== "rulesetVersion") return { ...v, [name]: value };
      // A new Ruleset brings its own Point Budget range and the Maps it can play on.
      const ruleset = rulesets.find((r) => r.version === value);
      const playable = playableMaps(maps, ruleset);
      return {
        ...v,
        rulesetVersion: value,
        pointBudget: ruleset === undefined ? v.pointBudget : String(ruleset.pointBudget.max),
        mapId: playable.some((m) => m.id === v.mapId) ? v.mapId : (playable[0]?.id ?? ""),
      };
    });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const checkedGame = newGameFromFields(values);
    if ("problems" in checkedGame) {
      setProblems(checkedGame.problems);
      return;
    }
    setBusy(true);
    setProblems({ fields: {} });
    createGame(api, checkedGame.game).then(
      (game) => {
        router.navigate(gameRoute(game.id));
      },
      (error: unknown) => {
        setProblems(formProblems(error, FIELDS, { mapRevision: "mapId" }));
        setBusy(false);
      },
    );
  };

  return (
    <CreateGameView
      rulesets={rulesets}
      maps={maps}
      values={values}
      problems={problems}
      busy={busy}
      {...(checked?.ok === true ? { preview: checked.map } : {})}
      {...(loadedMap === undefined ? {} : { mapDescription: loadedMap.description })}
      onChange={onChange}
      onSubmit={submit}
    />
  );
}

export interface CreateGameViewProps {
  readonly rulesets: readonly RulesetSummary[];
  readonly maps: readonly MapSummary[];
  readonly values: NewGameFields;
  readonly problems: FormProblems<NewGameField>;
  /** True while the Game is being created. */
  readonly busy: boolean;
  /** The chosen Map's latest Revision, once loaded. */
  readonly preview?: MapFormat1;
  readonly mapDescription?: string;
  readonly onChange: (name: NewGameField, value: string) => void;
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
}

export function CreateGameView({ rulesets, maps, values, problems, busy, preview, mapDescription, onChange, onSubmit }: CreateGameViewProps) {
  const ruleset = rulesets.find((r) => r.version === values.rulesetVersion);
  const playable = playableMaps(maps, ruleset);
  const map = maps.find((m) => m.id === values.mapId);
  const set = (name: NewGameField) => (event: { readonly target: { readonly value: string } }) => {
    onChange(name, event.target.value);
  };
  const problem = (name: NewGameField) => {
    const text = problems.fields[name];
    return text === undefined ? null : (
      <p className="error" id={`${name}-problem`}>
        {text}
      </p>
    );
  };
  const invalid = (name: NewGameField) =>
    problems.fields[name] === undefined ? {} : { "aria-invalid": true, "aria-describedby": `${name}-problem` };

  return (
    <form className="create-game" onSubmit={onSubmit} noValidate>
      {problems.form === undefined ? null : (
        <p className="error" role="alert">
          {problems.form}
        </p>
      )}
      <div className="fields">
        <label>
          Ruleset
          <select name="rulesetVersion" value={values.rulesetVersion} onChange={set("rulesetVersion")} {...invalid("rulesetVersion")}>
            {rulesets.map((r) => (
              <option key={r.version} value={r.version}>
                {r.version}
              </option>
            ))}
          </select>
        </label>
        {problem("rulesetVersion")}

        <label>
          Map
          <select name="mapId" value={values.mapId} onChange={set("mapId")} {...invalid("mapId")}>
            {playable.length === 0 ? <option value="">No Maps for this Ruleset</option> : null}
            {playable.map((m) => (
              <option key={m.id} value={m.id}>
                {`${m.name} (up to ${String(m.latestRevision.spawnZones)} Players)`}
              </option>
            ))}
          </select>
        </label>
        {problem("mapId")}

        <label>
          Players
          <input
            name="playerCount"
            type="number"
            inputMode="numeric"
            min={2}
            {...(map === undefined ? {} : { max: map.latestRevision.spawnZones })}
            value={values.playerCount}
            onChange={set("playerCount")}
            {...invalid("playerCount")}
          />
        </label>
        {problem("playerCount")}

        <label>
          Point Budget
          <input
            name="pointBudget"
            type="number"
            inputMode="numeric"
            {...(ruleset === undefined ? {} : { min: ruleset.pointBudget.min, max: ruleset.pointBudget.max })}
            value={values.pointBudget}
            onChange={set("pointBudget")}
            {...invalid("pointBudget")}
          />
          {ruleset === undefined ? null : (
            <small>
              {String(ruleset.pointBudget.min)} to {String(ruleset.pointBudget.max)} in {ruleset.version}
            </small>
          )}
        </label>
        {problem("pointBudget")}

        <label>
          Time limit (simulated seconds)
          <input
            name="timeLimitSeconds"
            type="number"
            inputMode="numeric"
            min={1}
            value={values.timeLimitSeconds}
            onChange={set("timeLimitSeconds")}
            {...invalid("timeLimitSeconds")}
          />
        </label>
        {problem("timeLimitSeconds")}

        <fieldset {...invalid("pace")}>
          <legend>Pace</legend>
          <label>
            <input type="radio" name="pace" value="realtime" checked={values.pace === "realtime"} onChange={set("pace")} />
            Real time: Spectators can watch it live
          </label>
          <label>
            <input type="radio" name="pace" value="unthrottled" checked={values.pace === "unthrottled"} onChange={set("pace")} />
            Unthrottled: played as fast as the server can, then watched as a Replay
          </label>
        </fieldset>
        {problem("pace")}

        <label>
          Fill timeout (seconds)
          <input
            name="fillTimeoutSeconds"
            type="number"
            inputMode="numeric"
            min={1}
            value={values.fillTimeoutSeconds}
            onChange={set("fillTimeoutSeconds")}
            {...invalid("fillTimeoutSeconds")}
          />
          <small>The Game is cancelled if it is not full by then.</small>
        </label>
        {problem("fillTimeoutSeconds")}

        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create Game"}
        </button>
      </div>

      <aside className="map-preview">
        {map === undefined ? null : (
          <>
            {preview === undefined ? <p>Loading the Map…</p> : <MapPreview map={preview} size={280} label={`${map.name} preview`} />}
            <p>
              <strong>{map.name}</strong> by {map.creator.username}, Revision {String(map.latestRevision.number)}: {String(map.latestRevision.width)} x{" "}
              {String(map.latestRevision.height)} m, {String(map.latestRevision.spawnZones)} Spawn Zones.
            </p>
            {mapDescription === undefined || mapDescription === "" ? null : <p>{mapDescription}</p>}
          </>
        )}
      </aside>
    </form>
  );
}
