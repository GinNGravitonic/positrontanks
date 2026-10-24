/**
 * Queries for Maps and their Revisions.
 *
 * Maps are public: anyone may read any Map, archived or not, so reads take
 * no Player. Changes (new Revisions, archiving) are scoped to the creator
 * and report whether the Map exists but belongs to someone else, since a
 * Map's existence is no secret. Revisions are only ever inserted; the schema
 * refuses updates to them. Map content is stored as JSON text and handed
 * back parsed; callers validate before saving.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MapFormat1 } from "@aumohta/ruleset-data";
import { usernameKey } from "./accounts.js";

export interface MapRevisionRecord {
  readonly mapId: string;
  /** 1 for the first Revision, then one more for each edit. */
  readonly number: number;
  readonly map: MapFormat1;
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
  readonly createdAt: string;
}

export interface MapRecord {
  readonly id: string;
  readonly creator: { readonly id: string; readonly username: string };
  readonly name: string;
  readonly latestRevision: MapRevisionSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface NewMap {
  readonly id: string;
  readonly playerId: string;
  readonly name: string;
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
  name: string;
  latest_revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  format: number;
  width: number;
  height: number;
  spawn_zones: number;
  revision_created_at: string;
}

interface RevisionRow {
  map_id: string;
  number: number;
  content: string;
  created_at: string;
}

interface SummaryRow {
  number: number;
  format: number;
  width: number;
  height: number;
  spawn_zones: number;
  created_at: string;
}

const MAP_COLUMNS = `
  m.id, m.player_id, p.username, m.name, m.latest_revision, m.created_at, m.updated_at, m.archived_at,
  r.format, r.width, r.height, r.spawn_zones, r.created_at AS revision_created_at
  FROM maps m
  JOIN players p ON p.id = m.player_id
  JOIN map_revisions r ON r.map_id = m.id AND r.number = m.latest_revision`;

const toSummary = (row: SummaryRow): MapRevisionSummary => ({
  number: row.number,
  format: row.format,
  width: row.width,
  height: row.height,
  spawnZones: row.spawn_zones,
  createdAt: row.created_at,
});

const toMap = (row: MapRow): MapRecord => ({
  id: row.id,
  creator: { id: row.player_id, username: row.username },
  name: row.name,
  latestRevision: toSummary({ ...row, number: row.latest_revision, created_at: row.revision_created_at }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
});

const toRevision = (row: RevisionRow): MapRevisionRecord => ({
  mapId: row.map_id,
  number: row.number,
  map: JSON.parse(row.content) as MapFormat1,
  createdAt: row.created_at,
});

export class MapStore {
  readonly #db: DatabaseSync;
  readonly #transaction: <T>(fn: () => T) => T;

  constructor(db: DatabaseSync, transaction: <T>(fn: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  /** Creates a Map with `content` as its Revision 1. */
  createMap(map: NewMap, content: MapFormat1, now: Date): { map: MapRecord; revision: MapRevisionRecord } {
    const at = now.toISOString();
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO maps (id, player_id, name, latest_revision, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run(map.id, map.playerId, map.name, at, at);
      const created = this.#insertRevision(map.id, 1, content, at);
      const record = this.getMap(map.id);
      if (record === undefined) throw new Error(`Map ${map.id} vanished while being created`);
      return { map: record, revision: created };
    });
  }

  /**
   * Adds the next Revision to a Map, if `playerId` created it and it is not
   * archived; otherwise says why not.
   */
  addRevision(playerId: string, mapId: string, content: MapFormat1, now: Date): MapRevisionRecord | MapChangeRefusal {
    const at = now.toISOString();
    return this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT player_id, latest_revision, archived_at FROM maps WHERE id = ?")
        .get(mapId) as { player_id: string; latest_revision: number; archived_at: string | null } | undefined;
      if (row === undefined) return "not_found";
      if (row.player_id !== playerId) return "not_creator";
      if (row.archived_at !== null) return "archived";
      const number = row.latest_revision + 1;
      const created = this.#insertRevision(mapId, number, content, at);
      this.#db.prepare("UPDATE maps SET latest_revision = ?, updated_at = ? WHERE id = ?").run(number, at, mapId);
      return created;
    });
  }

  #insertRevision(mapId: string, number: number, content: MapFormat1, at: string): MapRevisionRecord {
    this.#db
      .prepare(
        `INSERT INTO map_revisions (map_id, number, content, format, width, height, spawn_zones, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mapId,
        number,
        JSON.stringify(content),
        content.format,
        content.width,
        content.height,
        content.spawnZones.length,
        at,
      );
    return { mapId, number, map: content, createdAt: at };
  }

  /** Any Map, archived or not. */
  getMap(mapId: string): MapRecord | undefined {
    const row = this.#db.prepare(`SELECT ${MAP_COLUMNS} WHERE m.id = ?`).get(mapId) as MapRow | undefined;
    return row === undefined ? undefined : toMap(row);
  }

  /** Maps, most recently updated first; archived ones only if asked for. */
  listMaps(options: MapListOptions = {}): MapRecord[] {
    const conditions: string[] = [];
    const args: string[] = [];
    if (options.includeArchived !== true) conditions.push("m.archived_at IS NULL");
    if (options.creatorUsername !== undefined) {
      conditions.push("p.username_key = ?");
      args.push(usernameKey(options.creatorUsername));
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(`SELECT ${MAP_COLUMNS} ${where} ORDER BY m.updated_at DESC, m.rowid DESC`)
      .all(...args) as unknown as MapRow[];
    return rows.map(toMap);
  }

  /** A Revision of any Map. */
  getRevision(mapId: string, number: number): MapRevisionRecord | undefined {
    const row = this.#db
      .prepare("SELECT map_id, number, content, created_at FROM map_revisions WHERE map_id = ? AND number = ?")
      .get(mapId, number) as RevisionRow | undefined;
    return row === undefined ? undefined : toRevision(row);
  }

  /** The Revisions of a Map, newest first; undefined if there is no such Map. */
  listRevisions(mapId: string): MapRevisionSummary[] | undefined {
    if (this.#db.prepare("SELECT 1 FROM maps WHERE id = ?").get(mapId) === undefined) return undefined;
    const rows = this.#db
      .prepare(
        `SELECT number, format, width, height, spawn_zones, created_at
         FROM map_revisions WHERE map_id = ? ORDER BY number DESC`,
      )
      .all(mapId) as unknown as SummaryRow[];
    return rows.map(toSummary);
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
