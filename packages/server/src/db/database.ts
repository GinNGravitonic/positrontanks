/**
 * The data-access module (ADR-0003).
 *
 * All database access goes through this directory: nothing outside `src/db/`
 * imports `node:sqlite` or writes SQL, so a later move to Postgres stays
 * contained. Feature areas add their queries as methods here (or as files in
 * this directory that receive the connection) and the rest of the server
 * sees only plain objects.
 *
 * The connection is synchronous (`DatabaseSync`), which suits a single
 * instance: a transaction is a plain function call that nothing else can
 * interleave with.
 */

import { DatabaseSync } from "node:sqlite";
import { AccountStore } from "./accounts.js";
import { GameStore } from "./games.js";
import { GarageStore } from "./garage.js";
import { MapStore } from "./maps.js";
import { migrate, migrations as defaultMigrations, type Migration } from "./migrations.js";

export interface OpenOptions {
  /** Overrides the built-in migration list; for tests. */
  readonly migrations?: readonly Migration[];
}

export class Database {
  readonly #db: DatabaseSync;
  #depth = 0;
  /** Players and their credentials, sessions and API keys. */
  readonly accounts: AccountStore;
  /** Bot Designs and their Revisions. */
  readonly garage: GarageStore;
  /** Maps and their Revisions. */
  readonly maps: MapStore;
  /** Games and their Entries. */
  readonly games: GameStore;

  private constructor(db: DatabaseSync) {
    this.#db = db;
    const transaction = <T>(fn: () => T): T => this.transaction(fn);
    this.accounts = new AccountStore(db, transaction);
    this.garage = new GarageStore(db, transaction);
    this.maps = new MapStore(db, transaction);
    this.games = new GameStore(db, transaction);
  }

  /**
   * Opens (creating if needed) the database at `path` and brings its schema
   * up to date. `:memory:` gives a private throwaway database.
   */
  static open(path: string, options: OpenOptions = {}): Database {
    const db = new DatabaseSync(path);
    try {
      // WAL is what Litestream replicates; busy_timeout covers its checkpoints.
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
      `);
      migrate(db, options.migrations ?? defaultMigrations);
    } catch (error) {
      db.close();
      throw error;
    }
    return new Database(db);
  }

  /**
   * Runs `fn` in a transaction, committing if it returns and rolling back if
   * it throws. Nested calls join the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return this.#run(fn);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#run(fn);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #run<T>(fn: () => T): T {
    this.#depth++;
    try {
      return fn();
    } finally {
      this.#depth--;
    }
  }

  /** Throws unless the database answers a trivial query. */
  ping(): void {
    this.#db.prepare("SELECT 1").get();
  }

  /** The newest applied migration, or 0 for none. */
  schemaVersion(): number {
    const row = this.#db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  }

  /** A server metadata value (`created_at` is set when the database is created). */
  getMeta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Names of the user tables, excluding SQLite's own. */
  tableNames(): string[] {
    const rows = this.#db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as unknown as { name: string }[];
    return rows.map((r) => r.name);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
