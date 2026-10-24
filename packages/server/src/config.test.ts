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
});
