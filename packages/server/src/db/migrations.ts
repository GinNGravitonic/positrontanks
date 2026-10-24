/**
 * Schema migrations.
 *
 * Migrations are numbered from 1 with no gaps and are never edited once
 * released: a schema change is always a new migration appended to the list.
 * Each one runs in its own transaction together with its row in
 * `schema_migrations`, so a failed migration leaves the database at the
 * previous version.
 *
 * Opening a database that is already past the newest known version is
 * refused: it was written by a newer server whose schema this one does not
 * understand.
 */

import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  /** Short identifier; recorded and checked so edited history is caught. */
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "meta",
    sql: `
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
  {
    version: 2,
    name: "accounts",
    // A Player is the identity; how it signs in lives in separate credential
    // tables (only passwords in v1), so OAuth can add its own table later.
    // Session tokens and API keys are stored only as SHA-256 hashes.
    sql: `
      CREATE TABLE players (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE password_credentials (
        player_id TEXT PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX sessions_by_player ON sessions (player_id);
      CREATE INDEX sessions_by_expiry ON sessions (expires_at);
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX api_keys_by_player ON api_keys (player_id);
    `,
  },
];

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

interface AppliedRow {
  version: number;
  name: string;
}

/** Applies every pending migration in order and returns the versions it applied. */
export function migrate(db: DatabaseSync, list: readonly Migration[] = migrations): number[] {
  list.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(`Migration "${m.name}" has version ${String(m.version)}, expected ${String(i + 1)}`);
    }
  });

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const applied = db
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as unknown as AppliedRow[];
  for (const row of applied) {
    const known = list[row.version - 1];
    if (known === undefined) {
      throw new MigrationError(
        `Database is at schema version ${String(row.version)} but this server only knows up to ${String(list.length)}`,
      );
    }
    if (known.name !== row.name) {
      throw new MigrationError(
        `Migration ${String(row.version)} was applied as "${row.name}" but is now named "${known.name}"`,
      );
    }
  }

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  );
  const done: number[] = [];
  for (const m of list.slice(applied.length)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      record.run(m.version, m.name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new MigrationError(`Migration ${String(m.version)} "${m.name}" failed`, { cause: error });
    }
    done.push(m.version);
  }
  return done;
}
