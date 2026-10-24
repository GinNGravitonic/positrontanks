import { describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("uses the defaults for an empty environment", () => {
    expect(loadConfig({})).toEqual(defaultConfig);
  });

  it("reads overrides", () => {
    const config = loadConfig({
      AUMOHTA_HOST: "0.0.0.0",
      AUMOHTA_PORT: "3000",
      AUMOHTA_DATABASE_PATH: "/data/db.sqlite",
      AUMOHTA_MAX_MAP_WIDTH: "500",
      AUMOHTA_MAX_UNTHROTTLED_GAMES: "0",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.databasePath).toBe("/data/db.sqlite");
    expect(config.limits.map.maxWidth).toBe(500);
    expect(config.limits.map.maxHeight).toBe(defaultConfig.limits.map.maxHeight);
    expect(config.limits.maxConcurrentUnthrottledGames).toBe(0);
  });

  it("reports every invalid value at once", () => {
    let error: unknown;
    try {
      loadConfig({ AUMOHTA_PORT: "70000", AUMOHTA_MAX_TIME_LIMIT_SECONDS: "1.5", AUMOHTA_HOST: " " });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toHaveLength(3);
    expect((error as ConfigError).message).toContain("AUMOHTA_PORT");
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
      expect(loadConfig({ AUMOHTA_STORAGE_DIRECTORY: "/srv/objects" }).storage).toEqual({
        kind: "local",
        directory: "/srv/objects",
      });
    });

    it("reads S3 settings", () => {
      expect(loadConfig({ AUMOHTA_STORAGE: "s3", AUMOHTA_S3_BUCKET: "aumohta" }).storage).toEqual({
        kind: "s3",
        bucket: "aumohta",
        keyPrefix: "",
      });
      expect(
        loadConfig({
          AUMOHTA_STORAGE: "s3",
          AUMOHTA_S3_BUCKET: "aumohta",
          AUMOHTA_S3_KEY_PREFIX: "objects/",
          AUMOHTA_S3_REGION: "eu-west-1",
          AUMOHTA_S3_ENDPOINT: "http://127.0.0.1:9000",
        }).storage,
      ).toEqual({
        kind: "s3",
        bucket: "aumohta",
        keyPrefix: "objects/",
        region: "eu-west-1",
        endpoint: "http://127.0.0.1:9000",
      });
    });

    it("reports invalid storage settings", () => {
      expect(problems({ AUMOHTA_STORAGE: "ftp" })).toHaveLength(1);
      expect(problems({ AUMOHTA_STORAGE: "s3" })).toEqual([expect.stringContaining("AUMOHTA_S3_BUCKET")]);
      expect(problems({ AUMOHTA_STORAGE: "s3", AUMOHTA_S3_BUCKET: "b", AUMOHTA_S3_KEY_PREFIX: "objects" })).toEqual([
        expect.stringContaining("AUMOHTA_S3_KEY_PREFIX"),
      ]);
    });
  });
});
