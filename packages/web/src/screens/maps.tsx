/**
 * The Maps browser (frontend spec section 5), read-only: every Map with a
 * preview, optionally only one creator's (`?creator=ada_bot`), and a Map's
 * page with a larger preview, its Spawn Zones and Terrain, and its
 * Revisions and their notes (`?revision=2` shows an earlier one).
 */

import { validateMap, type MapFormat1 } from "@positrontanks/ruleset-data";
import { useState, type SubmitEvent } from "react";
import { ApiError } from "../api/client.js";
import { getMap, getMapAt, listMapRevisions, listMaps, mapRoute, revisionFromSearch, MAPS_ROUTE, type MapDetail, type MapRevision } from "../browse.js";
import { MapPreview } from "../draw/preview.js";
import { localTime, problemText, type MapSummary } from "../games.js";
import { Link, useLoad, usePages, useRoute, useServices, type Pages } from "../hooks.js";
import { MoreButton } from "./garage.js";

/** The route of the Maps list, only `creator`'s Maps if given. */
function mapsRoute(creator: string): string {
  return creator === "" ? MAPS_ROUTE : `${MAPS_ROUTE}?${new URLSearchParams({ creator }).toString()}`;
}

export function MapsScreen() {
  const { api } = useServices();
  const route = useRoute();
  const creator = route.search.get("creator")?.trim() ?? "";
  const pages = usePages(async (cursor) => {
    const list = await listMaps(api, creator === "" ? undefined : creator, cursor);
    return { items: list.maps, nextCursor: list.nextCursor };
  }, creator);
  return (
    <>
      <h2>Maps</h2>
      <p>
        Every Map a Game can be played on. Create and change your own with the CLI: <code>positrontanks maps</code>
      </p>
      <CreatorFilterForm key={creator} creator={creator} />
      <MapCards pages={pages} />
    </>
  );
}

function CreatorFilterForm({ creator }: { readonly creator: string }) {
  const { router } = useServices();
  const [value, setValue] = useState(creator);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    router.navigate(mapsRoute(value.trim()), { replace: true });
  };
  return (
    <form className="filters" onSubmit={submit}>
      <label>
        Creator
        <input
          value={value}
          placeholder="Any"
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </label>
      <button type="submit">Filter</button>
    </form>
  );
}

/** The Maps so far as cards with previews, and "Load more" while the server has more. */
export function MapCards({ pages }: { readonly pages: Pages<MapSummary> }) {
  if (pages.status === "loading" && pages.items.length === 0) return <p>Loading…</p>;
  return (
    <>
      {pages.items.length === 0 && pages.status === "loaded" ? (
        <p>No Maps here.</p>
      ) : (
        <ul className="cards">
          {pages.items.map((map) => (
            <li key={map.id}>
              <MapDrawing id={map.id} name={map.name} />
              <h3>
                <Link to={mapRoute(map.id)}>{map.name}</Link>
              </h3>
              <p>
                {sizeText(map.latestRevision)}, {String(map.latestRevision.spawnZones)} Spawn Zones · by {map.creator.username}
              </p>
              {map.description === "" ? null : <p className="muted">{map.description}</p>}
            </li>
          ))}
        </ul>
      )}
      <MoreButton pages={pages} />
    </>
  );
}

const sizeText = (map: { readonly width: number; readonly height: number }) => `${String(map.width)} × ${String(map.height)} m`;

/** A Map's latest Revision, drawn: the list has only summaries, so each card loads its Map. */
function MapDrawing({ id, name }: { readonly id: string; readonly name: string }) {
  const { api } = useServices();
  const loaded = useLoad(() => getMap(api, id), id);
  if (loaded.status !== "loaded") return <div className="drawing-placeholder" aria-hidden="true" />;
  return <CheckedMapPreview map={loaded.value.latestRevision.map} size={160} label={`${name} preview`} />;
}

/** A preview of `map`, or a note if the client cannot read it (a Map Format it does not know). */
function CheckedMapPreview({ map, size, label }: { readonly map: unknown; readonly size: number; readonly label: string }) {
  const checked = validateMap(map);
  if (!checked.ok) return <p className="muted">No preview: this client cannot read the Map.</p>;
  return <MapPreview map={checked.map} size={size} label={label} />;
}

export function MapScreen({ id }: { readonly id: string }) {
  const { api } = useServices();
  const route = useRoute();
  const revisionNumber = revisionFromSearch(route.search);
  const loaded = useLoad(() => getMapAt(api, id, revisionNumber), `${id} ${String(revisionNumber)}`);
  const back = (
    <p>
      <Link to={MAPS_ROUTE}>Back to Maps</Link>
    </p>
  );
  if (loaded.status === "loading") return <p>Loading…</p>;
  if (loaded.status === "failed") {
    const missing = loaded.error instanceof ApiError && loaded.error.status === 404;
    return (
      <>
        <h2>Map</h2>
        <p className="error" role="alert">
          {missing ? (revisionNumber === undefined ? `There is no Map ${id}.` : `Map ${id} has no Revision ${String(revisionNumber)}.`) : problemText(loaded.error)}
        </p>
        {back}
      </>
    );
  }
  return (
    <>
      <MapView map={loaded.value.map} revision={loaded.value.revision} />
      <MapRevisions map={loaded.value.map} shown={loaded.value.revision.number} />
      {back}
    </>
  );
}

export interface MapViewProps {
  readonly map: MapDetail;
  /** The Revision shown: the latest, or an earlier one. */
  readonly revision: MapRevision;
}

export function MapView({ map, revision }: MapViewProps) {
  const latest = revision.number === map.latestRevision.number;
  const checked = validateMap(revision.map);
  const format: MapFormat1 | undefined = checked.ok ? checked.map : undefined;
  return (
    <article className="item map">
      <h2>{map.name}</h2>
      <div className="item-summary">
        <CheckedMapPreview map={revision.map} size={360} label={`${map.name} preview`} />
        <dl>
          <dt>Creator</dt>
          <dd>
            <Link to={mapsRoute(map.creator.username)}>{map.creator.username}</Link>
          </dd>
          <dt>Revision</dt>
          <dd>
            {String(revision.number)}
            {latest ? ", the latest" : `, of ${String(map.latestRevision.number)}`}
          </dd>
          <dt>Size</dt>
          <dd>{sizeText(revision.map)}</dd>
          <dt>Spawn Zones</dt>
          <dd>{String(revision.map.spawnZones.length)}, so up to that many Players</dd>
          {format === undefined ? null : (
            <>
              <dt>Obstacles</dt>
              <dd>{obstaclesText(format)}</dd>
              <dt>Terrain</dt>
              <dd>{terrainText(format)}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{localTime(revision.createdAt)}</dd>
          {map.archivedAt === null ? null : (
            <>
              <dt>Archived</dt>
              <dd>{localTime(map.archivedAt)}</dd>
            </>
          )}
        </dl>
      </div>
      {map.description === "" ? null : <p>{map.description}</p>}
      {revision.notes === "" ? null : (
        <p>
          <strong>Revision notes:</strong> {revision.notes}
        </p>
      )}
    </article>
  );
}

/** How many Obstacles a Map has, and how many of them are destructible. */
export function obstaclesText(map: MapFormat1): string {
  const destructible = map.obstacles.filter((o) => o.destructible).length;
  if (map.obstacles.length === 0) return "none";
  return destructible === 0 ? String(map.obstacles.length) : `${String(map.obstacles.length)}, ${String(destructible)} destructible`;
}

/** The Map's Terrain names, its base Terrain first. */
export function terrainText(map: MapFormat1): string {
  const unique = [...new Set([map.baseTerrain, ...map.terrainRegions.map((t) => t.terrain)])];
  return unique.length === 1 ? `${map.baseTerrain} everywhere` : `${map.baseTerrain}, with ${unique.slice(1).join(", ")}`;
}

/** The Map's Revisions with their notes, each linking to it; `shown` is marked. */
function MapRevisions({ map, shown }: { readonly map: MapDetail; readonly shown: number }) {
  const { api } = useServices();
  const pages = usePages(async (cursor) => {
    const list = await listMapRevisions(api, map.id, cursor);
    return { items: list.revisions, nextCursor: list.nextCursor };
  }, map.id);
  const latest = map.latestRevision.number;
  return (
    <section aria-labelledby="revisions-heading">
      <h3 id="revisions-heading">Revisions</h3>
      {pages.items.length === 0 && pages.status === "loading" ? (
        <p>Loading…</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Revision</th>
              <th>Size</th>
              <th>Spawn Zones</th>
              <th>Created</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {pages.items.map((r) => (
              <tr key={r.number} {...(r.number === shown ? { "aria-current": "true", className: "current" } : {})}>
                <td>{r.number === shown ? String(r.number) : <Link to={mapRoute(map.id, r.number === latest ? undefined : r.number)}>{String(r.number)}</Link>}</td>
                <td>{sizeText(r)}</td>
                <td>{String(r.spawnZones)}</td>
                <td>{localTime(r.createdAt)}</td>
                <td>{r.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <MoreButton pages={pages} />
    </section>
  );
}
