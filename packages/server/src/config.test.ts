import { describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("uses the defaults for an empty environment", () => {
    expect(loadConfig({})).toEqual(defaultConfig);
  });

  it("allows the CLI runner's default time limit, so a local Game can be repeated on the server", () => {
    // DEFAULT_TIME_LIMIT_SECONDS in packages/cli/src/cli.ts; see docs/spec/cli-runner.md.
    const cliDefaultTimeLimitSeconds = 120;
    expect(defaultConfig.limits.maxTimeLimitSeconds).toBeGreaterThanOrEqual(cliDefaultTimeLimitSeconds);
  });

  it("reads overrides", () => {
    const config = loadConfig({
      POSITRONTANKS_HOST: "0.0.0.0",
      POSITRONTANKS_PORT: "3000",
      POSITRONTANKS_DATABASE_PATH: "/data/db.sqlite",
      POSITRONTANKS_MAX_MAP_WIDTH: "500",
      POSITRONTANKS_MAX_UNTHROTTLED_GAMES: "0",
      POSITRONTANKS_MAX_EVENT_STREAM_BUFFER_BYTES: "65536",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.databasePath).toBe("/data/db.sqlite");
    expect(config.limits.map.maxWidth).toBe(500);
    expect(config.limits.map.maxHeight).toBe(defaultConfig.limits.map.maxHeight);
    expect(config.limits.maxConcurrentUnthrottledGames).toBe(0);
    expect(config.limits.maxEventStreamBufferBytes).toBe(65536);
  });

  it("reports every invalid value at once", () => {
    let error: unknown;
    try {
      loadConfig({ POSITRONTANKS_PORT: "70000", POSITRONTANKS_MAX_TIME_LIMIT_SECONDS: "1.5", POSITRONTANKS_HOST: " " });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toHaveLength(3);
    expect((error as ConfigError).message).toContain("POSITRONTANKS_PORT");
  });

  describe("storage", () => {
    const problems = (env: Record<string, string>): readonly string[] => {
      try {
        loadConfig(env);
        return [];
      } catch (e) {
        return (e as ConfigError).problems;
      }
    };

    it("defaults to a local directory", () => {
      expect(loadConfig({}).storage).toEqual({ kind: "local", directory: "data/objects" });
      expect(loadConfig({ POSITRONTANKS_STORAGE_DIRECTORY: "/srv/objects" }).storage).toEqual({
        kind: "local",
        directory: "/srv/objects",
      });
    });

    it("reads S3 settings", () => {
      expect(loadConfig({ POSITRONTANKS_STORAGE: "s3", POSITRONTANKS_S3_BUCKET: "positrontanks" }).storage).toEqual({
        kind: "s3",
        bucket: "positrontanks",
        keyPrefix: "",
      });
      expect(
        loadConfig({
          POSITRONTANKS_STORAGE: "s3",
          POSITRONTANKS_S3_BUCKET: "positrontanks",
          POSITRONTANKS_S3_KEY_PREFIX: "objects/",
          POSITRONTANKS_S3_REGION: "eu-west-1",
          POSITRONTANKS_S3_ENDPOINT: "http://127.0.0.1:9000",
        }).storage,
      ).toEqual({
        kind: "s3",
        bucket: "positrontanks",
        keyPrefix: "objects/",
        region: "eu-west-1",
        endpoint: "http://127.0.0.1:9000",
      });
    });

    it("reports invalid storage settings", () => {
      expect(problems({ POSITRONTANKS_STORAGE: "ftp" })).toHaveLength(1);
      expect(problems({ POSITRONTANKS_STORAGE: "s3" })).toEqual([expect.stringContaining("POSITRONTANKS_S3_BUCKET")]);
      expect(problems({ POSITRONTANKS_STORAGE: "s3", POSITRONTANKS_S3_BUCKET: "b", POSITRONTANKS_S3_KEY_PREFIX: "objects" })).toEqual([
        expect.stringContaining("POSITRONTANKS_S3_KEY_PREFIX"),
      ]);
    });
  });

  describe("features", () => {
    it("leaves the tick cost check off unless enabled", () => {
      expect(loadConfig({}).features.tickCostCheck).toBe(false);
      expect(loadConfig({ POSITRONTANKS_TICK_COST_CHECK: "off" }).features.tickCostCheck).toBe(false);
      expect(loadConfig({ POSITRONTANKS_TICK_COST_CHECK: "on" }).features.tickCostCheck).toBe(true);
    });

    it("reports an invalid setting", () => {
      expect(() => loadConfig({ POSITRONTANKS_TICK_COST_CHECK: "yes" })).toThrow(/POSITRONTANKS_TICK_COST_CHECK must be "on" or "off"/);
    });
  });

  describe("litestream", () => {
    const problems = (env: Record<string, string>): readonly string[] => {
      try {
        loadConfig(env);
        return [];
      } catch (e) {
        return (e as ConfigError).problems;
      }
    };

    it("is off unless a replica URL is set", () => {
      expect(loadConfig({}).litestream).toBeUndefined();
      expect(loadConfig({ POSITRONTANKS_LITESTREAM_REPLICA_URL: "" }).litestream).toBeUndefined();
    });

    it("reads the replica URL", () => {
      expect(loadConfig({ POSITRONTANKS_LITESTREAM_REPLICA_URL: "s3://positrontanks-db/prod" }).litestream).toEqual({
        replicaUrl: "s3://positrontanks-db/prod",
      });
      expect(loadConfig({ POSITRONTANKS_LITESTREAM_REPLICA_URL: "file:///backups/positrontanks" }).litestream).toEqual({
        replicaUrl: "file:///backups/positrontanks",
      });
    });

    it("reports an invalid replica URL", () => {
      expect(problems({ POSITRONTANKS_LITESTREAM_REPLICA_URL: "positrontanks-db/prod" })).toEqual([
        expect.stringContaining("POSITRONTANKS_LITESTREAM_REPLICA_URL"),
      ]);
    });

    it("rejects replicating an in-memory database", () => {
      expect(
        problems({ POSITRONTANKS_LITESTREAM_REPLICA_URL: "s3://positrontanks-db/prod", POSITRONTANKS_DATABASE_PATH: ":memory:" }),
      ).toEqual([expect.stringContaining("in-memory")]);
    });
  });
});
