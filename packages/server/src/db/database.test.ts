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
  dir = mkdtempSync(join(tmpdir(), "aumohta-db-"));
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
