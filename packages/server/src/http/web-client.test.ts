import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiModules, startServer, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";

const INDEX = "<!doctype html><title>client</title>";

let root: string;
let web: string;
let running: RunningServer | undefined;

beforeAll(() => {
  // root/secret.txt sits beside the client's directory, where no path may reach it.
  root = mkdtempSync(join(tmpdir(), "positrontanks-web-"));
  web = join(root, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), INDEX);
  writeFileSync(join(web, "assets", "index-abc123.js"), "console.log('client');");
  writeFileSync(join(web, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
  writeFileSync(join(web, "robots.txt"), "User-agent: *");
  writeFileSync(join(root, "secret.txt"), "top-secret contents");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function boot(webDirectory = web): Promise<RunningServer> {
  const config: ServerConfig = { ...defaultConfig, port: 0, databasePath: ":memory:", webDirectory };
  running = await startServer(config, { modules: apiModules, logger: { info: () => undefined, error: () => undefined } });
  return running;
}

async function fetchPath(path: string, init?: RequestInit): Promise<Response> {
  if (running === undefined) throw new Error("server not started");
  return fetch(running.url + path, { redirect: "manual", ...init });
}

/** Sends `path` exactly as written; fetch would resolve dot segments first. */
async function rawGet(path: string): Promise<{ status: number; body: string }> {
  if (running === undefined) throw new Error("server not started");
  const { port } = new URL(running.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("web client", () => {
  it("serves index.html at /play/", async () => {
    await boot();
    const response = await fetchPath("/play/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe(INDEX);
  });

  it("redirects /play to /play/, keeping the query", async () => {
    await boot();
    const response = await fetchPath("/play?x=1");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/play/?x=1");
  });

  it("serves built files with their content type, caching fingerprinted assets for good", async () => {
    await boot();
    const script = await fetchPath("/play/assets/index-abc123.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await script.text()).toBe("console.log('client');");

    const image = await fetchPath("/play/assets/logo.png");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

    const robots = await fetchPath("/play/robots.txt");
    expect(robots.headers.get("cache-control")).toBe("no-cache");
    expect(await robots.text()).toBe("User-agent: *");
  });

  it("falls back to index.html for any other /play/* path", async () => {
    await boot();
    for (const path of ["/play/games/123", "/play/garage/", "/play/assets/missing.js", "/play/assets", "/play/%E0%A4%A"]) {
      const response = await fetchPath(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(INDEX);
    }
  });

  it("never serves a file outside its directory", async () => {
    await boot();
    for (const path of ["/play/../secret.txt", "/play/%2e%2e/secret.txt", "/play/..%2fsecret.txt", "/play/..%5csecret.txt"]) {
      const { body } = await rawGet(path);
      expect(body, path).not.toContain("top-secret contents");
    }
  });

  it("answers HEAD with headers only", async () => {
    await boot();
    const response = await fetchPath("/play/assets/index-abc123.js", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String("console.log('client');".length));
    expect(await response.text()).toBe("");
  });

  it("allows only GET and HEAD", async () => {
    await boot();
    const response = await fetchPath("/play/", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("answers 404 when the client is not built", async () => {
    await boot(join(root, "missing"));
    const response = await fetchPath("/play/games");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("leaves API paths unaffected", async () => {
    await boot();
    expect(await (await fetchPath("/health")).json()).toEqual({ status: "ok" });
    expect((await fetchPath("/rulesets")).headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect((await fetchPath("/playground")).status).toBe(404);
    expect((await fetchPath("/openapi.json")).status).toBe(200);
  });
});
