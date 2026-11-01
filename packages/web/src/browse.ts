/**
 * The read-only browsers (frontend spec section 5): the Player's Garage,
 * Maps and the Parts Catalog. Loading Bot Designs and Maps with their
 * Revisions, the routes of the browser screens, and how parts and their
 * stats are shown.
 */

import type { ApiClient, Schema } from "./api/client.js";
import { botParts, type BotParts } from "./draw/bot.js";
import { getPartsCatalog, type PartsCatalog } from "./replays.js";

export type BotDesign = Schema<"BotDesign">;
export type BotDesignRevision = Schema<"BotDesignRevision">;
export type BotDesignRevisionSummary = Schema<"BotDesignRevisionSummary">;
export type BotDesignList = Schema<"BotDesignList">;
export type MapDetail = Schema<"Map">;
export type MapRevision = Schema<"MapRevision">;
export type MapRevisionSummary = Schema<"MapRevisionSummary">;
export type MapList = Schema<"MapList">;
export type Build = Schema<"Build">;
export type Chassis = Schema<"Chassis">;
export type Component = Schema<"Component">;
export type StatValue = Chassis["stats"][string];

export const GARAGE_ROUTE = "/garage";
export const MAPS_ROUTE = "/maps";
export const PARTS_ROUTE = "/parts";

/** How many Bot Designs or Maps a page of a list holds. */
export const BROWSE_PAGE_LIMIT = 25;

/** The route of a Bot Design in the Garage, at `revision` if not its latest. */
export function designRoute(id: string, revision?: number): string {
  return `${GARAGE_ROUTE}/${encodeURIComponent(id)}${revision === undefined ? "" : `?revision=${String(revision)}`}`;
}

/** The route of a Map, at `revision` if not its latest. */
export function mapRoute(id: string, revision?: number): string {
  return `${MAPS_ROUTE}/${encodeURIComponent(id)}${revision === undefined ? "" : `?revision=${String(revision)}`}`;
}

/** The route of a Ruleset's Parts Catalog. */
export function partsRoute(version: string): string {
  return `${PARTS_ROUTE}?${new URLSearchParams({ ruleset: version }).toString()}`;
}

/** The item a browser route names below `base` (`/garage/{id}` or `/maps/{id}`), if it names one. */
export function matchItemRoute(base: string, path: string): string | undefined {
  if (!path.startsWith(`${base}/`)) return undefined;
  const rest = path.slice(base.length + 1);
  if (rest === "" || rest.includes("/")) return undefined;
  try {
    return decodeURIComponent(rest);
  } catch {
    return undefined;
  }
}

/** The `revision` a route's query asks for: a whole number from 1, or `undefined` for the latest. */
export function revisionFromSearch(search: URLSearchParams): number | undefined {
  const text = search.get("revision");
  if (text === null || !/^[1-9]\d*$/.test(text)) return undefined;
  return Number(text);
}

/** The Garage's filters, as in its route's query (`?ruleset=r1&archived=1`). */
export interface GarageFilters {
  readonly rulesetVersion?: string;
  readonly includeArchived: boolean;
}

export function garageFiltersFromSearch(search: URLSearchParams): GarageFilters {
  const ruleset = search.get("ruleset");
  return { ...(ruleset === null || ruleset === "" ? {} : { rulesetVersion: ruleset }), includeArchived: search.get("archived") === "1" };
}

export function searchFromGarageFilters(filters: GarageFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.rulesetVersion !== undefined) search.set("ruleset", filters.rulesetVersion);
  if (filters.includeArchived) search.set("archived", "1");
  return search;
}

/** A page of the Player's Bot Designs, most recently changed first. */
export function listDesigns(api: ApiClient, filters: GarageFilters, cursor?: string): Promise<BotDesignList> {
  return api.request<BotDesignList>("GET", "/bot-designs", {
    query: { rulesetVersion: filters.rulesetVersion, includeArchived: filters.includeArchived ? true : undefined, limit: BROWSE_PAGE_LIMIT, cursor },
  });
}

/** A Bot Design and one Revision of it: its latest, or `revision` if asked for. */
export interface DesignAtRevision {
  readonly design: BotDesign;
  readonly revision: BotDesignRevision;
}

export async function getDesign(api: ApiClient, id: string, revision?: number): Promise<DesignAtRevision> {
  const path = `/bot-designs/${encodeURIComponent(id)}`;
  const design = await api.request<BotDesign>("GET", path);
  if (revision === undefined || revision === design.latestRevision.number) return { design, revision: design.latestRevision };
  return { design, revision: await api.request<BotDesignRevision>("GET", `${path}/revisions/${String(revision)}`) };
}

/** A page of a Bot Design's Revisions, newest first. */
export function listDesignRevisions(api: ApiClient, id: string, cursor?: string): Promise<Schema<"BotDesignRevisionList">> {
  return api.request<Schema<"BotDesignRevisionList">>("GET", `/bot-designs/${encodeURIComponent(id)}/revisions`, { query: { limit: BROWSE_PAGE_LIMIT, cursor } });
}

/** A page of Maps, most recently changed first; only `creator`'s if given. */
export function listMaps(api: ApiClient, creator: string | undefined, cursor?: string): Promise<MapList> {
  return api.request<MapList>("GET", "/maps", { query: { creator, limit: BROWSE_PAGE_LIMIT, cursor } });
}

export function getMap(api: ApiClient, id: string): Promise<MapDetail> {
  return api.request<MapDetail>("GET", `/maps/${encodeURIComponent(id)}`);
}

/** A Map and one Revision of it: its latest, or `revision` if asked for. */
export interface MapAtRevision {
  readonly map: MapDetail;
  readonly revision: MapRevision;
}

export async function getMapAt(api: ApiClient, id: string, revision?: number): Promise<MapAtRevision> {
  const map = await getMap(api, id);
  if (revision === undefined || revision === map.latestRevision.number) return { map, revision: map.latestRevision };
  return { map, revision: await api.request<MapRevision>("GET", `/maps/${encodeURIComponent(id)}/revisions/${String(revision)}`) };
}

/** A page of a Map's Revisions, newest first. */
export function listMapRevisions(api: ApiClient, id: string, cursor?: string): Promise<Schema<"MapRevisionList">> {
  return api.request<Schema<"MapRevisionList">>("GET", `/maps/${encodeURIComponent(id)}/revisions`, { query: { limit: BROWSE_PAGE_LIMIT, cursor } });
}

const catalogs = new WeakMap<ApiClient, Map<string, Promise<PartsCatalog>>>();

/**
 * A Ruleset's Parts Catalog, fetched once per client: a Ruleset version
 * never changes, so every Bot Design of it can share one. A failed fetch is
 * forgotten, so the next asks again.
 */
export function cachedPartsCatalog(api: ApiClient, version: string): Promise<PartsCatalog> {
  let byVersion = catalogs.get(api);
  if (byVersion === undefined) {
    byVersion = new Map();
    catalogs.set(api, byVersion);
  }
  const known = byVersion.get(version);
  if (known !== undefined) return known;
  const loading = getPartsCatalog(api, version);
  byVersion.set(version, loading);
  loading.catch(() => {
    byVersion.delete(version);
  });
  return loading;
}

/** A Build's parts for drawing, or `undefined` if the catalog lacks its Chassis. */
export function buildParts(catalog: PartsCatalog, build: Build): BotParts | undefined {
  return botParts(catalog, build);
}

/** A Chassis on its own, with every Slot empty, for drawing. */
export function bareChassisParts(catalog: PartsCatalog, chassis: Chassis): BotParts | undefined {
  return buildParts(catalog, { chassis: chassis.id, components: {}, armor: { front: null, left: null, right: null, rear: null } });
}

export const ARMOR_SIDES = ["front", "left", "right", "rear"] as const;

/** One row of a Build's parts: a Slot and what is installed there, or an Armor side. */
export interface BuildRow {
  readonly place: string;
  /** The part's name, or its id if the catalog lacks it; `undefined` when empty. */
  readonly part?: string;
  readonly cost: number;
}

/** A Build's parts in Chassis Slot order, then its Armor by side; with each part's cost from the catalog. */
export function buildRows(catalog: PartsCatalog, build: Build): readonly BuildRow[] {
  const chassis = catalog.chassis.find((c) => c.id === build.chassis);
  const components = new Map(catalog.components.map((c) => [c.id, c]));
  const row = (place: string, id: string | null | undefined): BuildRow => {
    if (id === null || id === undefined) return { place, cost: 0 };
    const component = components.get(id);
    return { place, part: component?.name ?? id, cost: component?.cost ?? 0 };
  };
  const slotIds = chassis?.slots.map((s) => s.id) ?? Object.keys(build.components);
  return [
    { place: "Chassis", part: chassis?.name ?? build.chassis, cost: chassis?.cost ?? 0 },
    ...slotIds.map((slot) => row(`Slot ${slot}`, build.components[slot])),
    ...ARMOR_SIDES.map((side) => row(`Armor, ${side}`, build.armor[side])),
  ];
}

/** A stat's value as text: numbers and names as they are, terrain modifiers as `terrain: speed ×s, accel ×a`. */
export function statText(value: StatValue): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  const terrains = Object.entries(value);
  if (terrains.length === 0) return "none";
  return terrains.map(([terrain, m]) => `${terrain}: speed ×${String(m.speed)}, accel ×${String(m.accel)}`).join("; ");
}

/** The catalog's Components grouped by kind, in the catalog's order of kinds, each group in catalog order. */
export function componentsByKind(catalog: PartsCatalog): readonly (readonly [string, readonly Component[]])[] {
  const kinds = [...Object.keys(catalog.componentKinds), ...catalog.components.map((c) => c.kind)];
  return [...new Set(kinds)].map((kind) => [kind, catalog.components.filter((c) => c.kind === kind)] as const).filter(([, list]) => list.length > 0);
}

/** Splits a name such as `pelletGun` or `ram_plate` into words for headings: `Pellet gun`, `Ram plate`. */
export function kindText(kind: string): string {
  const words = kind
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words === "" ? kind : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
