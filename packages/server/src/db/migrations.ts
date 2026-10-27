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
  {
    version: 3,
    name: "garage",
    // A Bot Design is authored against one Ruleset version and owns a
    // numbered series of Revisions (1, 2, ...). Revisions are immutable: a
    // trigger refuses updates, and Entries and Games will reference them by
    // (design_id, number). Archiving sets archived_at and deletes nothing.
    // The Build is stored as its JSON text.
    sql: `
      CREATE TABLE bot_designs (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        ruleset_version TEXT NOT NULL,
        latest_revision INTEGER NOT NULL,
        copied_from_design_id TEXT REFERENCES bot_designs (id) ON DELETE SET NULL,
        copied_from_revision INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;
      CREATE INDEX bot_designs_by_player ON bot_designs (player_id, archived_at);
      CREATE TABLE bot_design_revisions (
        design_id TEXT NOT NULL REFERENCES bot_designs (id) ON DELETE CASCADE,
        number INTEGER NOT NULL CHECK (number >= 1),
        build TEXT NOT NULL,
        program TEXT NOT NULL,
        cost INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (design_id, number)
      ) STRICT;
      CREATE TRIGGER bot_design_revisions_immutable BEFORE UPDATE ON bot_design_revisions
      BEGIN
        SELECT RAISE(ABORT, 'Revisions are immutable');
      END;
    `,
  },
  {
    version: 4,
    name: "maps",
    // A Map is public and owns a numbered series of Revisions (1, 2, ...),
    // like a Bot Design but independent of Rulesets. Revisions are
    // immutable: a trigger refuses updates, and Games will reference them by
    // (map_id, number). Archiving sets archived_at and deletes nothing. The
    // content is stored as its JSON text; format, size and Spawn Zone count
    // are copied out of it for listings (and, later, Game filters).
    sql: `
      CREATE TABLE maps (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        latest_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;
      CREATE INDEX maps_by_archived ON maps (archived_at, updated_at);
      CREATE INDEX maps_by_player ON maps (player_id);
      CREATE TABLE map_revisions (
        map_id TEXT NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
        number INTEGER NOT NULL CHECK (number >= 1),
        content TEXT NOT NULL,
        format INTEGER NOT NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        spawn_zones INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (map_id, number)
      ) STRICT;
      CREATE TRIGGER map_revisions_immutable BEFORE UPDATE ON map_revisions
      BEGIN
        SELECT RAISE(ABORT, 'Revisions are immutable');
      END;
    `,
  },
  {
    version: 5,
    name: "games",
    // A Game references one Map Revision and, through its Entries, Bot
    // Design Revisions; the foreign keys (no ON DELETE action) make any
    // Revision a Game uses undeletable. state is open, running, finished or
    // cancelled; fill_deadline is when an Open Game that is not yet full is
    // cancelled (cancel_reason 'fill_timeout', ended_at = fill_deadline).
    // Withdrawing an Entry deletes it; Entries of Cancelled Games are kept.
    // Each Entry's Bots are numbered from 0 in submission order, and Bot
    // Names are unique within a Game by name_key (lower-cased).
    sql: `
      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        initiator_id TEXT NOT NULL REFERENCES players (id),
        ruleset_version TEXT NOT NULL,
        map_id TEXT NOT NULL,
        map_revision INTEGER NOT NULL,
        player_count INTEGER NOT NULL CHECK (player_count >= 2),
        point_budget INTEGER NOT NULL CHECK (point_budget >= 1),
        time_limit_seconds INTEGER NOT NULL CHECK (time_limit_seconds >= 1),
        pace TEXT NOT NULL CHECK (pace IN ('realtime', 'unthrottled')),
        fill_timeout_seconds INTEGER NOT NULL CHECK (fill_timeout_seconds >= 1),
        state TEXT NOT NULL CHECK (state IN ('open', 'running', 'finished', 'cancelled')),
        created_at TEXT NOT NULL,
        fill_deadline TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        cancel_reason TEXT CHECK (cancel_reason IN ('initiator', 'fill_timeout')),
        FOREIGN KEY (map_id, map_revision) REFERENCES map_revisions (map_id, number)
      ) STRICT;
      CREATE INDEX games_by_state ON games (state, fill_deadline);
      CREATE INDEX games_by_initiator ON games (initiator_id);
      CREATE INDEX games_by_map_revision ON games (map_id, map_revision);
      CREATE TABLE game_entries (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games (id),
        player_id TEXT NOT NULL REFERENCES players (id),
        cost INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX game_entries_by_game ON game_entries (game_id);
      CREATE INDEX game_entries_by_player ON game_entries (player_id);
      CREATE TABLE game_entry_bots (
        entry_id TEXT NOT NULL REFERENCES game_entries (id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        game_id TEXT NOT NULL REFERENCES games (id),
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        design_id TEXT NOT NULL,
        design_revision INTEGER NOT NULL,
        PRIMARY KEY (entry_id, position),
        UNIQUE (game_id, name_key),
        FOREIGN KEY (design_id, design_revision) REFERENCES bot_design_revisions (design_id, number)
      ) STRICT;
      CREATE INDEX game_entry_bots_by_revision ON game_entry_bots (design_id, design_revision);
    `,
  },
  {
    version: 6,
    name: "game_results",
    // The Game runner's progress and a Finished Game's result. last_tick is
    // the last Tick played and saved, NULL until the Game is first run;
    // resuming after a restart replays the Game Record (in object storage)
    // up to it. A Finished Game has result_end set, its last_tick is the Tick
    // it ended in, and winner_id is NULL for a Draw. decided_by says what
    // picked the Winner: survival, or a tiebreak (foe damage, then Hit
    // Points); NULL for a Draw.
    sql: `
      ALTER TABLE games ADD COLUMN last_tick INTEGER CHECK (last_tick >= 0);
      ALTER TABLE games ADD COLUMN result_end TEXT
        CHECK (result_end IN ('last_standing', 'none_standing', 'time_limit'));
      ALTER TABLE games ADD COLUMN winner_id TEXT REFERENCES players (id);
      ALTER TABLE games ADD COLUMN decided_by TEXT CHECK (decided_by IN ('survival', 'foe_damage', 'hit_points'));
    `,
  },
  {
    version: 7,
    name: "game_failures",
    // A Running Game whose run keeps failing is cancelled with cancel_reason
    // 'server_error' (ended_at = when it was cancelled). failed_attempts
    // counts its failed runs, including those before a restart, so the retry
    // budget survives one. SQLite cannot alter a CHECK constraint, so the
    // games table is rebuilt: its rows (with their rowids, which order
    // listings) are copied aside, the table dropped and recreated, and the
    // rows copied back. Foreign keys stay on: the Entries' references to the
    // dropped Games are deferred, and satisfied again once their Games are
    // back, before the migration commits.
    sql: `
      PRAGMA defer_foreign_keys = ON;
      CREATE TEMP TABLE games_copy AS SELECT rowid AS copied_rowid, * FROM games;
      DROP TABLE games;
      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        initiator_id TEXT NOT NULL REFERENCES players (id),
        ruleset_version TEXT NOT NULL,
        map_id TEXT NOT NULL,
        map_revision INTEGER NOT NULL,
        player_count INTEGER NOT NULL CHECK (player_count >= 2),
        point_budget INTEGER NOT NULL CHECK (point_budget >= 1),
        time_limit_seconds INTEGER NOT NULL CHECK (time_limit_seconds >= 1),
        pace TEXT NOT NULL CHECK (pace IN ('realtime', 'unthrottled')),
        fill_timeout_seconds INTEGER NOT NULL CHECK (fill_timeout_seconds >= 1),
        state TEXT NOT NULL CHECK (state IN ('open', 'running', 'finished', 'cancelled')),
        created_at TEXT NOT NULL,
        fill_deadline TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        cancel_reason TEXT CHECK (cancel_reason IN ('initiator', 'fill_timeout', 'server_error')),
        last_tick INTEGER CHECK (last_tick >= 0),
        result_end TEXT CHECK (result_end IN ('last_standing', 'none_standing', 'time_limit')),
        winner_id TEXT REFERENCES players (id),
        decided_by TEXT CHECK (decided_by IN ('survival', 'foe_damage', 'hit_points')),
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        FOREIGN KEY (map_id, map_revision) REFERENCES map_revisions (map_id, number)
      ) STRICT;
      INSERT INTO games (rowid, id, initiator_id, ruleset_version, map_id, map_revision, player_count, point_budget,
        time_limit_seconds, pace, fill_timeout_seconds, state, created_at, fill_deadline, started_at, ended_at,
        cancel_reason, last_tick, result_end, winner_id, decided_by)
      SELECT copied_rowid, id, initiator_id, ruleset_version, map_id, map_revision, player_count, point_budget,
        time_limit_seconds, pace, fill_timeout_seconds, state, created_at, fill_deadline, started_at, ended_at,
        cancel_reason, last_tick, result_end, winner_id, decided_by
      FROM temp.games_copy;
      DROP TABLE temp.games_copy;
      CREATE INDEX games_by_state ON games (state, fill_deadline);
      CREATE INDEX games_by_initiator ON games (initiator_id);
      CREATE INDEX games_by_map_revision ON games (map_id, map_revision);
    `,
  },
  {
    version: 8,
    name: "descriptions",
    // A free-text description on each Bot Design and Map, set by its owner
    // and changeable at any time (archived or not). It belongs to the design
    // or Map, not to a Revision; existing rows get an empty one.
    sql: `
      ALTER TABLE bot_designs ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000);
      ALTER TABLE maps ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000);
    `,
  },
  {
    version: 9,
    name: "revision_notes",
    // Commit-message-like notes on each Bot Design and Map Revision: what
    // changed. Set only when the Revision is inserted; the immutability
    // triggers still refuse any later update. Existing Revisions get empty
    // notes.
    sql: `
      ALTER TABLE bot_design_revisions ADD COLUMN notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 500);
      ALTER TABLE map_revisions ADD COLUMN notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 500);
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
