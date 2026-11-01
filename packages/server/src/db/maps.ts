/**
 * Queries for Maps and their Revisions.
 *
 * Maps are public: anyone may read any Map, archived or not, so reads take
 * no Player. Changes (new Revisions, renaming, archiving) are scoped to the creator
 * and report whether the Map exists but belongs to someone else, since a
 * Map's existence is no secret. Revisions are only ever inserted, notes
 * included (public, like the rest of the Map); the schema
 * refuses updates to them. Map content is stored as JSON text and handed
 * back parsed; callers validate before saving.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MapFormat1 } from "@positrontanks/ruleset-data";
import { usernameKey, type PlayerRef } from "./accounts.js";
import { FIRST_PAGE, queryPage, type Page, type PageRequest } from "./paging.js";

export interface MapRevisionRecord {
  readonly mapId: string;
  /** 1 for the first Revision, then one more for each edit. */
  readonly number: number;
  readonly map: MapFormat1;
  /** What changed, public like the rest of the Map; empty if none. */
  readonly notes: string;
  readonly createdAt: string;
}

/** A Map Revision without its content, for listings. */
export interface MapRevisionSummary {
  readonly number: number;
  readonly format: number;
  readonly width: number;
  readonly height: number;
  /** How many Spawn Zones, and so at most how many Players, the Revision has. */
  readonly spawnZones: number;
  readonly notes: string;
  readonly createdAt: string;
}

export interface MapRecord {
  readonly id: string;
  readonly creator: PlayerRef;
  readonly name: string;
  /** Free text, public like the rest of the Map; empty if none. */
  readonly description: string;
  readonly latestRevision: MapRevisionSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface NewMap {
  readonly id: string;
  readonly playerId: string;
  readonly name: string;
  /** Defaults to empty. */
  readonly description?: string;
}

/** What an update changes; fields left out are kept. */
export interface MapChanges {
  readonly name?: string;
  readonly description?: string;
}

export interface MapListOptions {
  readonly includeArchived?: boolean;
  /** Only Maps created by the Player with this username (case-insensitive). */
  readonly creatorUsername?: string;
}

/** Why a creator-only change was refused. */
export type MapChangeRefusal = "not_found" | "not_creator" | "archived";

interface MapRow {
  id: string;
  player_id: string;
  username: string;
  emblem: string | null;
  name: string;
  description: string;
  latest_revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  format: number;
  width: number;
  height: number;
  spawn_zones: number;
  notes: string;
  revision_created_at: string;
}

interface RevisionRow {
  map_id: string;
  number: number;
  content: string;
  notes: string;
  created_at: string;
}

interface SummaryRow {
  number: number;
  format: number;
  width: number;
  height: number;
  spawn_zones: number;
  notes: string;
  created_at: string;
}

const MAP_COLUMNS = `
  m.id, m.player_id, p.username, p.emblem, m.name, m.description, m.latest_revision, m.created_at, m.updated_at, m.archived_at,
  r.format, r.width, r.height, r.spawn_zones, r.notes, r.created_at AS revision_created_at
  FROM maps m
  JOIN players p ON p.id = m.player_id
  JOIN map_revisions r ON r.map_id = m.id AND r.number = m.latest_revision`;

const toSummary = (row: SummaryRow): MapRevisionSummary => ({
  number: row.number,
  format: row.format,
  width: row.width,
  height: row.height,
  spawnZones: row.spawn_zones,
  notes: row.notes,
  createdAt: row.created_at,
});

const toMap = (row: MapRow): MapRecord => ({
  id: row.id,
  creator: { id: row.player_id, username: row.username, emblem: row.emblem },
  name: row.name,
  description: row.description,
  latestRevision: toSummary({ ...row, number: row.latest_revision, created_at: row.revision_created_at }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
});

const toRevision = (row: RevisionRow): MapRevisionRecord => ({
  mapId: row.map_id,
  number: row.number,
  map: JSON.parse(row.content) as MapFormat1,
  notes: row.notes,
  createdAt: row.created_at,
});

export class MapStore {
  readonly #db: DatabaseSync;
  readonly #transaction: <T>(fn: () => T) => T;

  constructor(db: DatabaseSync, transaction: <T>(fn: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  /** Creates a Map with `content` (and `notes`, if any) as its Revision 1. */
  createMap(map: NewMap, content: MapFormat1, now: Date, notes = ""): { map: MapRecord; revision: MapRevisionRecord } {
    const at = now.toISOString();
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO maps (id, player_id, name, description, latest_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(map.id, map.playerId, map.name, map.description ?? "", at, at);
      const created = this.#insertRevision(map.id, 1, content, notes, at);
      const record = this.getMap(map.id);
      if (record === undefined) throw new Error(`Map ${map.id} vanished while being created`);
      return { map: record, revision: created };
    });
  }

  /**
   * Adds the next Revision, with `notes` if any, to a Map, if `playerId`
   * created it and it is not archived; otherwise says why not.
   */
  addRevision(
    playerId: string,
    mapId: string,
    content: MapFormat1,
    now: Date,
    notes = "",
  ): MapRevisionRecord | MapChangeRefusal {
    const at = now.toISOString();
    return this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT player_id, latest_revision, archived_at FROM maps WHERE id = ?")
        .get(mapId) as { player_id: string; latest_revision: number; archived_at: string | null } | undefined;
      if (row === undefined) return "not_found";
      if (row.player_id !== playerId) return "not_creator";
      if (row.archived_at !== null) return "archived";
      const number = row.latest_revision + 1;
      const created = this.#insertRevision(mapId, number, content, notes, at);
      this.#db.prepare("UPDATE maps SET latest_revision = ?, updated_at = ? WHERE id = ?").run(number, at, mapId);
      return created;
    });
  }

  #insertRevision(mapId: string, number: number, content: MapFormat1, notes: string, at: string): MapRevisionRecord {
    this.#db
      .prepare(
        `INSERT INTO map_revisions (map_id, number, content, format, width, height, spawn_zones, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mapId,
        number,
        JSON.stringify(content),
        content.format,
        content.width,
        content.height,
        content.spawnZones.length,
        notes,
        at,
      );
    return { mapId, number, map: content, notes, createdAt: at };
  }

  /** Any Map, archived or not. */
  getMap(mapId: string): MapRecord | undefined {
    const row = this.#db.prepare(`SELECT ${MAP_COLUMNS} WHERE m.id = ?`).get(mapId) as MapRow | undefined;
    return row === undefined ? undefined : toMap(row);
  }

  /** A page of Maps, most recently updated first; archived ones only if asked for. */
  listMaps(options: MapListOptions = {}, page: PageRequest = FIRST_PAGE): Page<MapRecord> {
    const conditions: string[] = [];
    const args: string[] = [];
    if (options.includeArchived !== true) conditions.push("m.archived_at IS NULL");
    if (options.creatorUsername !== undefined) {
      conditions.push("p.username_key = ?");
      args.push(usernameKey(options.creatorUsername));
    }
    return queryPage(
      this.#db,
      { columns: MAP_COLUMNS, conditions, args, sort: "m.updated_at", rowid: "m.rowid" },
      page,
      toMap,
    );
  }

  /** A Revision of any Map. */
  getRevision(mapId: string, number: number): MapRevisionRecord | undefined {
    const row = this.#db
      .prepare("SELECT map_id, number, content, notes, created_at FROM map_revisions WHERE map_id = ? AND number = ?")
      .get(mapId, number) as RevisionRow | undefined;
    return row === undefined ? undefined : toRevision(row);
  }

  /** A page of the Revisions of a Map, newest first; undefined if there is no such Map. */
  listRevisions(mapId: string, page: PageRequest = FIRST_PAGE): Page<MapRevisionSummary> | undefined {
    if (this.#db.prepare("SELECT 1 FROM maps WHERE id = ?").get(mapId) === undefined) return undefined;
    return queryPage(
      this.#db,
      {
        columns: "number, format, width, height, spawn_zones, notes, created_at FROM map_revisions",
        conditions: ["map_id = ?"],
        args: [mapId],
        sort: "number",
        rowid: "rowid",
      },
      page,
      toSummary,
    );
  }

  /**
   * Truly deletes a Revision of a Map `playerId` created, archived or not,
   * unless it is the Map's latest (which is the Map's current state) or any
   * Game, in any state, uses it; otherwise says why not.
   */
  deleteRevision(
    playerId: string,
    mapId: string,
    number: number,
  ): true | "not_found" | "not_creator" | "latest" | "in_use" {
    return this.#transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT m.player_id, m.latest_revision FROM maps m JOIN map_revisions r ON r.map_id = m.id
           WHERE m.id = ? AND r.number = ?`,
        )
        .get(mapId, number) as { player_id: string; latest_revision: number } | undefined;
      if (row === undefined) return "not_found";
      if (row.player_id !== playerId) return "not_creator";
      if (row.latest_revision === number) return "latest";
      const used = this.#db
        .prepare("SELECT 1 FROM games WHERE map_id = ? AND map_revision = ? LIMIT 1")
        .get(mapId, number);
      if (used !== undefined) return "in_use";
      this.#db.prepare("DELETE FROM map_revisions WHERE map_id = ? AND number = ?").run(mapId, number);
      return true;
    });
  }

  /**
   * Changes the name and/or description of a Map `playerId` created,
   * archived or not, adding no Revision; otherwise says why not.
   */
  updateMap(playerId: string, mapId: string, changes: MapChanges, now: Date): true | "not_found" | "not_creator" {
    return this.#transaction(() => {
      const row = this.#db.prepare("SELECT player_id FROM maps WHERE id = ?").get(mapId) as
        | { player_id: string }
        | undefined;
      if (row === undefined) return "not_found";
      if (row.player_id !== playerId) return "not_creator";
      this.#db
        .prepare(
          `UPDATE maps SET name = coalesce(?, name), description = coalesce(?, description), updated_at = ?
           WHERE id = ?`,
        )
        .run(changes.name ?? null, changes.description ?? null, now.toISOString(), mapId);
      return true;
    });
  }

  /**
   * Archives a Map if `playerId` created it (a no-op if already archived);
   * otherwise says why not.
   */
  archiveMap(playerId: string, mapId: string, now: Date): true | "not_found" | "not_creator" {
    return this.#transaction(() => {
      const at = now.toISOString();
      const row = this.#db.prepare("SELECT player_id FROM maps WHERE id = ?").get(mapId) as
        | { player_id: string }
        | undefined;
      if (row === undefined) return "not_found";
      if (row.player_id !== playerId) return "not_creator";
      this.#db
        .prepare("UPDATE maps SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
        .run(at, at, mapId);
      return true;
    });
  }
}
