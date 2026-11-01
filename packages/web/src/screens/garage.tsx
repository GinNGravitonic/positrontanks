/**
 * The Garage (frontend spec section 5), read-only: the Player's Bot Designs,
 * each Build drawn with its cost, and a design's page with its parts, its
 * Revisions and their notes, and its Program. Authoring stays with the CLI.
 * The filters live in the route's query (`?ruleset=r1&archived=1`), and a
 * design's page can show an earlier Revision (`?revision=2`).
 */

import { useState, type SubmitEvent } from "react";
import { ApiError, type Schema } from "../api/client.js";
import {
  buildParts,
  buildRows,
  cachedPartsCatalog,
  designRoute,
  garageFiltersFromSearch,
  getDesign,
  listDesignRevisions,
  listDesigns,
  partsRoute,
  revisionFromSearch,
  searchFromGarageFilters,
  GARAGE_ROUTE,
  type BotDesign,
  type BotDesignRevision,
  type Build,
  type GarageFilters,
} from "../browse.js";
import { BotPreview } from "../draw/preview.js";
import type { BotDesignSummary } from "../entries.js";
import { localTime, problemText } from "../games.js";
import { Link, useLoad, usePages, useRoute, useServices, type Pages } from "../hooks.js";
import type { PartsCatalog } from "../replays.js";

export function GarageScreen() {
  const route = useRoute();
  const filters = garageFiltersFromSearch(route.search);
  const key = searchFromGarageFilters(filters).toString();
  const { api } = useServices();
  const pages = usePages(async (cursor) => {
    const list = await listDesigns(api, filters, cursor);
    return { items: list.botDesigns, nextCursor: list.nextCursor };
  }, key);
  return (
    <>
      <h2>Garage</h2>
      <p>Your Bot Designs. Create and change them with the CLI: <code>positrontanks designs</code></p>
      <GarageFilterForm key={key} filters={filters} />
      <DesignCards pages={pages} />
    </>
  );
}

function GarageFilterForm({ filters }: { readonly filters: GarageFilters }) {
  const { api, router } = useServices();
  const rulesets = useLoad(() => api.request<Schema<"RulesetList">>("GET", "/rulesets"), "rulesets");
  const [ruleset, setRuleset] = useState(filters.rulesetVersion ?? "");
  const [archived, setArchived] = useState(filters.includeArchived);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const search = searchFromGarageFilters({ ...(ruleset === "" ? {} : { rulesetVersion: ruleset }), includeArchived: archived }).toString();
    router.navigate(search === "" ? GARAGE_ROUTE : `${GARAGE_ROUTE}?${search}`, { replace: true });
  };
  return (
    <form className="filters" onSubmit={submit}>
      <label>
        Ruleset
        <select
          value={ruleset}
          onChange={(event) => {
            setRuleset(event.target.value);
          }}
        >
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
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => {
            setArchived(event.target.checked);
          }}
        />
        Include archived
      </label>
      <button type="submit">Filter</button>
    </form>
  );
}

/** The designs so far as cards, each with its Build drawn, and "Load more" while the server has more. */
export function DesignCards({ pages }: { readonly pages: Pages<BotDesignSummary> }) {
  if (pages.status === "loading" && pages.items.length === 0) return <p>Loading…</p>;
  return (
    <>
      {pages.items.length === 0 && pages.status === "loaded" ? (
        <p>
          No Bot Designs here. Make one with the CLI: <code>positrontanks designs create</code>
        </p>
      ) : (
        <ul className="cards">
          {pages.items.map((design) => (
            <li key={design.id}>
              <DesignDrawing id={design.id} rulesetVersion={design.rulesetVersion} name={design.name} />
              <h3>
                <Link to={designRoute(design.id)}>{design.name}</Link>
              </h3>
              <p>
                Ruleset {design.rulesetVersion}, Revision {String(design.latestRevision.number)}, {String(design.latestRevision.cost)} points
                {design.archivedAt === null ? null : <> · Archived</>}
              </p>
              <p className="muted">Changed {localTime(design.updatedAt)}</p>
            </li>
          ))}
        </ul>
      )}
      <MoreButton pages={pages} />
    </>
  );
}

/** "Load more" for a paged list while the server has more, and the problem if a page failed. */
export function MoreButton({ pages }: { readonly pages: Pick<Pages<unknown>, "status" | "error" | "more" | "loadMore"> }) {
  return (
    <>
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

/** A design's latest Build, drawn: the list has only summaries, so each card loads its design and its Ruleset's Parts Catalog. */
function DesignDrawing({ id, rulesetVersion, name }: { readonly id: string; readonly rulesetVersion: string; readonly name: string }) {
  const { api } = useServices();
  const loaded = useLoad(async () => {
    const [{ design }, catalog] = await Promise.all([getDesign(api, id), cachedPartsCatalog(api, rulesetVersion)]);
    return { build: design.latestRevision.build, catalog };
  }, `${id} ${rulesetVersion}`);
  if (loaded.status !== "loaded") return <div className="drawing-placeholder" aria-hidden="true" />;
  return <BuildDrawing build={loaded.value.build} catalog={loaded.value.catalog} label={`${name}'s Build`} />;
}

function BuildDrawing({ build, catalog, label, size = 120 }: { readonly build: Build; readonly catalog: PartsCatalog; readonly label: string; readonly size?: number }) {
  const parts = buildParts(catalog, build);
  if (parts === undefined) return <p className="muted">{`No drawing: Ruleset ${catalog.version} has no Chassis ${build.chassis}.`}</p>;
  return <BotPreview parts={parts} size={size} label={label} />;
}

export function DesignScreen({ id }: { readonly id: string }) {
  const { api } = useServices();
  const route = useRoute();
  const revisionNumber = revisionFromSearch(route.search);
  const loaded = useLoad(async () => {
    const at = await getDesign(api, id, revisionNumber);
    return { ...at, catalog: await cachedPartsCatalog(api, at.design.rulesetVersion) };
  }, `${id} ${String(revisionNumber)}`);
  const back = (
    <p>
      <Link to={GARAGE_ROUTE}>Back to the Garage</Link>
    </p>
  );
  if (loaded.status === "loading") return <p>Loading…</p>;
  if (loaded.status === "failed") {
    const missing = loaded.error instanceof ApiError && loaded.error.status === 404;
    return (
      <>
        <h2>Bot Design</h2>
        <p className="error" role="alert">
          {missing ? (revisionNumber === undefined ? `You have no Bot Design ${id}.` : `Bot Design ${id} has no Revision ${String(revisionNumber)}.`) : problemText(loaded.error)}
        </p>
        {back}
      </>
    );
  }
  return (
    <>
      <DesignView design={loaded.value.design} revision={loaded.value.revision} catalog={loaded.value.catalog} />
      <DesignRevisions design={loaded.value.design} shown={loaded.value.revision.number} />
      {back}
    </>
  );
}

export interface DesignViewProps {
  readonly design: BotDesign;
  /** The Revision shown: the latest, or an earlier one. */
  readonly revision: BotDesignRevision;
  readonly catalog: PartsCatalog;
}

export function DesignView({ design, revision, catalog }: DesignViewProps) {
  const latest = revision.number === design.latestRevision.number;
  return (
    <article className="item design">
      <h2>{design.name}</h2>
      <div className="item-summary">
        <BuildDrawing build={revision.build} catalog={catalog} label={`${design.name}'s Build`} size={200} />
        <dl>
          <dt>Ruleset</dt>
          <dd>
            <Link to={partsRoute(design.rulesetVersion)}>{design.rulesetVersion}</Link>
          </dd>
          <dt>Revision</dt>
          <dd>
            {String(revision.number)}
            {latest ? ", the latest" : `, of ${String(design.latestRevision.number)}`}
          </dd>
          <dt>Cost</dt>
          <dd>{String(revision.cost)} points</dd>
          <dt>Created</dt>
          <dd>{localTime(revision.createdAt)}</dd>
          {design.copiedFrom === null ? null : (
            <>
              <dt>Copied from</dt>
              <dd>
                <Link to={designRoute(design.copiedFrom.designId, design.copiedFrom.revision)}>
                  {design.copiedFrom.designId}, Revision {String(design.copiedFrom.revision)}
                </Link>
              </dd>
            </>
          )}
          {design.archivedAt === null ? null : (
            <>
              <dt>Archived</dt>
              <dd>{localTime(design.archivedAt)}</dd>
            </>
          )}
        </dl>
      </div>
      {design.description === "" ? null : <p>{design.description}</p>}
      {revision.notes === "" ? null : (
        <p>
          <strong>Revision notes:</strong> {revision.notes}
        </p>
      )}

      <h3>Build</h3>
      <table className="list">
        <thead>
          <tr>
            <th>Where</th>
            <th>Part</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {buildRows(catalog, revision.build).map((row) => (
            <tr key={row.place}>
              <td>{row.place}</td>
              <td>{row.part ?? <span className="muted">empty</span>}</td>
              <td>{row.part === undefined ? "" : String(row.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Program</h3>
      {revision.program === "" ? <p className="muted">No Program.</p> : <pre className="program">{revision.program}</pre>}
    </article>
  );
}

/** The design's Revisions with their costs and notes, each linking to it; `shown` is marked. */
function DesignRevisions({ design, shown }: { readonly design: BotDesign; readonly shown: number }) {
  const { api } = useServices();
  const pages = usePages(async (cursor) => {
    const list = await listDesignRevisions(api, design.id, cursor);
    return { items: list.revisions, nextCursor: list.nextCursor };
  }, design.id);
  const latest = design.latestRevision.number;
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
              <th>Cost</th>
              <th>Created</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {pages.items.map((r) => (
              <tr key={r.number} {...(r.number === shown ? { "aria-current": "true", className: "current" } : {})}>
                <td>
                  {r.number === shown ? String(r.number) : <Link to={designRoute(design.id, r.number === latest ? undefined : r.number)}>{String(r.number)}</Link>}
                </td>
                <td>{String(r.cost)}</td>
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
