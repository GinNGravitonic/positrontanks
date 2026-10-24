/**
 * Queries for Games and their Entries.
 *
 * A Game moves Open -> Running when its last Entry arrives, or Open ->
 * Cancelled when its Initiator cancels it or its fill deadline passes. The
 * fill timeout is applied lazily: `expireOpenGames` cancels every Open Game
 * whose deadline has passed, recording the deadline itself as the end time,
 * so a Game looks the same whenever it is next read. Callers run it before
 * reading or changing Games.
 *
 * This store checks only what concerns Games themselves (state, free slots,
 * ownership, Bot Name clashes); callers validate an Entry's Bot Designs,
 * cost and Spawn Zone fit, inside the same transaction as `addEntry`.
 *
 * Entries come back with each Bot's Build (never its Program), read from the
 * referenced Bot Design Revision, so the caller decides who may see it.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Build } from "@aumohta/ruleset-data";

export const GAME_STATES = ["open", "running", "finished", "cancelled"] as const;
export type GameState = (typeof GAME_STATES)[number];

export const PACES = ["realtime", "unthrottled"] as const;
export type Pace = (typeof PACES)[number];

export type CancelReason = "initiator" | "fill_timeout";

export interface GameRecord {
  readonly id: string;
  readonly initiator: { readonly id: string; readonly username: string };
  readonly rulesetVersion: string;
  readonly map: { readonly id: string; readonly name: string; readonly revision: number };
  readonly playerCount: number;
  readonly pointBudget: number;
  readonly timeLimitSeconds: number;
  readonly pace: Pace;
  readonly fillTimeoutSeconds: number;
  readonly state: GameState;
  readonly createdAt: string;
  readonly fillDeadline: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly cancelReason: CancelReason | null;
  readonly entryCount: number;
}

export interface NewGame {
  readonly id: string;
  readonly initiatorId: string;
  readonly rulesetVersion: string;
  readonly mapId: string;
  readonly mapRevision: number;
  readonly playerCount: number;
  readonly pointBudget: number;
  readonly timeLimitSeconds: number;
  readonly pace: Pace;
  readonly fillTimeoutSeconds: number;
}

export interface EntryBotRecord {
  readonly name: string;
  readonly designId: string;
  readonly revision: number;
  /** The Revision's point cost. */
  readonly cost: number;
  readonly build: Build;
}

export interface EntryRecord {
  readonly id: string;
  readonly gameId: string;
  readonly player: { readonly id: string; readonly username: string };
  /** The combined cost of the Entry's Bots. */
  readonly cost: number;
  readonly createdAt: string;
  /** In submission order. */
  readonly bots: readonly EntryBotRecord[];
}

export interface NewEntryBot {
  readonly name: string;
  readonly designId: string;
  readonly revision: number;
}

export interface NewEntry {
  readonly id: string;
  readonly playerId: string;
  readonly cost: number;
  readonly bots: readonly NewEntryBot[];
}

export interface OpenGameFilters {
  readonly rulesetVersion?: string;
  readonly mapId?: string;
  readonly playerCount?: number;
  readonly minPointBudget?: number;
  readonly maxPointBudget?: number;
}

/** Why an Entry was refused; `name_taken` lists the clashing names as submitted. */
export type EntryRefusal =
  | { readonly kind: "not_found" }
  | { readonly kind: "not_open"; readonly state: GameState }
  | { readonly kind: "full" }
  | { readonly kind: "name_taken"; readonly names: readonly string[] };

/** The key Bot Names are compared by: unique within a Game, ignoring case. */
export const botNameKey = (name: string): string => name.toLowerCase();

interface GameRow {
  id: string;
  initiator_id: string;
  username: string;
  ruleset_version: string;
  map_id: string;
  map_name: string;
  map_revision: number;
  player_count: number;
  point_budget: number;
  time_limit_seconds: number;
  pace: Pace;
  fill_timeout_seconds: number;
  state: GameState;
  created_at: string;
  fill_deadline: string;
  started_at: string | null;
  ended_at: string | null;
  cancel_reason: CancelReason | null;
  entry_count: number;
}

interface EntryBotRow {
  entry_id: string;
  game_id: string;
  player_id: string;
  username: string;
  entry_cost: number;
  entry_created_at: string;
  name: string;
  design_id: string;
  design_revision: number;
  cost: number;
  build: string;
}

const GAME_COLUMNS = `
  g.id, g.initiator_id, p.username, g.ruleset_version, g.map_id, m.name AS map_name, g.map_revision,
  g.player_count, g.point_budget, g.time_limit_seconds, g.pace, g.fill_timeout_seconds, g.state,
  g.created_at, g.fill_deadline, g.started_at, g.ended_at, g.cancel_reason,
  (SELECT count(*) FROM game_entries e WHERE e.game_id = g.id) AS entry_count
  FROM games g
  JOIN players p ON p.id = g.initiator_id
  JOIN maps m ON m.id = g.map_id`;

const toGame = (row: GameRow): GameRecord => ({
  id: row.id,
  initiator: { id: row.initiator_id, username: row.username },
  rulesetVersion: row.ruleset_version,
  map: { id: row.map_id, name: row.map_name, revision: row.map_revision },
  playerCount: row.player_count,
  pointBudget: row.point_budget,
  timeLimitSeconds: row.time_limit_seconds,
  pace: row.pace,
  fillTimeoutSeconds: row.fill_timeout_seconds,
  state: row.state,
  createdAt: row.created_at,
  fillDeadline: row.fill_deadline,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  cancelReason: row.cancel_reason,
  entryCount: row.entry_count,
});

export class GameStore {
  readonly #db: DatabaseSync;
  readonly #transaction: <T>(fn: () => T) => T;

  constructor(db: DatabaseSync, transaction: <T>(fn: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  /** Cancels every Open Game whose fill deadline is at or before `now`; returns how many. */
  expireOpenGames(now: Date): number {
    const result = this.#db
      .prepare(
        `UPDATE games SET state = 'cancelled', cancel_reason = 'fill_timeout', ended_at = fill_deadline
         WHERE state = 'open' AND fill_deadline <= ?`,
      )
      .run(now.toISOString());
    return Number(result.changes);
  }

  /** Creates an Open Game; the caller has validated it. */
  createGame(game: NewGame, now: Date): GameRecord {
    const at = now.toISOString();
    const deadline = new Date(now.getTime() + game.fillTimeoutSeconds * 1000).toISOString();
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO games (id, initiator_id, ruleset_version, map_id, map_revision, player_count, point_budget,
             time_limit_seconds, pace, fill_timeout_seconds, state, created_at, fill_deadline)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          game.id,
          game.initiatorId,
          game.rulesetVersion,
          game.mapId,
          game.mapRevision,
          game.playerCount,
          game.pointBudget,
          game.timeLimitSeconds,
          game.pace,
          game.fillTimeoutSeconds,
          at,
          deadline,
        );
      const record = this.getGame(game.id);
      if (record === undefined) throw new Error(`Game ${game.id} vanished while being created`);
      return record;
    });
  }

  getGame(gameId: string): GameRecord | undefined {
    const row = this.#db.prepare(`SELECT ${GAME_COLUMNS} WHERE g.id = ?`).get(gameId) as GameRow | undefined;
    return row === undefined ? undefined : toGame(row);
  }

  /** Open Games matching every given filter, newest first. */
  listOpenGames(filters: OpenGameFilters = {}): GameRecord[] {
    const conditions = ["g.state = 'open'"];
    const args: SQLInputValue[] = [];
    const add = (condition: string, value: SQLInputValue | undefined) => {
      if (value === undefined) return;
      conditions.push(condition);
      args.push(value);
    };
    add("g.ruleset_version = ?", filters.rulesetVersion);
    add("g.map_id = ?", filters.mapId);
    add("g.player_count = ?", filters.playerCount);
    add("g.point_budget >= ?", filters.minPointBudget);
    add("g.point_budget <= ?", filters.maxPointBudget);
    return this.#list(conditions, args);
  }

  /** Games the Player initiated or has an Entry in, in any of `states` (all if omitted), newest first. */
  listPlayerGames(playerId: string, states?: readonly GameState[]): GameRecord[] {
    const conditions = [
      "(g.initiator_id = ? OR EXISTS (SELECT 1 FROM game_entries e WHERE e.game_id = g.id AND e.player_id = ?))",
    ];
    const args: SQLInputValue[] = [playerId, playerId];
    if (states !== undefined) {
      conditions.push(`g.state IN (${states.map(() => "?").join(", ")})`);
      args.push(...states);
    }
    return this.#list(conditions, args);
  }

  #list(conditions: readonly string[], args: readonly SQLInputValue[]): GameRecord[] {
    const rows = this.#db
      .prepare(`SELECT ${GAME_COLUMNS} WHERE ${conditions.join(" AND ")} ORDER BY g.created_at DESC, g.rowid DESC`)
      .all(...args) as unknown as GameRow[];
    return rows.map(toGame);
  }

  /** The Game's Entries in submission order, each with its Bots' Builds. */
  listEntries(gameId: string): EntryRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT e.id AS entry_id, e.game_id, e.player_id, p.username, e.cost AS entry_cost,
           e.created_at AS entry_created_at, b.name, b.design_id, b.design_revision, r.cost, r.build
         FROM game_entries e
         JOIN players p ON p.id = e.player_id
         JOIN game_entry_bots b ON b.entry_id = e.id
         JOIN bot_design_revisions r ON r.design_id = b.design_id AND r.number = b.design_revision
         WHERE e.game_id = ?
         ORDER BY e.created_at, e.rowid, b.position`,
      )
      .all(gameId) as unknown as EntryBotRow[];
    const entries = new Map<string, { record: Omit<EntryRecord, "bots">; bots: EntryBotRecord[] }>();
    for (const row of rows) {
      let entry = entries.get(row.entry_id);
      if (entry === undefined) {
        entry = {
          record: {
            id: row.entry_id,
            gameId: row.game_id,
            player: { id: row.player_id, username: row.username },
            cost: row.entry_cost,
            createdAt: row.entry_created_at,
          },
          bots: [],
        };
        entries.set(row.entry_id, entry);
      }
      entry.bots.push({
        name: row.name,
        designId: row.design_id,
        revision: row.design_revision,
        cost: row.cost,
        build: JSON.parse(row.build) as Build,
      });
    }
    return [...entries.values()].map(({ record, bots }) => ({ ...record, bots }));
  }

  /**
   * Adds an Entry to an Open Game with a free slot, and starts the Game
   * (Open -> Running) if that fills it. Returns the Game as it now is.
   */
  addEntry(gameId: string, entry: NewEntry, now: Date): GameRecord | EntryRefusal {
    const at = now.toISOString();
    return this.#transaction(() => {
      const game = this.getGame(gameId);
      if (game === undefined) return { kind: "not_found" };
      if (game.state !== "open") return { kind: "not_open", state: game.state };
      if (game.entryCount >= game.playerCount) return { kind: "full" };

      const taken = this.#db.prepare("SELECT 1 FROM game_entry_bots WHERE game_id = ? AND name_key = ?");
      const clashes = entry.bots.filter((b) => taken.get(gameId, botNameKey(b.name)) !== undefined).map((b) => b.name);
      if (clashes.length > 0) return { kind: "name_taken", names: clashes };

      this.#db
        .prepare("INSERT INTO game_entries (id, game_id, player_id, cost, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(entry.id, gameId, entry.playerId, entry.cost, at);
      const insertBot = this.#db.prepare(
        `INSERT INTO game_entry_bots (entry_id, position, game_id, name, name_key, design_id, design_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      entry.bots.forEach((bot, position) => {
        insertBot.run(entry.id, position, gameId, bot.name, botNameKey(bot.name), bot.designId, bot.revision);
      });

      if (game.entryCount + 1 >= game.playerCount) {
        this.#db.prepare("UPDATE games SET state = 'running', started_at = ? WHERE id = ?").run(at, gameId);
      }
      const updated = this.getGame(gameId);
      if (updated === undefined) throw new Error(`Game ${gameId} vanished while being entered`);
      return updated;
    });
  }

  /** Withdraws (deletes) the Player's Entry from an Open Game; otherwise says why not. */
  withdrawEntry(
    playerId: string,
    gameId: string,
    entryId: string,
  ): true | "not_found" | "not_owner" | { readonly notOpen: GameState } {
    return this.#transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT e.player_id, g.state FROM game_entries e JOIN games g ON g.id = e.game_id
           WHERE e.id = ? AND e.game_id = ?`,
        )
        .get(entryId, gameId) as { player_id: string; state: GameState } | undefined;
      if (row === undefined) return "not_found";
      if (row.player_id !== playerId) return "not_owner";
      if (row.state !== "open") return { notOpen: row.state };
      this.#db.prepare("DELETE FROM game_entries WHERE id = ?").run(entryId);
      return true;
    });
  }

  /** Cancels an Open Game on its Initiator's request; otherwise says why not. */
  cancelGame(
    playerId: string,
    gameId: string,
    now: Date,
  ): GameRecord | "not_found" | "not_initiator" | { readonly notOpen: GameState } {
    return this.#transaction(() => {
      const game = this.getGame(gameId);
      if (game === undefined) return "not_found";
      if (game.initiator.id !== playerId) return "not_initiator";
      if (game.state !== "open") return { notOpen: game.state };
      this.#db
        .prepare("UPDATE games SET state = 'cancelled', cancel_reason = 'initiator', ended_at = ? WHERE id = ?")
        .run(now.toISOString(), gameId);
      const updated = this.getGame(gameId);
      if (updated === undefined) throw new Error(`Game ${gameId} vanished while being cancelled`);
      return updated;
    });
  }
}
