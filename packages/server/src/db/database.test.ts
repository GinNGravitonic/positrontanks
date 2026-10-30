import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { migrate, MigrationError, migrations, type Migration } from "./migrations.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "positrontanks-db-"));
  path = join(dir, "test.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const next = migrations.length + 1;
const extra: Migration = { version: next, name: "things", sql: "CREATE TABLE things (id INTEGER PRIMARY KEY) STRICT" };

describe("migrations", () => {
  it("bring a fresh database to the newest version", () => {
    const db = Database.open(path);
    expect(db.schemaVersion()).toBe(migrations.length);
    expect(db.tableNames()).toEqual([
      "api_keys",
      "bot_design_revisions",
      "bot_designs",
      "game_entries",
      "game_entry_bots",
      "games",
      "map_revisions",
      "maps",
      "meta",
      "password_credentials",
      "players",
      "schema_migrations",
      "sessions",
    ]);
    db.close();
  });

  it("use WAL on a file database", () => {
    Database.open(path).close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    raw.close();
  });

  it("apply only what is pending on reopen", () => {
    Database.open(path).close();
    const raw = new DatabaseSync(path);
    expect(migrate(raw)).toEqual([]);
    expect(migrate(raw, [...migrations, extra])).toEqual([next]);
    raw.close();
    const db = Database.open(path, { migrations: [...migrations, extra] });
    expect(db.schemaVersion()).toBe(next);
    expect(db.tableNames()).toContain("things");
    db.close();
  });

  it("roll back a failing migration and leave the previous version", () => {
    const broken: Migration = { version: next, name: "broken", sql: "CREATE TABLE half (id INTEGER); SELECT nonsense FROM" };
    expect(() => Database.open(path, { migrations: [...migrations, broken] })).toThrow(MigrationError);
    const db = Database.open(path);
    expect(db.schemaVersion()).toBe(migrations.length);
    expect(db.tableNames()).not.toContain("half");
    db.close();
  });

  it("refuse a database written by a newer server", () => {
    Database.open(path, { migrations: [...migrations, extra] }).close();
    expect(() => Database.open(path)).toThrow(`schema version ${String(next)}`);
  });

  it("refuse edited history", () => {
    Database.open(path).close();
    const renamed = migrations.map((m) => ({ ...m, name: "renamed" }));
    expect(() => Database.open(path, { migrations: renamed })).toThrow(/now named "renamed"/);
  });

  it("must be numbered from 1 without gaps", () => {
    const raw = new DatabaseSync(":memory:");
    expect(() => migrate(raw, [{ ...extra, version: 3 }])).toThrow(/expected 1/);
    raw.close();
  });
});

describe("the game_failures migration", () => {
  it("rebuilds the games table, keeping every Game, its Entries and the listing order", () => {
    const version = migrations.findIndex((m) => m.name === "game_failures") + 1;
    expect(version).toBeGreaterThan(1);
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON");
    migrate(raw, migrations.slice(0, version - 1));
    const at = "2026-01-01T00:00:00.000Z";
    raw.exec(`
      INSERT INTO players (id, username, username_key, created_at) VALUES ('p1', 'Ada', 'ada', '${at}'),
        ('p2', 'Bix', 'bix', '${at}');
      INSERT INTO maps (id, player_id, name, latest_revision, created_at, updated_at)
        VALUES ('m1', 'p1', 'Field', 1, '${at}', '${at}');
      INSERT INTO map_revisions (map_id, number, content, format, width, height, spawn_zones, created_at)
        VALUES ('m1', 1, '{}', 1, 20, 10, 2, '${at}');
      INSERT INTO bot_designs (id, player_id, name, ruleset_version, latest_revision, created_at, updated_at)
        VALUES ('d1', 'p1', 'Scout', 'r1', 1, '${at}', '${at}');
      INSERT INTO bot_design_revisions (design_id, number, build, program, cost, created_at)
        VALUES ('d1', 1, '{}', 'function tick() {}', 40, '${at}');
    `);
    const insertGame = raw.prepare(
      `INSERT INTO games (id, initiator_id, ruleset_version, map_id, map_revision, player_count, point_budget,
         time_limit_seconds, pace, fill_timeout_seconds, state, created_at, fill_deadline, started_at, ended_at,
         cancel_reason, last_tick, result_end, winner_id, decided_by)
       VALUES (?, 'p1', 'r1', 'm1', 1, 2, 100, 60, 'realtime', 600, ?, '${at}', '${at}', ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Inserted out of id order: listings order by rowid, which must survive.
    insertGame.run("g4", "cancelled", null, at, "initiator", null, null, null, null);
    insertGame.run("g1", "open", null, null, null, null, null, null, null);
    insertGame.run("g3", "finished", at, at, null, 42, "last_standing", "p2", "foe_damage");
    insertGame.run("g2", "running", at, null, null, 7, null, null, null);
    insertGame.run("g5", "cancelled", null, at, "fill_timeout", null, null, null, null);
    raw.exec(`
      INSERT INTO game_entries (id, game_id, player_id, cost, created_at) VALUES ('e1', 'g2', 'p1', 40, '${at}'),
        ('e2', 'g3', 'p2', 40, '${at}');
      INSERT INTO game_entry_bots (entry_id, position, game_id, name, name_key, design_id, design_revision)
        VALUES ('e1', 0, 'g2', 'Ada', 'ada', 'd1', 1), ('e2', 0, 'g3', 'Bix', 'bix', 'd1', 1);
    `);
    const everything = (db: DatabaseSync) => ({
      games: db.prepare("SELECT rowid, * FROM games ORDER BY rowid").all(),
      entries: db.prepare("SELECT * FROM game_entries ORDER BY id").all(),
      bots: db.prepare("SELECT * FROM game_entry_bots ORDER BY entry_id").all(),
    });
    const before = everything(raw);
    raw.close();

    const db = Database.open(path);
    expect(db.schemaVersion()).toBe(migrations.length);
    db.close();
    const after = new DatabaseSync(path);
    after.exec("PRAGMA foreign_keys = ON");
    const migrated = everything(after);
    expect(migrated.games).toEqual(before.games.map((game) => ({ ...game, failed_attempts: 0 })));
    expect(migrated.entries).toEqual(before.entries);
    expect(migrated.bots).toEqual(before.bots);
    expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const indexes = after
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'games' AND sql IS NOT NULL ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(["games_by_initiator", "games_by_map_revision", "games_by_state"]);
    // The new cancel reason is allowed, unknown ones still are not, and Entries still need their Game.
    after.prepare("UPDATE games SET state = 'cancelled', cancel_reason = 'server_error' WHERE id = 'g2'").run();
    expect(() => after.prepare("UPDATE games SET cancel_reason = 'bored' WHERE id = 'g2'").run()).toThrow(/CHECK/);
    expect(() => after.prepare("UPDATE games SET failed_attempts = -1 WHERE id = 'g2'").run()).toThrow(/CHECK/);
    const orphan = after.prepare(
      "INSERT INTO game_entries (id, game_id, player_id, cost, created_at) VALUES ('e3', 'nope', 'p1', 1, 'x')",
    );
    expect(() => orphan.run()).toThrow(/FOREIGN KEY/);
    after.close();

    const reopened = Database.open(path);
    expect(reopened.games.getGame("g3")).toMatchObject({
      state: "finished",
      failedAttempts: 0,
      result: { tick: 42, end: "last_standing", winner: { id: "p2", username: "Bix" }, decidedBy: "foe_damage" },
    });
    expect(reopened.games.listEntries("g3").map((entry) => entry.id)).toEqual(["e2"]);
    expect(reopened.games.listPlayerGames("p1").items.map((game) => game.id)).toEqual(["g5", "g2", "g3", "g1", "g4"]);
    reopened.close();
  });
});

describe("the descriptions migration", () => {
  it("gives existing Bot Designs and Maps an empty description, at most 2000 characters", () => {
    const version = migrations.findIndex((m) => m.name === "descriptions") + 1;
    expect(version).toBeGreaterThan(1);
    const raw = new DatabaseSync(path);
    migrate(raw, migrations.slice(0, version - 1));
    const at = "2026-01-01T00:00:00.000Z";
    raw.exec(`
      INSERT INTO players (id, username, username_key, created_at) VALUES ('p1', 'Ada', 'ada', '${at}');
      INSERT INTO maps (id, player_id, name, latest_revision, created_at, updated_at)
        VALUES ('m1', 'p1', 'Field', 1, '${at}', '${at}');
      INSERT INTO bot_designs (id, player_id, name, ruleset_version, latest_revision, created_at, updated_at)
        VALUES ('d1', 'p1', 'Scout', 'r1', 1, '${at}', '${at}');
    `);
    raw.close();

    const db = Database.open(path);
    expect(db.schemaVersion()).toBe(migrations.length);
    db.close();
    const after = new DatabaseSync(path);
    expect(after.prepare("SELECT description FROM maps").all()).toEqual([{ description: "" }]);
    expect(after.prepare("SELECT description FROM bot_designs").all()).toEqual([{ description: "" }]);
    after.prepare("UPDATE maps SET description = ?").run("d".repeat(2000));
    expect(() => after.prepare("UPDATE maps SET description = ?").run("d".repeat(2001))).toThrow(/CHECK/);
    expect(() => after.prepare("UPDATE bot_designs SET description = ?").run("d".repeat(2001))).toThrow(/CHECK/);
    after.close();
  });
});

describe("the revision_notes migration", () => {
  it("gives existing Revisions empty notes, at most 500 characters, which can never be changed", () => {
    const version = migrations.findIndex((m) => m.name === "revision_notes") + 1;
    expect(version).toBeGreaterThan(1);
    const raw = new DatabaseSync(path);
    migrate(raw, migrations.slice(0, version - 1));
    const at = "2026-01-01T00:00:00.000Z";
    raw.exec(`
      INSERT INTO players (id, username, username_key, created_at) VALUES ('p1', 'Ada', 'ada', '${at}');
      INSERT INTO maps (id, player_id, name, latest_revision, created_at, updated_at)
        VALUES ('m1', 'p1', 'Field', 1, '${at}', '${at}');
      INSERT INTO map_revisions (map_id, number, content, format, width, height, spawn_zones, created_at)
        VALUES ('m1', 1, '{}', 1, 10, 10, 2, '${at}');
      INSERT INTO bot_designs (id, player_id, name, ruleset_version, latest_revision, created_at, updated_at)
        VALUES ('d1', 'p1', 'Scout', 'r1', 1, '${at}', '${at}');
      INSERT INTO bot_design_revisions (design_id, number, build, program, cost, created_at)
        VALUES ('d1', 1, '{}', '', 1, '${at}');
    `);
    raw.close();

    const db = Database.open(path);
    expect(db.schemaVersion()).toBe(migrations.length);
    db.close();
    const after = new DatabaseSync(path);
    expect(after.prepare("SELECT notes FROM map_revisions").all()).toEqual([{ notes: "" }]);
    expect(after.prepare("SELECT notes FROM bot_design_revisions").all()).toEqual([{ notes: "" }]);
    expect(() => after.prepare("UPDATE map_revisions SET notes = 'later'").run()).toThrow(/immutable/);
    expect(() => after.prepare("UPDATE bot_design_revisions SET notes = 'later'").run()).toThrow(/immutable/);
    after
      .prepare(
        `INSERT INTO map_revisions (map_id, number, content, format, width, height, spawn_zones, notes, created_at)
         VALUES ('m1', 2, '{}', 1, 10, 10, 2, ?, '${at}')`,
      )
      .run("n".repeat(500));
    expect(() =>
      after
        .prepare(
          `INSERT INTO bot_design_revisions (design_id, number, build, program, cost, notes, created_at)
           VALUES ('d1', 2, '{}', '', 1, ?, '${at}')`,
        )
        .run("n".repeat(501)),
    ).toThrow(/CHECK/);
    after.close();
  });
});

describe("Database", () => {
  it("records when it was created", () => {
    const db = Database.open(":memory:");
    expect(db.getMeta("created_at")).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(db.getMeta("missing")).toBeUndefined();
    db.close();
  });

  it("commits a transaction that returns and rolls back one that throws", () => {
    const db = Database.open(":memory:");
    expect(
      db.transaction(() => {
        db.setMeta("a", "1");
        db.transaction(() => {
          db.setMeta("b", "1");
        });
        return 42;
      }),
    ).toBe(42);
    expect(() =>
      db.transaction(() => {
        db.setMeta("a", "2");
        db.transaction(() => {
          db.setMeta("c", "2");
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect([db.getMeta("a"), db.getMeta("b"), db.getMeta("c")]).toEqual(["1", "1", undefined]);
    db.close();
  });

  it("can be closed twice and fails once closed", () => {
    const db = Database.open(":memory:");
    db.ping();
    db.close();
    db.close();
    expect(() => {
      db.ping();
    }).toThrow();
  });
});

describe("Garage schema", () => {
  it("refuses to change a saved Revision", () => {
    const db = Database.open(path);
    expect(db.accounts.createPasswordPlayer("p1", "ada", "hash", new Date())).toBeDefined();
    const build = { chassis: "scout", components: {}, armor: { front: null, left: null, right: null, rear: null } };
    db.garage.createDesign(
      { id: "d1", playerId: "p1", name: "Scout", rulesetVersion: "r1" },
      { build, program: "function tick() {}", cost: 40 },
      new Date(),
    );
    db.close();

    const raw = new DatabaseSync(path);
    expect(() => raw.prepare("UPDATE bot_design_revisions SET program = 'x' WHERE design_id = 'd1'").run()).toThrow(
      /immutable/,
    );
    raw.close();
    const reopened = Database.open(path);
    expect(reopened.garage.getRevision("p1", "d1", 1)?.program).toBe("function tick() {}");
    reopened.close();
  });
});

describe("Map schema", () => {
  it("refuses to change a saved Revision", () => {
    const db = Database.open(path);
    expect(db.accounts.createPasswordPlayer("p1", "ada", "hash", new Date())).toBeDefined();
    const zone = { heading: 0, capacity: 1, shape: "circle", x: 5, y: 5, radius: 1 } as const;
    const content = {
      format: 1,
      width: 20,
      height: 10,
      baseTerrain: "grass",
      terrainRegions: [],
      obstacles: [],
      spawnZones: [zone, { ...zone, x: 15 }],
    } as const;
    db.maps.createMap({ id: "m1", playerId: "p1", name: "Field" }, content, new Date());
    db.close();

    const raw = new DatabaseSync(path);
    expect(() => raw.prepare("UPDATE map_revisions SET width = 99 WHERE map_id = 'm1'").run()).toThrow(/immutable/);
    raw.close();
    const reopened = Database.open(path);
    expect(reopened.maps.getRevision("m1", 1)?.map).toEqual(content);
    reopened.close();
  });
});
