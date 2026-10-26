import { afterEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "./app.js";
import { defaultConfig, type ServerConfig } from "./config.js";
import { migrations } from "./db/migrations.js";
import { validationFailed } from "./http/errors.js";
import type { ApiModule } from "./http/router.js";

const config: ServerConfig = {
  ...defaultConfig,
  port: 0,
  databasePath: ":memory:",
  limits: { ...defaultConfig.limits, maxRequestBodyBytes: 64 },
};

const logged: string[] = [];
const logger: Logger = {
  info: () => undefined,
  error: (message, fields) => logged.push(`${message} ${JSON.stringify(fields)}`),
};

/** Routes that exercise the framework; not part of the real API. */
const testModule: ApiModule = {
  schemas: { Echo: { type: "object" } },
  routes: [
    {
      method: "POST",
      path: "/echo/{name}",
      operation: { operationId: "echo", summary: "Echo", responses: { "200": { description: "Echoed." } } },
      handler: async ({ params, readJson }) => ({ body: { name: params.name, body: await readJson() } }),
    },
    {
      method: "GET",
      path: "/invalid",
      operation: { operationId: "invalid", summary: "Invalid", responses: {} },
      handler: () => {
        throw validationFailed([{ path: "x", message: "must be positive" }]);
      },
    },
    {
      method: "GET",
      path: "/crash",
      operation: { operationId: "crash", summary: "Crash", responses: {} },
      handler: () => {
        throw new Error("secret internals");
      },
    },
  ],
};

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  logged.length = 0;
});

async function boot(modules: readonly ApiModule[] = []): Promise<RunningServer> {
  running = await startServer(config, { modules, logger });
  return running;
}

async function get(path: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: unknown }> {
  if (running === undefined) throw new Error("server not started");
  const response = await fetch(running.url + path, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === "" ? undefined : JSON.parse(text) };
}

describe("server", () => {
  it("boots on a fresh database with migrations applied", async () => {
    const server = await boot();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.services.db.schemaVersion()).toBe(migrations.length);
  });

  it("reports health", async () => {
    await boot();
    const response = await get("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.body).toEqual({ status: "ok" });
  });

  it("reports an unhealthy database as 503", async () => {
    const server = await boot();
    server.services.db.close();
    const response = await get("/health");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: "unavailable" } });
  });

  it("reports its optional features, off by default", async () => {
    await boot();
    const response = await get("/server");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ features: { tickCostCheck: false } });
  });

  it("serves the OpenAPI document covering every registered route", async () => {
    await boot([testModule]);
    const { status, body } = await get("/openapi.json");
    expect(status).toBe(200);
    const doc = body as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/crash",
      "/echo/{name}",
      "/health",
      "/invalid",
      "/openapi.json",
      "/server",
    ]);
    expect(doc.paths["/health"]?.get?.operationId).toBe("getHealth");
    expect(doc.paths["/echo/{name}"]?.post?.responses.default).toEqual({ $ref: "#/components/responses/Error" });
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(["Error", "Health", "Echo"]));
  });

  it("parses JSON bodies and decodes path parameters", async () => {
    await boot([testModule]);
    const response = await get("/echo/a%20b/", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ n: 1 }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ name: "a b", body: { n: 1 } });
  });
});

describe("error format", () => {
  const post = (body: string, type = "application/json") =>
    get("/echo/x", { method: "POST", headers: { "content-type": type }, body });

  it("answers unknown paths with 404 not_found", async () => {
    await boot();
    const response = await get("/nope");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: "not_found", message: "No endpoint at /nope" } });
  });

  it("answers a wrong method with 405 and an Allow header", async () => {
    await boot();
    const response = await get("/health", { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.body).toMatchObject({ error: { code: "method_not_allowed" } });
  });

  it("rejects bad bodies", async () => {
    await boot([testModule]);
    expect((await post("{", "application/json")).body).toMatchObject({ error: { code: "invalid_json" } });
    expect((await post("")).status).toBe(400);
    const wrongType = await post("{}", "text/plain");
    expect(wrongType.status).toBe(415);
    expect(wrongType.body).toMatchObject({ error: { code: "unsupported_media_type" } });
    const big = await post(JSON.stringify({ s: "x".repeat(100) }));
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("includes details for validation errors", async () => {
    await boot([testModule]);
    const response = await get("/invalid");
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: {
        code: "validation_failed",
        message: "The request is not valid",
        details: [{ path: "x", message: "must be positive" }],
      },
    });
  });

  it("hides unexpected errors behind 500 internal_error and logs them", async () => {
    await boot([testModule]);
    const response = await get("/crash");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(logged.join("\n")).toContain("secret internals");
  });
});
