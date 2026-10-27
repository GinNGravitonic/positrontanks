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
  /**
   * Most unsent bytes an event stream may hold for a client that reads too
   * slowly; past it the stream is dropped and the client reconnects.
   */
  readonly maxEventStreamBufferBytes: number;
}

/** Where blobs (Game Records, Replays, images) are kept; see storage/. */
export type StorageConfig =
  | {
      readonly kind: "local";
      /** Directory holding one file per object. */
      readonly directory: string;
    }
  | {
      readonly kind: "s3";
      readonly bucket: string;
      /** Prepended to every object key; empty or ending in `/`. */
      readonly keyPrefix: string;
      /** Unset uses the AWS SDK's default region resolution. */
      readonly region?: string;
      /** Custom endpoint (e.g. an S3-compatible emulator); uses path-style addressing. */
      readonly endpoint?: string;
    };

export interface ServerConfig {
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  /** SQLite file path, or `:memory:` for a throwaway database. */
  readonly databasePath: string;
  readonly storage: StorageConfig;
  /**
   * Continuous replication of the database by Litestream (ADR-0003). Unset
   * means no replication. The server itself does not replicate: the Docker
   * entrypoint reads the same variable and runs the server under
   * `litestream replicate -exec`, restoring from the replica first if the
   * database file is missing. Validated here so a bad value fails at startup.
   */
  readonly litestream?: LitestreamConfig;
  readonly limits: Limits;
  readonly features: Features;
}

/** Optional features, each off unless the server enables it. */
export interface Features {
  /**
   * The tick cost check (`AUMOHTA_TICK_COST_CHECK=on`). One check runs up to
   * ~100 Ticks of `tick()` synchronously, so it is meant for local servers,
   * where a Player's checks only load their own machine; shared deployments
   * leave it off.
   */
  readonly tickCostCheck: boolean;
}

export interface LitestreamConfig {
  /** Litestream replica URL, e.g. `s3://bucket/path` or `file:///backups/aumohta`. */
  readonly replicaUrl: string;
}

export const defaultConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 8080,
  databasePath: "data/aumohta.db",
  storage: { kind: "local", directory: "data/objects" },
  limits: {
    maxRequestBodyBytes: 1024 * 1024,
    map: { maxWidth: 200, maxHeight: 200, maxPolygonPoints: 64, maxFeatures: 100 },
    maxTimeLimitSeconds: 600,
    maxFillTimeoutSeconds: 24 * 60 * 60,
    maxConcurrentUnthrottledGames: 2,
    maxEventStreamBufferBytes: 1024 * 1024,
  },
  features: { tickCostCheck: false },
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

  const flag = (name: string, fallback: boolean): boolean => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (raw === "on" || raw === "off") return raw === "on";
    problems.push(`${name} must be "on" or "off", got "${raw}"`);
    return fallback;
  };

  const optional = (name: string): string | undefined => {
    const raw = env[name];
    return raw === undefined || raw.trim() === "" ? undefined : raw;
  };

  const storage = (): StorageConfig => {
    const kind = env.AUMOHTA_STORAGE ?? d.storage.kind;
    if (kind === "s3") {
      const bucket = optional("AUMOHTA_S3_BUCKET");
      if (bucket === undefined) problems.push(`AUMOHTA_S3_BUCKET is required when AUMOHTA_STORAGE is "s3"`);
      const keyPrefix = env.AUMOHTA_S3_KEY_PREFIX ?? "";
      if (keyPrefix !== "" && !keyPrefix.endsWith("/")) {
        problems.push(`AUMOHTA_S3_KEY_PREFIX must be empty or end with "/", got "${keyPrefix}"`);
      }
      const region = optional("AUMOHTA_S3_REGION");
      const endpoint = optional("AUMOHTA_S3_ENDPOINT");
      return {
        kind: "s3",
        bucket: bucket ?? "",
        keyPrefix,
        ...(region === undefined ? {} : { region }),
        ...(endpoint === undefined ? {} : { endpoint }),
      };
    }
    if (kind !== "local") problems.push(`AUMOHTA_STORAGE must be "local" or "s3", got "${kind}"`);
    return { kind: "local", directory: string("AUMOHTA_STORAGE_DIRECTORY", "data/objects") };
  };

  const litestream = (databasePath: string): LitestreamConfig | undefined => {
    const replicaUrl = optional("AUMOHTA_LITESTREAM_REPLICA_URL");
    if (replicaUrl === undefined) return undefined;
    if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(replicaUrl) || !URL.canParse(replicaUrl)) {
      problems.push(`AUMOHTA_LITESTREAM_REPLICA_URL must be a URL such as s3://bucket/path, got "${replicaUrl}"`);
    }
    if (databasePath === ":memory:") {
      problems.push(`AUMOHTA_LITESTREAM_REPLICA_URL cannot be used with an in-memory database`);
    }
    return { replicaUrl };
  };

  const databasePath = string("AUMOHTA_DATABASE_PATH", d.databasePath);
  const replication = litestream(databasePath);
  const config: ServerConfig = {
    host: string("AUMOHTA_HOST", d.host),
    port: integer("AUMOHTA_PORT", d.port, 0, 65535),
    databasePath,
    storage: storage(),
    ...(replication === undefined ? {} : { litestream: replication }),
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
      maxEventStreamBufferBytes: integer(
        "AUMOHTA_MAX_EVENT_STREAM_BUFFER_BYTES",
        l.maxEventStreamBufferBytes,
        1,
      ),
    },
    features: { tickCostCheck: flag("AUMOHTA_TICK_COST_CHECK", d.features.tickCostCheck) },
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
