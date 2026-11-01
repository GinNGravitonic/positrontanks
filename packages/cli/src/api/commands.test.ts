import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, fetchList, type Schema } from "./client.js";
import { startTestServer, type CliRun, type TestServer } from "./test-server.js";

const PASSWORD = "correct horse battery";
const pw = { stdin: `${PASSWORD}\n` };

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

const cli = (...argv: string[]) => server.cli(argv);
const json = (run: CliRun): unknown => JSON.parse(run.out);
const errorOf = (run: CliRun) => (JSON.parse(run.err) as Schema<"Error">).error;

/** Signs up and logs in `username`, storing an API key in the default profile. */
async function loggedIn(username = "ada"): Promise<void> {
  expect((await server.cli(["auth", "signup", username, "--password-stdin"], pw)).code).toBe(0);
  expect((await server.cli(["auth", "login", username, "--password-stdin"], pw)).code).toBe(0);
}

async function storedKey(profile = "default"): Promise<string> {
  const key = (await server.config())?.profiles[profile]?.apiKey;
  if (key === undefined) throw new Error(`profile ${profile} has no key`);
  return key;
}

describe("an account from signup to logout", () => {
  it("signs up, logs in storing an API key, shows who is logged in, and logs out revoking the key", async () => {
    const signup = await server.cli(["auth", "signup", "Ada_Bot", "--password-stdin", "--json"], pw);
    expect(signup).toMatchObject({ code: 0, err: "" });
    const player = json(signup) as Schema<"Player">;
    expect(player.username).toBe("Ada_Bot");

    const login = await server.cli(["auth", "login", "ada_bot", "--password-stdin", "--key-name", "laptop", "--json"], pw);
    expect(login).toMatchObject({ code: 0, err: "" });
    const created = json(login) as Schema<"CreatedApiKey">;
    expect(created.apiKey.name).toBe("laptop");
    expect(created.key).toMatch(/^auk_.{8}\.\.\.$/);

    const profile = (await server.config())?.profiles.default;
    expect(profile).toMatchObject({ server: server.url, apiKeyId: created.apiKey.id, username: "Ada_Bot" });
    const key = await storedKey();
    expect(key.startsWith(created.apiKey.prefix)).toBe(true);
    // The login session was ended: no session is left, even counting those still unexpired.
    expect(server.running.services.db.accounts.deleteExpiredSessions(new Date(8.64e15))).toBe(0);
    expect(server.running.services.db.accounts.listApiKeys(player.id)).toHaveLength(1);

    const whoami = await cli("auth", "whoami");
    expect(whoami).toMatchObject({ code: 0, err: "" });
    expect(whoami.out).toContain(`Ada_Bot (Player ${player.id}) on ${server.url}`);
    expect(whoami.out).toContain("API key from profile default");
    expect(json(await cli("auth", "whoami", "--json"))).toEqual(player);

    const logout = await cli("auth", "logout");
    expect(logout).toMatchObject({ code: 0, err: "" });
    expect(logout.out).toBe(`Revoked API key ${created.apiKey.id} and removed it from profile default.`);
    expect((await server.config())?.profiles.default).toEqual({ server: server.url });

    // The key no longer works, and there is nothing left to log out.
    const revoked = await server.cli(["auth", "whoami", "--json"], { env: { POSITRONTANKS_API_KEY: key } });
    expect(revoked.code).toBe(3);
    expect(errorOf(revoked).code).toBe("unauthorized");
    expect(await cli("auth", "logout")).toMatchObject({ code: 3, out: "" });
  });

  it("names the key after the host by default, and prints the login in human output", async () => {
    expect((await server.cli(["auth", "signup", "ada", "--password-stdin"], pw)).code).toBe(0);
    expect(await server.cli(["auth", "signup", "ADA", "--password-stdin"], pw)).toMatchObject({ code: 1, err: 'positrontanks: username_taken: The username "ADA" is already taken' });
    const login = await server.cli(["auth", "login", "ada", "--password-stdin"], pw);
    expect(login.out).toContain(`Logged in as ada on ${server.url}.`);
    expect(login.out).toMatch(/Stored API key \S+ \("positrontanks-cli on .+"\) in profile default\./);
  });

  it("asks for the password on the terminal, and refuses to without one", async () => {
    const signup = await server.cli(["auth", "signup", "ada"], { answers: [PASSWORD] });
    expect(signup.code).toBe(0);
    expect((await server.cli(["auth", "login", "ada"], { answers: [PASSWORD] })).code).toBe(0);

    const noTerminal = await cli("auth", "login", "ada");
    expect(noTerminal.code).toBe(2);
    expect(noTerminal.err).toContain("positrontanks: usage: there is no terminal to ask on; give it with --password-stdin");
  });

  it("reports a wrong password as not authenticated, storing nothing", async () => {
    await server.cli(["auth", "signup", "ada", "--password-stdin"], pw);
    const login = await server.cli(["auth", "login", "ada", "--password-stdin"], { stdin: "wrong password" });
    expect(login).toMatchObject({ code: 3, out: "", err: "positrontanks: invalid_credentials: The username or password is incorrect" });
    expect(await server.config()).toBeUndefined();
  });

  it("forgets a key that was revoked elsewhere on logout", async () => {
    await loggedIn();
    const id = (await server.config())?.profiles.default?.apiKeyId ?? "";
    const other = (json(await cli("keys", "create", "other", "--json")) as Schema<"CreatedApiKey">).key;
    expect((await server.cli(["api", "DELETE", `/api-keys/${id}`], { env: { POSITRONTANKS_API_KEY: other } })).code).toBe(0);
    const logout = await cli("auth", "logout");
    expect(logout).toMatchObject({ code: 0, out: `API key ${id} was already revoked; removed it from profile default.` });
    expect((await server.config())?.profiles.default).toEqual({ server: server.url });
  });

  it("stores an existing key with use-key, finding its id", async () => {
    await loggedIn();
    const created = json(await cli("keys", "create", "ci", "--json")) as Schema<"CreatedApiKey">;
    const use = await server.cli(["auth", "use-key", "--api-key-stdin", "--profile", "ci", "--json"], { stdin: `${created.key}\n` });
    expect(use).toMatchObject({ code: 0 });
    expect((json(use) as Schema<"Player">).username).toBe("ada");
    expect((await server.config())?.profiles.ci).toEqual({ server: server.url, apiKey: created.key, apiKeyId: created.apiKey.id, username: "ada" });

    const prompted = await server.cli(["auth", "use-key", "--profile", "other"], { answers: [created.key] });
    expect(prompted.out).toBe(`Stored API key ${created.apiKey.id} of ada in profile other.`);

    const bad = await server.cli(["auth", "use-key", "--api-key-stdin", "--profile", "bad"], { stdin: "auk_nonsense" });
    expect(bad.code).toBe(3);
    expect((await server.config())?.profiles.bad).toBeUndefined();
  });
});

describe("keys", () => {
  it("creates, lists and revokes API keys", async () => {
    await loggedIn();
    const create = await cli("keys", "create", "ci");
    expect(create.code).toBe(0);
    const [headline, key] = create.out.split("\n");
    expect(headline).toMatch(/^Created API key \S+ \("ci"\)\. The key, shown only this once:$/);
    expect(key).toMatch(/^auk_/);

    const list = json(await cli("keys", "list", "--json")) as Schema<"ApiKeyList">;
    expect(list.apiKeys.map((k) => k.name)).toEqual([expect.stringMatching(/^positrontanks-cli on /), "ci"]);
    const human = await cli("keys", "list");
    const own = (await server.config())?.profiles.default?.apiKeyId ?? "";
    expect(human.out).toMatch(new RegExp(`^\\* +${own} +positrontanks-cli on `, "m"));
    expect(human.out).toMatch(/^ +\S+ +ci +auk_\S+\.\.\. +just now +never$/m);

    const ci = list.apiKeys[1]?.id ?? "";
    const revoke = await cli("keys", "revoke", ci, "--json");
    expect(revoke).toMatchObject({ code: 0, out: "{}" });
    expect((json(await cli("keys", "list", "--json")) as Schema<"ApiKeyList">).apiKeys).toHaveLength(1);
    expect(await server.cli(["auth", "whoami"], { env: { POSITRONTANKS_API_KEY: key ?? "" } })).toMatchObject({ code: 3 });
    expect((await cli("keys", "revoke", ci)).code).toBe(1);
  });

  it("forgets the profile's own key when it is revoked", async () => {
    await loggedIn();
    const id = (await server.config())?.profiles.default?.apiKeyId ?? "";
    const revoke = await cli("keys", "revoke", id);
    expect(revoke.out).toBe(`Revoked API key ${id}. It was profile default's key; removed it from the profile.`);
    expect((await server.config())?.profiles.default).toEqual({ server: server.url });
  });
});

describe("credentials", () => {
  it("fails with exit code 3 before sending anything when there is no key", async () => {
    const run = await cli("keys", "list");
    expect(run).toMatchObject({ code: 3, out: "" });
    expect(run.err).toMatch(/^positrontanks: not_authenticated: No API key/);
    const asJson = await server.cli(["keys", "list"], { env: { POSITRONTANKS_OUTPUT: "json" } });
    expect(errorOf(asJson).code).toBe("not_authenticated");
  });

  it("takes the key from the environment or stdin before the profile, and never stores it", async () => {
    await loggedIn("ada");
    const ada = await storedKey();
    await server.cli(["auth", "signup", "bob", "--password-stdin"], pw);
    await server.cli(["auth", "login", "bob", "--password-stdin", "--profile", "bob"], pw);
    const bob = await storedKey("bob");

    const whoami = async (options: Parameters<TestServer["cli"]>[1], ...argv: string[]) =>
      (json(await server.cli(["auth", "whoami", "--json", ...argv], options)) as Schema<"Player">).username;
    expect(await whoami({})).toBe("ada");
    expect(await whoami({ env: { POSITRONTANKS_API_KEY: bob } })).toBe("bob");
    expect(await whoami({ stdin: bob }, "--api-key-stdin")).toBe("bob");
    expect(await whoami({ stdin: ada, env: { POSITRONTANKS_API_KEY: bob } }, "--api-key-stdin")).toBe("ada");
    expect(await whoami({ env: { POSITRONTANKS_PROFILE: "bob" } })).toBe("bob");
    expect(await whoami({ env: { POSITRONTANKS_PROFILE: "bob" } }, "--profile", "default")).toBe("ada");
    expect(JSON.stringify(await server.config())).not.toContain("POSITRONTANKS");
  });

  it("refuses two options reading stdin", async () => {
    const run = await server.cli(["auth", "login", "ada", "--password-stdin", "--api-key-stdin"], { stdin: "x" });
    expect(run.code).toBe(2);
    expect(run.err).toContain("--api-key-stdin and --password-stdin cannot both read stdin");
  });
});

describe("errors and exit codes", () => {
  it("prints the server's error with its details, in human and JSON output", async () => {
    const human = await server.cli(["auth", "signup", "ab", "--password-stdin"], pw);
    expect(human).toMatchObject({ code: 1, out: "" });
    expect(human.err.split("\n")).toEqual(["positrontanks: validation_failed: The request is not valid", "  username: must be 3 to 32 letters, digits, '-' or '_'"]);

    const asJson = await server.cli(["auth", "signup", "ab", "--password-stdin", "--json"], pw);
    expect(asJson).toMatchObject({ code: 1, out: "" });
    expect(JSON.parse(asJson.err)).toEqual({
      error: { code: "validation_failed", message: "The request is not valid", details: [{ path: "username", message: "must be 3 to 32 letters, digits, '-' or '_'" }] },
    });
  });

  it("exits 2 for bad usage, in the error format", async () => {
    expect(await cli("auth")).toMatchObject({ code: 2, out: "" });
    expect((await cli("auth", "fly")).err).toContain('positrontanks: usage: unknown command "auth fly"');
    expect((await cli("auth", "signup")).err).toContain("'positrontanks auth signup' needs USERNAME");
    expect((await cli("auth", "whoami", "extra")).code).toBe(2);
    expect((await cli("auth", "whoami", "--bogus")).code).toBe(2);
    expect(errorOf(await cli("keys", "list", "--bogus", "--json"))).toMatchObject({ code: "usage" });
    expect((await cli("config", "use", "no spaces")).code).toBe(2);
  });

  it("exits 4 when the server cannot be reached", async () => {
    const run = await cli("server", "health", "--server", "http://127.0.0.1:9");
    expect(run).toMatchObject({ code: 4, out: "" });
    expect(run.err).toMatch(/^positrontanks: network: cannot reach http:\/\/127\.0\.0\.1:9: \S/);
  });

  it("says why localhost cannot be reached, though it resolves to more than one address", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const run = await cli("server", "health", "--server", `http://localhost:${String(port)}`);
    expect(run).toMatchObject({ code: 4, out: "" });
    expect(run.err).toMatch(new RegExp(`^positrontanks: network: cannot reach http://localhost:${String(port)}: \\S`));
  });

  describe("against a server that is not Positron Tanks", () => {
    let other: Server;
    let url: string;
    beforeEach(async () => {
      other = createServer((request, response) => {
        if (request.url === "/health") {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "unavailable", message: "down" } }));
        } else {
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<html></html>");
        }
      });
      await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}`;
    });
    afterEach(async () => {
      await new Promise((resolve) => other.close(resolve));
    });

    it("exits 4 for a 5xx and for a body that is not the expected JSON", async () => {
      expect(await cli("server", "health", "--server", url)).toMatchObject({ code: 4, err: "positrontanks: unavailable: down" });
      const html = await cli("server", "info", "--server", url, "--json");
      expect(html.code).toBe(4);
      expect(errorOf(html).code).toBe("bad_response");
    });
  });
});

describe("server", () => {
  it("shows the server's features, health and OpenAPI document", async () => {
    expect(await cli("server", "info")).toMatchObject({ code: 0, out: `Server ${server.url}\nFeatures:\n  tickCostCheck  off` });
    expect(json(await cli("server", "info", "--json"))).toEqual({ features: { tickCostCheck: false } });
    expect(await cli("server", "health")).toMatchObject({ code: 0, out: `${server.url}: ok` });
    expect(json(await cli("server", "health", "--json"))).toEqual({ status: "ok" });

    const document = json(await cli("server", "openapi")) as { openapi: string };
    expect(document.openapi).toBe("3.1.0");
    const file = join(server.configFile, "..", "..", "..", "openapi.json");
    const saved = await cli("server", "openapi", "--out", file);
    expect(saved.out).toBe(`Wrote the OpenAPI document of ${server.url} to ${file}.`);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(document);
    expect(json(await cli("server", "openapi", "--out", file, "--json"))).toEqual({});
  });
});

describe("config", () => {
  it("behaves as one default profile with no config file", async () => {
    const show = json(await server.cli(["config", "show", "--json"], { env: { POSITRONTANKS_SERVER: "" } })) as Record<string, unknown>;
    expect(show).toEqual({
      profile: "default",
      configFile: server.configFile,
      server: "http://localhost:8080",
      serverFrom: "default",
      apiKey: null,
      apiKeyFrom: null,
      apiKeyId: null,
      username: null,
    });
    expect(json(await cli("config", "profiles", "--json"))).toEqual({ currentProfile: "default", profiles: [{ name: "default", current: true }] });
    expect(await server.config()).toBeUndefined();
  });

  it("switches, sets, lists and removes profiles", async () => {
    await loggedIn();
    const use = await cli("config", "use", "hosted");
    expect(use.out).toBe("Now using profile hosted (new: server http://localhost:8080 until 'positrontanks config set server URL').");
    const set = await server.cli(["config", "set", "server", "https://positrontanks.example.com/"], { env: { POSITRONTANKS_SERVER: "" } });
    expect(set.out).toBe("Profile hosted now uses server https://positrontanks.example.com.");
    expect((await cli("config", "set", "colour", "blue")).code).toBe(2);
    expect((await cli("config", "set", "server", "ftp://x")).code).toBe(2);

    const show = await server.cli(["config", "show"], { env: { POSITRONTANKS_SERVER: "" } });
    expect(show.out).toContain("server:       https://positrontanks.example.com (from profile)");
    expect(show.out).toContain("API key:      none");

    const key = await storedKey();
    const profiles = json(await cli("config", "profiles", "--json")) as { currentProfile: string; profiles: { name: string; current: boolean; apiKey?: string }[] };
    expect(profiles.currentProfile).toBe("hosted");
    expect(profiles.profiles.map((p) => [p.name, p.current])).toEqual([
      ["default", false],
      ["hosted", true],
    ]);
    expect(profiles.profiles[0]?.apiKey).toBe(`${key.slice(0, 12)}...`);
    expect((await cli("config", "profiles")).out).toMatch(/^\* +hosted +https:\/\/positrontanks\.example\.com$/m);

    const remove = await cli("config", "remove", "default");
    expect(remove.out).toContain("Removed profile default.\nIts API key");
    expect(await server.config()).toEqual({ currentProfile: "hosted", profiles: { hosted: { server: "https://positrontanks.example.com" } } });
    expect((await cli("config", "remove", "default")).code).toBe(1);
    await cli("config", "remove", "hosted");
    expect(await server.config()).toEqual({ profiles: {} });
  });

  it("masks the API key and says where each setting comes from", async () => {
    await loggedIn();
    const key = await storedKey();
    const show = json(await cli("config", "show", "--json")) as Record<string, unknown>;
    expect(show).toMatchObject({ server: server.url, serverFrom: "environment", apiKey: `${key.slice(0, 12)}...`, apiKeyFrom: "profile", username: "ada" });
    expect(JSON.stringify(show)).not.toContain(key);
    const option = json(await cli("config", "show", "--json", "--server", "http://example.com:1")) as Record<string, unknown>;
    expect(option).toMatchObject({ server: "http://example.com:1", serverFrom: "option" });
  });

  it.skipIf(process.platform === "win32")("writes the config file readable only by its owner", async () => {
    await cli("config", "use", "x");
    expect((await stat(server.configFile)).mode & 0o777).toBe(0o600);
  });

  it("reports a malformed config file", async () => {
    await cli("config", "use", "x");
    await writeFile(server.configFile, "{ nope");
    const run = await cli("config", "show");
    expect(run.code).toBe(1);
    expect(run.err).toContain(`positrontanks: config: ${server.configFile} is not valid JSON`);
  });
});

describe("api", () => {
  it("sends one request with the profile's credentials and prints the body", async () => {
    await loggedIn();
    const me = await cli("api", "get", "/players/me");
    expect(me.code).toBe(0);
    expect((json(me) as Schema<"Player">).username).toBe("ada");

    const bodyFile = join(server.configFile, "..", "key.json");
    await writeFile(bodyFile, JSON.stringify({ name: "from-api" }));
    const created = await cli("api", "POST", "/api-keys", "--body", bodyFile);
    expect((json(created) as Schema<"CreatedApiKey">).apiKey.name).toBe("from-api");
    const fromStdin = await server.cli(["api", "POST", "/api-keys", "--body", "-"], { stdin: '{"name":"piped"}' });
    expect((json(fromStdin) as Schema<"CreatedApiKey">).apiKey.name).toBe("piped");

    expect(await cli("api", "DELETE", `/api-keys/${(json(created) as Schema<"CreatedApiKey">).apiKey.id}`)).toMatchObject({ code: 0, out: "{}" });
    const docs = await cli("api", "GET", "/rulesets/r1/docs/engine");
    expect(docs.code).toBe(0);
    expect(docs.out.startsWith("#")).toBe(true);

    const missing = await cli("api", "GET", "/nowhere");
    expect(missing).toMatchObject({ code: 1, out: "", err: "positrontanks: not_found: No endpoint at /nowhere" });
  });

  it("passes query parameters and checks its arguments", async () => {
    await loggedIn();
    expect((await cli("api", "GET", "/bot-designs", "--query", "limit=1")).code).toBe(0);
    expect(errorOf(await cli("api", "GET", "/bot-designs", "--query", "limit=0", "--json")).code).toBe("bad_request");
    expect((await cli("api", "GET", "/rulesets", "--query", "limit")).code).toBe(2);
    expect((await cli("api", "FETCH", "/rulesets")).code).toBe(2);
    expect((await cli("api", "GET", "rulesets")).code).toBe(2);
    const badBody = await server.cli(["api", "POST", "/api-keys", "--body", "-"], { stdin: "{" });
    expect(badBody.code).toBe(1);
    expect(badBody.err).toContain("positrontanks: input: stdin is not valid JSON");
  });
});

describe("paging", () => {
  const noArmor = { front: null, left: null, right: null, rear: null };
  const build = { chassis: "scout", components: { gun: "pelletGun", eye: "radar", drive: "wheels" }, armor: noArmor };

  it("fetches one page, or follows nextCursor to the end with all", async () => {
    await loggedIn();
    const client = new ApiClient(server.url, await storedKey());
    for (const name of ["A", "B", "C"]) {
      await client.request("POST", "/bot-designs", { body: { name, rulesetVersion: "r1", build, program: "function tick() {}" } });
    }
    type Designs = { botDesigns: { name: string }[] };
    const first = await fetchList<"botDesigns", Designs["botDesigns"][number]>(client, "/bot-designs", "botDesigns", { limit: 2, all: false });
    expect(first.botDesigns).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const rest = await fetchList(client, "/bot-designs", "botDesigns", { limit: 2, cursor: first.nextCursor ?? "", all: false });
    expect(rest).toMatchObject({ nextCursor: null });
    const all = await fetchList<"botDesigns", { name: string }>(client, "/bot-designs", "botDesigns", { limit: 1, all: true });
    expect(all.botDesigns.map((d) => d.name).sort()).toEqual(["A", "B", "C"]);
    expect(all.nextCursor).toBeNull();
  });
});

describe("help", () => {
  it("lists the server commands in the top-level help, and each group's and command's usage", async () => {
    expect((await cli("--help")).out).toContain("positrontanks auth login USERNAME [--password-stdin] [--key-name NAME]");
    const group = await cli("keys", "--help");
    expect(group.code).toBe(0);
    expect(group.out).toContain("positrontanks keys revoke KEY_ID");
    expect(group.out).not.toContain("positrontanks auth");
    const command = await cli("api", "--help");
    expect(command.out).toMatch(/^Usage: positrontanks api METHOD PATH \[--body FILE\] \[--query KEY=VALUE \.\.\.\]/);
    expect(command.out).toContain("3 not authenticated");
  });
});
