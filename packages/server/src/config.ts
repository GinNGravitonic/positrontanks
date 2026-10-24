/**
 * Server configuration (spec section 10).
 *
 * Everything is read from `AUMOHTA_*` environment variables; anything unset
 * takes the conservative default below. Invalid values are collected and
 * reported together so a misconfigured deployment fails once, at startup,
 * with every problem listed.
 */

/** Server-wide limits. Map limits match ruleset-data's MapLimits. */
export interface Limits {
  /** Largest accepted request body. */
  readonly maxRequestBodyBytes: number;
  readonly map: {
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly maxPolygonPoints: number;
    /** Combined count of Terrain Regions, Obstacles and Spawn Zones. */
    readonly maxFeatures: number;
  };
  /** Longest Game time limit an Initiator may choose, in simulated seconds. */
  readonly maxTimeLimitSeconds: number;
  /** Longest fill timeout an Initiator may choose, in real seconds. */
  readonly maxFillTimeoutSeconds: number;
  /** Unthrottled Games allowed to run at once. */
  readonly maxConcurrentUnthrottledGames: number;
}

export interface ServerConfig {
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  /** SQLite file path, or `:memory:` for a throwaway database. */
  readonly databasePath: string;
  readonly limits: Limits;
}

export const defaultConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 8080,
  databasePath: "data/aumohta.db",
  limits: {
    maxRequestBodyBytes: 1024 * 1024,
    map: { maxWidth: 200, maxHeight: 200, maxPolygonPoints: 64, maxFeatures: 100 },
    maxTimeLimitSeconds: 600,
    maxFillTimeoutSeconds: 24 * 60 * 60,
    maxConcurrentUnthrottledGames: 2,
  },
};

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid server configuration:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Builds the configuration from `env`, throwing a ConfigError listing every invalid variable. */
export function loadConfig(env: Env): ServerConfig {
  const problems: string[] = [];
  const d = defaultConfig;
  const l = d.limits;

  const string = (name: string, fallback: string): string => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (raw.trim() === "") {
      problems.push(`${name} must not be empty`);
      return fallback;
    }
    return raw;
  };

  const integer = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${String(min)} to ${String(max)}, got "${raw}"`);
      return fallback;
    }
    return value;
  };

  const config: ServerConfig = {
    host: string("AUMOHTA_HOST", d.host),
    port: integer("AUMOHTA_PORT", d.port, 0, 65535),
    databasePath: string("AUMOHTA_DATABASE_PATH", d.databasePath),
    limits: {
      maxRequestBodyBytes: integer("AUMOHTA_MAX_REQUEST_BODY_BYTES", l.maxRequestBodyBytes, 1),
      map: {
        maxWidth: integer("AUMOHTA_MAX_MAP_WIDTH", l.map.maxWidth, 1),
        maxHeight: integer("AUMOHTA_MAX_MAP_HEIGHT", l.map.maxHeight, 1),
        maxPolygonPoints: integer("AUMOHTA_MAX_MAP_POLYGON_POINTS", l.map.maxPolygonPoints, 3),
        maxFeatures: integer("AUMOHTA_MAX_MAP_FEATURES", l.map.maxFeatures, 1),
      },
      maxTimeLimitSeconds: integer("AUMOHTA_MAX_TIME_LIMIT_SECONDS", l.maxTimeLimitSeconds, 1),
      maxFillTimeoutSeconds: integer("AUMOHTA_MAX_FILL_TIMEOUT_SECONDS", l.maxFillTimeoutSeconds, 1),
      maxConcurrentUnthrottledGames: integer(
        "AUMOHTA_MAX_UNTHROTTLED_GAMES",
        l.maxConcurrentUnthrottledGames,
        0,
      ),
    },
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
