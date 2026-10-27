import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";

const config: ServerConfig = { ...defaultConfig, port: 0, databasePath: ":memory:" };
const quiet: Logger = { info: () => undefined, error: () => undefined };

/** One of ruleset-data's sample Maps. */
const sample = (name: string): MapContent =>
  JSON.parse(readFileSync(new URL(`../../../ruleset-data/maps/${name}.json`, import.meta.url), "utf8")) as MapContent;

let running: RunningServer;

beforeEach(async () => {
  running = await startServer(config, { logger: quiet });
});

afterEach(async () => {
  await running.close();
});

interface Response {
  status: number;
  body: unknown;
}

async function call(method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(running.url + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

interface Detail {
  path: string;
  message: string;
}

const errorOf = (response: Response): { code: string; details?: Detail[] } =>
  (response.body as { error: { code: string; details?: Detail[] } }).error;

async function player(username: string): Promise<string> {
  const password = "correct horse battery";
  expect((await call("POST", "/players", { body: { username, password } })).status).toBe(201);
  return ((await call("POST", "/sessions", { body: { username, password } })).body as { token: string }).token;
}

type MapContent = Record<string, unknown> & { spawnZones: unknown[]; obstacles: unknown[] };

const DUEL = sample("duel");
const FOUR_CORNERS = sample("four-corners");

interface Revision {
  mapId: string;
  number: number;
  map: MapContent;
  notes: string;
  createdAt: string;
}

interface RevisionSummary {
  number: number;
  format: number;
  width: number;
  height: number;
  spawnZones: number;
  notes: string;
  createdAt: string;
}

interface MapBody {
  id: string;
  name: string;
  description: string;
  creator: { id: string; username: string };
  latestRevision: Revision;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface Summary extends Omit<MapBody, "latestRevision"> {
  latestRevision: RevisionSummary;
}

async function create(
  token: string,
  fields: { name?: string; description?: string; map?: unknown; notes?: string } = {},
): Promise<MapBody> {
  const response = await call("POST", "/maps", { token, body: { name: "Duel", map: DUEL, ...fields } });
  expect(response.status).toBe(201);
  return response.body as MapBody;
}

async function list(query = "", token?: string): Promise<Summary[]> {
  const response = await call("GET", `/maps${query}`, token === undefined ? {} : { token });
  expect(response.status).toBe(200);
  return (response.body as { maps: Summary[] }).maps;
}

let ada: string;

beforeEach(async () => {
  ada = await player("ada");
});

describe("creating a Map", () => {
  it("saves Revision 1 with the content, credited to its creator", async () => {
    const map = await create(ada, { name: "  The Duel  " });
    expect(map).toMatchObject({
      name: "The Duel",
      description: "",
      creator: { username: "ada" },
      archivedAt: null,
      latestRevision: { mapId: map.id, number: 1, map: DUEL, notes: "" },
    });
    expect(Object.keys(map).sort()).toEqual(
      ["archivedAt", "createdAt", "creator", "description", "id", "latestRevision", "name", "updatedAt"],
    );

    const fetched = await call("GET", `/maps/${map.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(map);
  });

  it("accepts a description, trimmed, of at most 2000 characters, shown to everyone", async () => {
    const map = await create(ada, { description: "  One pillar,\ntwo Bots.  " });
    expect(map.description).toBe("One pillar,\ntwo Bots.");
    expect(((await call("GET", `/maps/${map.id}`)).body as MapBody).description).toBe("One pillar,\ntwo Bots.");
    expect((await list())[0]?.description).toBe("One pillar,\ntwo Bots.");

    const long = await call("POST", "/maps", { token: ada, body: { name: "x", description: "d".repeat(2001), map: DUEL } });
    expect(long.status).toBe(422);
    expect(errorOf(long).details).toEqual([{ path: "description", message: "must be at most 2000 characters" }]);
    const typed = await call("POST", "/maps", { token: ada, body: { name: "x", description: null, map: DUEL } });
    expect(errorOf(typed).details).toEqual([{ path: "description", message: "must be a string" }]);
    expect(await list()).toHaveLength(1);
  });

  it("requires authentication", async () => {
    const response = await call("POST", "/maps", { body: { name: "Duel", map: DUEL } });
    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe("unauthorized");
    expect(await list()).toEqual([]);
  });

  it("reports every Map Format 1 problem at once and saves nothing", async () => {
    const response = await call("POST", "/maps", {
      token: ada,
      body: {
        name: "Broken",
        map: {
          ...DUEL,
          format: 2,
          baseTerrain: "",
          obstacles: [{ id: "crate", destructible: true, shape: "circle", x: 30, y: 20, radius: 2 }],
          spawnZones: [DUEL.spawnZones[0]],
          extra: true,
        },
      },
    });
    expect(response.status).toBe(422);
    const error = errorOf(response);
    expect(error.code).toBe("validation_failed");
    expect((error.details ?? []).map((d) => d.path).sort()).toEqual([
      "map.baseTerrain",
      "map.extra",
      "map.format",
      "map.obstacles[0].hitPoints",
      "map.spawnZones",
    ]);
    expect(await list()).toEqual([]);
  });

  it("reports geometric problems such as a Spawn Zone overlapping an Obstacle", async () => {
    const zone = { heading: 0, capacity: 2, shape: "circle", x: 30, y: 20, radius: 3 };
    const response = await call("POST", "/maps", {
      token: ada,
      body: { name: "Crowded", map: { ...DUEL, spawnZones: [...DUEL.spawnZones, zone] } },
    });
    expect(response.status).toBe(422);
    expect(errorOf(response).details).toEqual([
      { path: "map.spawnZones[2]", message: 'touches or overlaps map.obstacles[0] "pillar"' },
    ]);
  });

  it("applies the server's Map size limits", async () => {
    const response = await call("POST", "/maps", { token: ada, body: { name: "Huge", map: { ...DUEL, width: 201 } } });
    expect(response.status).toBe(422);
    expect(errorOf(response).details).toEqual([{ path: "map.width", message: "must be at most 200" }]);
  });

  it("rejects bad names and missing or unknown fields", async () => {
    const named = await call("POST", "/maps", { token: ada, body: { name: "", map: DUEL } });
    expect(named.status).toBe(422);
    expect(errorOf(named).details).toEqual([{ path: "name", message: "must be 1 to 64 characters" }]);

    const long = await call("POST", "/maps", { token: ada, body: { name: "n".repeat(65), map: DUEL } });
    expect(errorOf(long).details).toEqual([{ path: "name", message: "must be 1 to 64 characters" }]);

    const messy = await call("POST", "/maps", { token: ada, body: { name: "x", extra: 1 } });
    expect(messy.status).toBe(422);
    expect((errorOf(messy).details ?? []).map((d) => d.path).sort()).toEqual(["extra", "map"]);

    const typed = await call("POST", "/maps", { token: ada, body: { name: 7, map: "duel" } });
    expect((errorOf(typed).details ?? []).map((d) => d.path).sort()).toEqual(["map", "name"]);

    const notObject = await call("POST", "/maps", { token: ada, body: [] });
    expect(errorOf(notObject).details).toEqual([{ path: "(body)", message: "must be a JSON object" }]);
  });
});

describe("public reads", () => {
  it("lists and gets Maps and Revisions without a credential", async () => {
    const duel = await create(ada);
    const corners = await create(ada, { name: "Four Corners", map: FOUR_CORNERS });

    const maps = await list();
    expect(maps.map((m) => m.id)).toEqual([corners.id, duel.id]);
    expect(maps[1]).toEqual({
      ...duel,
      latestRevision: { number: 1, format: 1, width: 60, height: 40, spawnZones: 2, notes: "", createdAt: duel.createdAt },
    });
    expect(maps[0]?.latestRevision.spawnZones).toBe(FOUR_CORNERS.spawnZones.length);

    expect((await call("GET", `/maps/${duel.id}`)).body).toEqual(duel);
    const revisions = await call("GET", `/maps/${duel.id}/revisions`);
    expect(revisions.status).toBe(200);
    expect((revisions.body as { revisions: RevisionSummary[] }).revisions).toEqual([maps[1]?.latestRevision]);
    const revision = await call("GET", `/maps/${duel.id}/revisions/1`);
    expect(revision.status).toBe(200);
    expect(revision.body).toEqual(duel.latestRevision);
  });

  it("shows every Player's Maps to every Player", async () => {
    const duel = await create(ada);
    const grace = await player("grace");
    expect((await list("", grace)).map((m) => m.id)).toEqual([duel.id]);
    expect((await call("GET", `/maps/${duel.id}`, { token: grace })).body).toEqual(duel);
  });

  it("filters by creator username, case-insensitively", async () => {
    const duel = await create(ada);
    const grace = await player("grace");
    const theirs = await create(grace, { name: "Corners", map: FOUR_CORNERS });

    expect((await list("?creator=ADA")).map((m) => m.id)).toEqual([duel.id]);
    expect((await list("?creator=grace")).map((m) => m.id)).toEqual([theirs.id]);
    expect(await list("?creator=nobody")).toEqual([]);
    expect(await list("?creator=a")).toEqual([]);
  });

  it("answers 404 for unknown Maps and Revision numbers", async () => {
    const map = await create(ada);
    for (const path of [
      `/maps/${map.id}/revisions/2`,
      `/maps/${map.id}/revisions/0`,
      `/maps/${map.id}/revisions/one`,
      `/maps/nope/revisions/1`,
      `/maps/nope/revisions`,
      `/maps/nope`,
    ]) {
      const response = await call("GET", path);
      expect(response.status, path).toBe(404);
      expect(errorOf(response).code).toBe("not_found");
    }
    expect((await call("POST", "/maps/nope/revisions", { token: ada, body: { map: DUEL } })).status).toBe(404);
    expect((await call("DELETE", "/maps/nope", { token: ada })).status).toBe(404);
  });

  it("rejects a malformed includeArchived", async () => {
    const response = await call("GET", "/maps?includeArchived=yes");
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe("bad_request");
  });
});

describe("Revisions", () => {
  it("are added by the creator's edits and numbered", async () => {
    const map = await create(ada);
    const edited = { ...DUEL, width: 70, baseTerrain: "sand" };
    const added = await call("POST", `/maps/${map.id}/revisions`, { token: ada, body: { map: edited } });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ mapId: map.id, number: 2, map: edited });

    const latest = (await call("GET", `/maps/${map.id}`)).body as MapBody;
    expect(latest.latestRevision).toEqual(added.body);
    expect(latest.createdAt).toBe(map.createdAt);
    expect(latest.name).toBe(map.name);

    const revisions = (await call("GET", `/maps/${map.id}/revisions`)).body as { revisions: RevisionSummary[] };
    expect(revisions.revisions).toMatchObject([
      { number: 2, width: 70 },
      { number: 1, width: 60 },
    ]);
  });

  it("are validated like a new Map, and an invalid edit adds nothing", async () => {
    const map = await create(ada);
    const invalid = await call("POST", `/maps/${map.id}/revisions`, {
      token: ada,
      body: { map: { ...DUEL, height: -1 } },
    });
    expect(invalid.status).toBe(422);
    expect(errorOf(invalid).details).toEqual([{ path: "map.height", message: "must be greater than 0" }]);

    const missing = await call("POST", `/maps/${map.id}/revisions`, { token: ada, body: { name: "x" } });
    expect((errorOf(missing).details ?? []).map((d) => d.path).sort()).toEqual(["map", "name"]);

    const revisions = (await call("GET", `/maps/${map.id}/revisions`)).body as { revisions: unknown[] };
    expect(revisions.revisions).toHaveLength(1);
  });

  it("never change once saved", async () => {
    const map = await create(ada);
    await call("POST", `/maps/${map.id}/revisions`, { token: ada, body: { map: FOUR_CORNERS } });
    await call("POST", `/maps/${map.id}/revisions`, { token: ada, body: { map: { ...DUEL, height: 50 } } });

    // There is no way to change a Revision through the API (only to delete an unused one).
    for (const method of ["PUT", "PATCH", "POST"]) {
      const response = await call(method, `/maps/${map.id}/revisions/1`, { token: ada, body: { map: FOUR_CORNERS } });
      expect(response.status, method).toBe(405);
      expect(errorOf(response).code).toBe("method_not_allowed");
    }
    expect((await call("PUT", `/maps/${map.id}`, { token: ada, body: { map: FOUR_CORNERS } })).status).toBe(405);
    const patch = await call("PATCH", `/maps/${map.id}`, { token: ada, body: { map: FOUR_CORNERS } });
    expect(patch.status).toBe(422);
    expect(errorOf(patch).details?.[0]).toEqual({ path: "map", message: "is not a known field" });

    // Revision 1 is exactly what was first saved.
    const first = await call("GET", `/maps/${map.id}/revisions/1`);
    expect(first.body).toEqual(map.latestRevision);
    expect(((await call("GET", `/maps/${map.id}/revisions/2`)).body as Revision).map).toEqual(FOUR_CORNERS);
    expect(((await call("GET", `/maps/${map.id}`)).body as MapBody).latestRevision.number).toBe(3);
  });
});

describe("Revision notes", () => {
  it("are given when a Revision is saved, trimmed, and shown to everyone wherever Revisions are", async () => {
    const map = await create(ada, { notes: "  First cut.  " });
    expect(map.latestRevision.notes).toBe("First cut.");
    const added = await call("POST", `/maps/${map.id}/revisions`, {
      token: ada,
      body: { map: FOUR_CORNERS, notes: "n".repeat(500) },
    });
    expect(added.status).toBe(201);
    expect((added.body as Revision).notes).toBe("n".repeat(500));
    const plain = await call("POST", `/maps/${map.id}/revisions`, { token: ada, body: { map: DUEL } });
    expect((plain.body as Revision).notes).toBe("");

    const grace = await player("grace");
    expect(((await call("GET", `/maps/${map.id}/revisions/1`)).body as Revision).notes).toBe("First cut.");
    expect(((await call("GET", `/maps/${map.id}/revisions/2`, { token: grace })).body as Revision).notes).toBe(
      "n".repeat(500),
    );
    const revisions = (await call("GET", `/maps/${map.id}/revisions`)).body as { revisions: RevisionSummary[] };
    expect(revisions.revisions.map((r) => r.notes)).toEqual(["", "n".repeat(500), "First cut."]);
    expect((await list()).find((m) => m.id === map.id)?.latestRevision.notes).toBe("");
  });

  it("are checked, and a bad note saves nothing", async () => {
    const tooLong = await call("POST", "/maps", { token: ada, body: { name: "Duel", map: DUEL, notes: "n".repeat(501) } });
    expect(tooLong.status).toBe(422);
    expect(errorOf(tooLong).details).toEqual([{ path: "notes", message: "must be at most 500 characters" }]);
    expect(await list()).toEqual([]);

    const map = await create(ada);
    const typed = await call("POST", `/maps/${map.id}/revisions`, {
      token: ada,
      body: { map: { ...DUEL, height: -1 }, notes: 5 },
    });
    expect(errorOf(typed).details).toEqual([
      { path: "map.height", message: "must be greater than 0" },
      { path: "notes", message: "must be a string" },
    ]);
    const revisions = (await call("GET", `/maps/${map.id}/revisions`)).body as { revisions: unknown[] };
    expect(revisions.revisions).toHaveLength(1);
  });

  it("can never be changed", async () => {
    const map = await create(ada, { notes: "Original" });
    const patch = await call("PATCH", `/maps/${map.id}`, { token: ada, body: { notes: "Rewritten" } });
    expect(patch.status).toBe(422);
    expect(errorOf(patch).details?.[0]).toEqual({ path: "notes", message: "is not a known field" });
    for (const method of ["PUT", "PATCH"]) {
      const response = await call(method, `/maps/${map.id}/revisions/1`, { token: ada, body: { notes: "Rewritten" } });
      expect(response.status, method).toBe(405);
    }
    expect(((await call("GET", `/maps/${map.id}/revisions/1`)).body as Revision).notes).toBe("Original");
  });
});

describe("ownership", () => {
  it("lets only the creator add Revisions, rename, describe or archive, answering others 403", async () => {
    const map = await create(ada);
    const grace = await player("grace");

    const revise = await call("POST", `/maps/${map.id}/revisions`, { token: grace, body: { map: FOUR_CORNERS } });
    expect(revise.status).toBe(403);
    expect(errorOf(revise).code).toBe("forbidden");
    // Ownership is checked before the content, so an invalid edit is still 403.
    const invalid = await call("POST", `/maps/${map.id}/revisions`, { token: grace, body: { map: {} } });
    expect(invalid.status).toBe(403);

    const archive = await call("DELETE", `/maps/${map.id}`, { token: grace });
    expect(archive.status).toBe(403);
    expect(errorOf(archive).code).toBe("forbidden");

    for (const body of [{ name: "Mine now" }, { description: "Mine now" }, {}]) {
      const update = await call("PATCH", `/maps/${map.id}`, { token: grace, body });
      expect(update.status, JSON.stringify(body)).toBe(403);
      expect(errorOf(update).code).toBe("forbidden");
    }

    // Nothing the other Player tried changed the Map.
    expect((await call("GET", `/maps/${map.id}`)).body).toEqual(map);
    const revisions = (await call("GET", `/maps/${map.id}/revisions`)).body as { revisions: unknown[] };
    expect(revisions.revisions).toHaveLength(1);
  });

  it("requires authentication to change a Map", async () => {
    const map = await create(ada);
    expect((await call("POST", `/maps/${map.id}/revisions`, { body: { map: FOUR_CORNERS } })).status).toBe(401);
    expect((await call("DELETE", `/maps/${map.id}`)).status).toBe(401);
    expect((await call("DELETE", `/maps/${map.id}`, { token: "aus_nonsense" })).status).toBe(401);
    expect((await call("PATCH", `/maps/${map.id}`, { body: { name: "x" } })).status).toBe(401);
    expect((await call("GET", `/maps/${map.id}`)).body).toEqual(map);
  });

  it("accepts an API key as well as a session token", async () => {
    const key = await call("POST", "/api-keys", { token: ada, body: { name: "bot" } });
    expect(key.status).toBe(201);
    const apiKey = (key.body as { key: string }).key;
    const map = await create(apiKey);
    expect(map.creator.username).toBe("ada");
    expect((await call("POST", `/maps/${map.id}/revisions`, { token: apiKey, body: { map: FOUR_CORNERS } })).status).toBe(
      201,
    );
    expect((await call("DELETE", `/maps/${map.id}`, { token: ada })).status).toBe(204);
  });
});

describe("archiving", () => {
  it("hides the Map from listings but keeps it and its Revisions readable by everyone", async () => {
    const map = await create(ada);
    const kept = await create(ada, { name: "Kept", map: FOUR_CORNERS });
    expect((await call("DELETE", `/maps/${map.id}`, { token: ada })).status).toBe(204);

    expect((await list()).map((m) => m.id)).toEqual([kept.id]);
    expect((await list("?includeArchived=true")).map((m) => m.id).sort()).toEqual([map.id, kept.id].sort());

    const fetched = await call("GET", `/maps/${map.id}`);
    expect(fetched.status).toBe(200);
    const archivedAt = (fetched.body as MapBody).archivedAt;
    expect(archivedAt).not.toBeNull();
    expect((await call("GET", `/maps/${map.id}/revisions/1`)).body).toEqual(map.latestRevision);
    expect((await call("GET", `/maps/${map.id}/revisions`)).status).toBe(200);

    // Archiving again does nothing.
    expect((await call("DELETE", `/maps/${map.id}`, { token: ada })).status).toBe(204);
    expect(((await call("GET", `/maps/${map.id}`)).body as MapBody).archivedAt).toBe(archivedAt);
  });

  it("refuses new Revisions", async () => {
    const map = await create(ada);
    await call("DELETE", `/maps/${map.id}`, { token: ada });
    const response = await call("POST", `/maps/${map.id}/revisions`, { token: ada, body: { map: FOUR_CORNERS } });
    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe("map_archived");
    const revisions = (await call("GET", `/maps/${map.id}/revisions`)).body as { revisions: unknown[] };
    expect(revisions.revisions).toHaveLength(1);
  });
});

describe("renaming and describing", () => {
  it("changes the name and description, together or apart, adding no Revision", async () => {
    const map = await create(ada, { name: "Old", description: "Old notes" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const described = await call("PATCH", `/maps/${map.id}`, { token: ada, body: { description: "  Mind the pillar.  " } });
    expect(described.status).toBe(200);
    const after = described.body as MapBody;
    expect(after).toMatchObject({ name: "Old", description: "Mind the pillar.", latestRevision: map.latestRevision });
    expect(after.updatedAt > map.updatedAt).toBe(true);
    expect(after.createdAt).toBe(map.createdAt);

    const renamed = await call("PATCH", `/maps/${map.id}`, { token: ada, body: { name: "  New  " } });
    expect(renamed.body).toMatchObject({ name: "New", description: "Mind the pillar." });
    const both = await call("PATCH", `/maps/${map.id}`, { token: ada, body: { name: "Newer", description: "" } });
    expect(both.body).toMatchObject({ name: "Newer", description: "" });
    expect((await call("GET", `/maps/${map.id}`)).body).toEqual(both.body);
    const revisions = (await call("GET", `/maps/${map.id}/revisions`)).body as { revisions: unknown[] };
    expect(revisions.revisions).toHaveLength(1);
  });

  it("works on archived Maps", async () => {
    const map = await create(ada);
    await call("DELETE", `/maps/${map.id}`, { token: ada });
    const archivedAt = ((await call("GET", `/maps/${map.id}`)).body as MapBody).archivedAt;
    const response = await call("PATCH", `/maps/${map.id}`, { token: ada, body: { name: "Retired", description: "Gone" } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: "Retired", description: "Gone", archivedAt });
  });

  it("rejects empty, unknown and invalid changes, and unknown Maps", async () => {
    const map = await create(ada);
    const empty = await call("PATCH", `/maps/${map.id}`, { token: ada, body: {} });
    expect(empty.status).toBe(422);
    expect(errorOf(empty).details).toEqual([{ path: "(body)", message: "must have a name or a description to change" }]);
    const bad = await call("PATCH", `/maps/${map.id}`, {
      token: ada,
      body: { name: "n".repeat(65), description: 3 },
    });
    expect(errorOf(bad).details).toEqual([
      { path: "name", message: "must be 1 to 64 characters" },
      { path: "description", message: "must be a string" },
    ]);
    expect((await call("GET", `/maps/${map.id}`)).body).toEqual(map);
    expect((await call("PATCH", "/maps/nope", { token: ada, body: { name: "x" } })).status).toBe(404);
  });
});

describe("the OpenAPI document", () => {
  it("describes the Map endpoints, with public reads needing no credential", async () => {
    const doc = (await call("GET", "/openapi.json")).body as {
      paths: Record<string, Record<string, { operationId: string; security?: unknown[] }>>;
      components: { schemas: Record<string, unknown> };
    };
    const operations = Object.values(doc.paths)
      .flatMap((item) => Object.values(item))
      .filter((op) => /Map(s|Revisions?)?$/.test(op.operationId));
    expect(operations.map((op) => op.operationId).sort()).toEqual([
      "archiveMap",
      "createMap",
      "createMapRevision",
      "deleteMapRevision",
      "getMap",
      "getMapRevision",
      "listMapRevisions",
      "listMaps",
      "updateMap",
    ]);
    for (const op of operations) {
      const isRead = /^(get|list)/.test(op.operationId);
      expect(op.security, op.operationId).toEqual(isRead ? [] : [{ bearerAuth: [] }]);
    }
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(["Map", "MapFormat1", "MapRevision"]));
  });
});
