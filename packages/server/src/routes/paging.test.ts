import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";

const config: ServerConfig = {
  ...defaultConfig,
  port: 0,
  databasePath: ":memory:",
  limits: { ...defaultConfig.limits, maxTimeLimitSeconds: 300, maxFillTimeoutSeconds: 3600 },
};
const quiet: Logger = { info: () => undefined, error: () => undefined };

const DUEL = JSON.parse(
  readFileSync(new URL("../../../ruleset-data/maps/duel.json", import.meta.url), "utf8"),
) as unknown;
const BUILD = {
  chassis: "scout",
  components: { gun: "pelletGun", drive: "wheels" },
  armor: { front: null, left: null, right: null, rear: null },
};
const PROGRAM = `function tick() { throttle(1); fire("gun", 0); }`;

// A clock that never moves, so every Game has the same createdAt and only the tie-breaker orders them.
const NOW = new Date("2026-03-01T12:00:00.000Z");
let running: RunningServer;

beforeEach(async () => {
  running = await startServer(config, { logger: quiet, clock: () => NOW });
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

async function post(path: string, token: string, body: unknown): Promise<string> {
  const response = await call("POST", path, { token, body });
  expect(response.status).toBe(201);
  return (response.body as { id: string }).id;
}

async function player(username: string): Promise<string> {
  const password = "correct horse battery";
  expect((await call("POST", "/players", { body: { username, password } })).status).toBe(201);
  return ((await call("POST", "/sessions", { body: { username, password } })).body as { token: string }).token;
}

type Item = { id: string } | { number: number };
type Body = Record<string, unknown> & { nextCursor: string | null };

const keyOf = (item: Item): string | number => ("id" in item ? item.id : item.number);

async function page(path: string, token: string): Promise<Body> {
  const response = await call("GET", path, { token });
  expect(response.status).toBe(200);
  return response.body as Body;
}

/** Follows nextCursor from the first page to the last, returning each page's keys. */
async function walk(path: string, field: string, token: string, limit: number): Promise<(string | number)[][]> {
  const separator = path.includes("?") ? "&" : "?";
  const pages: (string | number)[][] = [];
  let cursor: string | null = null;
  do {
    const query: string = `${separator}limit=${String(limit)}${cursor === null ? "" : `&cursor=${cursor}`}`;
    const body = await page(path + query, token);
    pages.push((body[field] as Item[]).map(keyOf));
    cursor = body.nextCursor;
  } while (cursor !== null);
  return pages;
}

/** The whole list in one default page, which must be the last. */
async function all(path: string, field: string, token: string): Promise<(string | number)[]> {
  const body = await page(path, token);
  expect(body.nextCursor).toBeNull();
  return (body[field] as Item[]).map(keyOf);
}

let ada: string;
let mapId: string;
let designId: string;

beforeEach(async () => {
  ada = await player("ada");
  mapId = await post("/maps", ada, { name: "Arena", map: DUEL });
  designId = await post("/bot-designs", ada, { name: "Scout", rulesetVersion: "r1", build: BUILD, program: PROGRAM });
});

describe("walking a list larger than one page", () => {
  it("visits every Map once, in list order", async () => {
    for (let i = 0; i < 4; i++) await post("/maps", ada, { name: `Map ${String(i)}`, map: DUEL });
    const pages = await walk("/maps", "maps", ada, 2);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(await all("/maps", "maps", ada));
  });

  it("visits every Map Revision once, newest first", async () => {
    for (let i = 0; i < 4; i++) {
      expect((await call("POST", `/maps/${mapId}/revisions`, { token: ada, body: { map: DUEL } })).status).toBe(201);
    }
    expect(await walk(`/maps/${mapId}/revisions`, "revisions", ada, 2)).toEqual([[5, 4], [3, 2], [1]]);
  });

  it("visits every Bot Design once, in list order", async () => {
    for (let i = 0; i < 4; i++) {
      await post("/bot-designs", ada, { name: `Bot ${String(i)}`, rulesetVersion: "r1", build: BUILD, program: PROGRAM });
    }
    const pages = await walk("/bot-designs", "botDesigns", ada, 2);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(await all("/bot-designs", "botDesigns", ada));
  });

  it("visits every Bot Design Revision once, newest first", async () => {
    for (let i = 0; i < 4; i++) {
      const body = { build: BUILD, program: PROGRAM };
      expect((await call("POST", `/bot-designs/${designId}/revisions`, { token: ada, body })).status).toBe(201);
    }
    expect(await walk(`/bot-designs/${designId}/revisions`, "revisions", ada, 3)).toEqual([[5, 4, 3], [2, 1]]);
  });

  it("visits every Open Game and every one of my Games once, even with equal creation times", async () => {
    const game = {
      rulesetVersion: "r1",
      mapId,
      playerCount: 2,
      pointBudget: 100,
      timeLimitSeconds: 120,
      pace: "unthrottled",
      fillTimeoutSeconds: 600,
    };
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push(await post("/games", ada, game));
    const newestFirst = [...created].reverse();

    expect((await walk("/games?rulesetVersion=r1", "games", ada, 2)).flat()).toEqual(newestFirst);
    expect(await walk("/players/me/games", "games", ada, 2)).toEqual([
      newestFirst.slice(0, 2),
      newestFirst.slice(2, 4),
      newestFirst.slice(4),
    ]);
  });

  it("neither skips nor repeats items changed while paging; a changed item moves to the front", async () => {
    for (let i = 0; i < 5; i++) await post("/maps", ada, { name: `Map ${String(i)}`, map: DUEL });
    const before = await all("/maps", "maps", ada);
    const first = await page("/maps?limit=2", ada);
    const moved = before[4] as string;
    expect((await call("PATCH", `/maps/${moved}`, { token: ada, body: { name: "Moved" } })).status).toBe(200);

    const seen = (first.maps as Item[]).map(keyOf);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const body = await page(`/maps?limit=2&cursor=${cursor}`, ada);
      seen.push(...(body.maps as Item[]).map(keyOf));
      cursor = body.nextCursor;
    }
    expect(seen).toEqual(before.filter((id) => id !== moved));
    expect((await all("/maps", "maps", ada))[0]).toBe(moved);
  });
});

describe("page limits", () => {
  it("default to 50 items", async () => {
    for (let i = 0; i < 50; i++) await post("/maps", ada, { name: `Map ${String(i)}`, map: DUEL });
    const first = await page("/maps", ada);
    expect((first.maps as Item[]).length).toBe(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(`/maps?cursor=${String(first.nextCursor)}`, ada);
    expect((second.maps as Item[]).length).toBe(1);
    expect(second.nextCursor).toBeNull();
  });

  it("accept 1 to 200 and reject anything else", async () => {
    const lists = [
      "/maps",
      `/maps/${mapId}/revisions`,
      "/bot-designs",
      `/bot-designs/${designId}/revisions`,
      "/games",
      "/players/me/games",
    ];
    for (const path of lists) {
      for (const limit of ["1", "200"]) expect((await call("GET", `${path}?limit=${limit}`, { token: ada })).status).toBe(200);
      for (const limit of ["0", "201", "-1", "1.5", "ten", "", "0001"]) {
        const response = await call("GET", `${path}?limit=${limit}`, { token: ada });
        expect(response.status, `${path}?limit=${limit}`).toBe(400);
        expect((response.body as { error: { code: string } }).error.code).toBe("bad_request");
      }
    }
  });
});

describe("cursors", () => {
  it("reject malformed tokens and tokens from a list with another kind of order", async () => {
    await post("/maps", ada, { name: "Second", map: DUEL });
    const mapsCursor = String((await page("/maps?limit=1", ada)).nextCursor);
    const forged = Buffer.from(JSON.stringify(["x", "y"])).toString("base64url");
    for (const cursor of ["nope!", "bm90IGpzb24", forged]) {
      expect((await call("GET", `/maps?cursor=${cursor}`)).status).toBe(400);
    }
    expect((await call("GET", `/maps/${mapId}/revisions?cursor=${mapsCursor}`)).status).toBe(400);
  });

  it("are checked even when a malformed creator filter matches nothing", async () => {
    expect((await call("GET", "/maps?creator=!!&limit=0")).status).toBe(400);
    expect((await page("/maps?creator=!!", ada)).nextCursor).toBeNull();
  });
});

describe("the OpenAPI document", () => {
  it("gives every list endpoint limit and cursor parameters and a nextCursor", async () => {
    const document = (await call("GET", "/openapi.json")).body as {
      paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
      components: { schemas: Record<string, { required: string[]; properties: Record<string, unknown> }> };
    };
    const lists = {
      "/maps": "MapList",
      "/maps/{mapId}/revisions": "MapRevisionList",
      "/bot-designs": "BotDesignList",
      "/bot-designs/{designId}/revisions": "BotDesignRevisionList",
      "/games": "GameList",
      "/players/me/games": "GameList",
    };
    for (const [path, schema] of Object.entries(lists)) {
      const names = (document.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).toEqual(expect.arrayContaining(["limit", "cursor"]));
      expect(document.components.schemas[schema]?.required).toContain("nextCursor");
    }
  });
});
