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
