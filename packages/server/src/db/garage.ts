/**
 * Queries for Garages: Bot Designs and their Revisions.
 *
 * Every lookup is scoped to the owning Player, so a Player can never reach
 * another Player's design (or its Program) through this store. Revisions are
 * only ever inserted, notes included; the schema refuses updates to them. Builds are stored
 * as JSON text and handed back parsed; callers validate before saving.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Build } from "@positrontanks/ruleset-data";
import { FIRST_PAGE, queryPage, type Page, type PageRequest } from "./paging.js";

export interface RevisionRecord {
  readonly designId: string;
  /** 1 for the first Revision, then one more for each edit. */
  readonly number: number;
  readonly build: Build;
  readonly program: string;
  /** The Build's point cost under the design's Ruleset. */
  readonly cost: number;
  /** What changed, private to the owner like the Program; empty if none. */
  readonly notes: string;
  readonly createdAt: string;
}

/** A Revision without its Build or Program, for listings. */
export interface RevisionSummary {
  readonly number: number;
  readonly cost: number;
  readonly notes: string;
  readonly createdAt: string;
}

export interface DesignRecord {
  readonly id: string;
  readonly playerId: string;
  readonly name: string;
  /** Free text, private to the owner like the rest of the design; empty if none. */
  readonly description: string;
  readonly rulesetVersion: string;
  readonly latestRevision: RevisionSummary;
  readonly copiedFrom: { readonly designId: string; readonly revision: number } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface NewDesign {
  readonly id: string;
  readonly playerId: string;
  readonly name: string;
  /** Defaults to empty. */
  readonly description?: string;
  readonly rulesetVersion: string;
  readonly copiedFrom?: { readonly designId: string; readonly revision: number };
}

/** What an update changes; fields left out are kept. */
export interface DesignChanges {
  readonly name?: string;
  readonly description?: string;
}

export interface NewRevision {
  readonly build: Build;
  readonly program: string;
  readonly cost: number;
  /** Defaults to empty. */
  readonly notes?: string;
}

export interface ListOptions {
  readonly includeArchived?: boolean;
  readonly rulesetVersion?: string;
}

interface DesignRow {
  id: string;
  player_id: string;
  name: string;
  description: string;
  ruleset_version: string;
  latest_revision: number;
  copied_from_design_id: string | null;
  copied_from_revision: number | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  cost: number;
  revision_notes: string;
  revision_created_at: string;
}

interface RevisionRow {
  design_id: string;
  number: number;
  build: string;
  program: string;
  cost: number;
  notes: string;
  created_at: string;
}

const DESIGN_COLUMNS = `
  d.id, d.player_id, d.name, d.description, d.ruleset_version, d.latest_revision, d.copied_from_design_id,
  d.copied_from_revision, d.created_at, d.updated_at, d.archived_at, r.cost, r.notes AS revision_notes,
  r.created_at AS revision_created_at
  FROM bot_designs d JOIN bot_design_revisions r ON r.design_id = d.id AND r.number = d.latest_revision`;

const toDesign = (row: DesignRow): DesignRecord => ({
  id: row.id,
  playerId: row.player_id,
  name: row.name,
  description: row.description,
  rulesetVersion: row.ruleset_version,
  latestRevision: {
    number: row.latest_revision,
    cost: row.cost,
    notes: row.revision_notes,
    createdAt: row.revision_created_at,
  },
  copiedFrom:
    row.copied_from_design_id === null || row.copied_from_revision === null
      ? null
      : { designId: row.copied_from_design_id, revision: row.copied_from_revision },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
});

const toRevision = (row: RevisionRow): RevisionRecord => ({
  designId: row.design_id,
  number: row.number,
  build: JSON.parse(row.build) as Build,
  program: row.program,
  cost: row.cost,
  notes: row.notes,
  createdAt: row.created_at,
});

export class GarageStore {
  readonly #db: DatabaseSync;
  readonly #transaction: <T>(fn: () => T) => T;

  constructor(db: DatabaseSync, transaction: <T>(fn: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  /** Creates a design with `revision` as its Revision 1. */
  createDesign(design: NewDesign, revision: NewRevision, now: Date): { design: DesignRecord; revision: RevisionRecord } {
    const at = now.toISOString();
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO bot_designs (id, player_id, name, description, ruleset_version, latest_revision,
             copied_from_design_id, copied_from_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          design.id,
          design.playerId,
          design.name,
          design.description ?? "",
          design.rulesetVersion,
          design.copiedFrom?.designId ?? null,
          design.copiedFrom?.revision ?? null,
          at,
          at,
        );
      const created = this.#insertRevision(design.id, 1, revision, at);
      const record = this.getDesign(design.playerId, design.id);
      if (record === undefined) throw new Error(`Design ${design.id} vanished while being created`);
      return { design: record, revision: created };
    });
  }

  /**
   * Adds the next Revision to one of the Player's designs. Returns undefined
   * if the Player has no such design, and "archived" if it is archived.
   */
  addRevision(playerId: string, designId: string, revision: NewRevision, now: Date): RevisionRecord | "archived" | undefined {
    const at = now.toISOString();
    return this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT latest_revision, archived_at FROM bot_designs WHERE id = ? AND player_id = ?")
        .get(designId, playerId) as { latest_revision: number; archived_at: string | null } | undefined;
      if (row === undefined) return undefined;
      if (row.archived_at !== null) return "archived";
      const number = row.latest_revision + 1;
      const created = this.#insertRevision(designId, number, revision, at);
      this.#db
        .prepare("UPDATE bot_designs SET latest_revision = ?, updated_at = ? WHERE id = ?")
        .run(number, at, designId);
      return created;
    });
  }

  #insertRevision(designId: string, number: number, revision: NewRevision, at: string): RevisionRecord {
    const notes = revision.notes ?? "";
    this.#db
      .prepare(
        `INSERT INTO bot_design_revisions (design_id, number, build, program, cost, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(designId, number, JSON.stringify(revision.build), revision.program, revision.cost, notes, at);
    return { designId, number, build: revision.build, program: revision.program, cost: revision.cost, notes, createdAt: at };
  }

  /** One of the Player's designs, archived or not. */
  getDesign(playerId: string, designId: string): DesignRecord | undefined {
    const row = this.#db
      .prepare(`SELECT ${DESIGN_COLUMNS} WHERE d.id = ? AND d.player_id = ?`)
      .get(designId, playerId) as DesignRow | undefined;
    return row === undefined ? undefined : toDesign(row);
  }

  /** A page of the Player's designs, most recently updated first; archived ones only if asked for. */
  listDesigns(playerId: string, options: ListOptions = {}, page: PageRequest = FIRST_PAGE): Page<DesignRecord> {
    const conditions = ["d.player_id = ?"];
    const args: string[] = [playerId];
    if (options.includeArchived !== true) conditions.push("d.archived_at IS NULL");
    if (options.rulesetVersion !== undefined) {
      conditions.push("d.ruleset_version = ?");
      args.push(options.rulesetVersion);
    }
    return queryPage(
      this.#db,
      { columns: DESIGN_COLUMNS, conditions, args, sort: "d.updated_at", rowid: "d.rowid" },
      page,
      toDesign,
    );
  }

  /** A Revision of one of the Player's designs. */
  getRevision(playerId: string, designId: string, number: number): RevisionRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT r.design_id, r.number, r.build, r.program, r.cost, r.notes, r.created_at
         FROM bot_design_revisions r JOIN bot_designs d ON d.id = r.design_id
         WHERE r.design_id = ? AND r.number = ? AND d.player_id = ?`,
      )
      .get(designId, number, playerId) as RevisionRow | undefined;
    return row === undefined ? undefined : toRevision(row);
  }

  /** A page of the Revisions of one of the Player's designs, newest first; undefined if it has no such design. */
  listRevisions(playerId: string, designId: string, page: PageRequest = FIRST_PAGE): Page<RevisionSummary> | undefined {
    if (this.#db.prepare("SELECT 1 FROM bot_designs WHERE id = ? AND player_id = ?").get(designId, playerId) === undefined) {
      return undefined;
    }
    return queryPage(
      this.#db,
      {
        columns: "number, cost, notes, created_at FROM bot_design_revisions",
        conditions: ["design_id = ?"],
        args: [designId],
        sort: "number",
        rowid: "rowid",
      },
      page,
      (row: { number: number; cost: number; notes: string; created_at: string }): RevisionSummary => ({
        number: row.number,
        cost: row.cost,
        notes: row.notes,
        createdAt: row.created_at,
      }),
    );
  }

  /**
   * Truly deletes a Revision of one of the Player's designs, archived or
   * not, unless it is the design's latest (which is the design's current
   * state) or any Game uses it (any Entry, in any Game state, references
   * it); otherwise says why not.
   */
  deleteRevision(playerId: string, designId: string, number: number): true | "not_found" | "latest" | "in_use" {
    return this.#transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT d.latest_revision FROM bot_designs d JOIN bot_design_revisions r ON r.design_id = d.id
           WHERE d.id = ? AND d.player_id = ? AND r.number = ?`,
        )
        .get(designId, playerId, number) as { latest_revision: number } | undefined;
      if (row === undefined) return "not_found";
      if (row.latest_revision === number) return "latest";
      const used = this.#db
        .prepare("SELECT 1 FROM game_entry_bots WHERE design_id = ? AND design_revision = ? LIMIT 1")
        .get(designId, number);
      if (used !== undefined) return "in_use";
      this.#db.prepare("DELETE FROM bot_design_revisions WHERE design_id = ? AND number = ?").run(designId, number);
      return true;
    });
  }

  /**
   * Changes the name and/or description of one of the Player's designs,
   * archived or not, adding no Revision; false if it has no such design.
   */
  updateDesign(playerId: string, designId: string, changes: DesignChanges, now: Date): boolean {
    const result = this.#db
      .prepare(
        `UPDATE bot_designs SET name = coalesce(?, name), description = coalesce(?, description), updated_at = ?
         WHERE id = ? AND player_id = ?`,
      )
      .run(changes.name ?? null, changes.description ?? null, now.toISOString(), designId, playerId);
    return Number(result.changes) > 0;
  }

  /** Archives one of the Player's designs (a no-op if already archived); false if it has no such design. */
  archiveDesign(playerId: string, designId: string, now: Date): boolean {
    return this.#transaction(() => {
      const at = now.toISOString();
      const found = this.#db.prepare("SELECT 1 FROM bot_designs WHERE id = ? AND player_id = ?").get(designId, playerId);
      if (found === undefined) return false;
      this.#db
        .prepare("UPDATE bot_designs SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
        .run(at, at, designId);
      return true;
    });
  }
}
