/**
 * The HTTP application: routing, the error format, and server lifecycle.
 *
 * New feature areas are added to `apiModules` below (or passed in via
 * `modules`, as tests do). Handlers return a Reply or throw an ApiError; any
 * other exception is logged and answered with a generic 500 so internals
 * never leak to clients. A Reply may instead stream Server-Sent Events
 * (http/events.ts); streams are cut short when the server shuts down, so
 * they never hold it open.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "./config.js";
import { Database } from "./db/database.js";
import { GameRunner, type Pacing } from "./games/runner.js";
import { readJsonBody } from "./http/body.js";
import { ApiError, notFound } from "./http/errors.js";
import { formatEvent, SSE_HEARTBEAT_MS, type EventStream } from "./http/events.js";
import { buildOpenApiDocument } from "./http/openapi.js";
import { Router, type ApiModule, type Json, type Reply, type Services } from "./http/router.js";
import { accountsModule } from "./routes/accounts.js";
import { gamesModule } from "./routes/games.js";
import { garageModule } from "./routes/garage.js";
import { mapsModule } from "./routes/maps.js";
import { rulesetsModule } from "./routes/rulesets.js";
import { spectatingModule } from "./routes/spectating.js";
import { systemModule } from "./routes/system.js";
import { tickCostModule } from "./routes/tick-cost.js";
import { defaultRulesetCatalog, type RulesetCatalog } from "./rulesets/catalog.js";
import { createObjectStore } from "./storage/create.js";
import type { ObjectStore } from "./storage/object-store.js";

/** The feature areas served in production, besides the system endpoints. */
export const apiModules: readonly ApiModule[] = [
  accountsModule,
  garageModule,
  tickCostModule,
  mapsModule,
  rulesetsModule,
  gamesModule,
  spectatingModule,
];

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** One JSON object per line on stdout/stderr. */
export const jsonLogger: Logger = {
  info: (message, fields) => {
    process.stdout.write(`${JSON.stringify({ level: "info", time: new Date().toISOString(), message, ...fields })}\n`);
  },
  error: (message, fields) => {
    process.stderr.write(`${JSON.stringify({ level: "error", time: new Date().toISOString(), message, ...fields })}\n`);
  },
};

export interface AppOptions {
  readonly modules?: readonly ApiModule[];
  readonly logger?: Logger;
  /** The hosted Ruleset versions; defaults to every version ruleset-data ships. */
  readonly rulesets?: RulesetCatalog;
  /** The current time; defaults to the system clock. */
  readonly clock?: () => Date;
  /** Blob storage; defaults to the store `config.storage` selects. */
  readonly objects?: ObjectStore;
  /** How the Game runner keeps realtime Pace; defaults to real timers. */
  readonly pacing?: Pacing;
  /** Aborted when the server shuts down, cutting every event stream short. */
  readonly closing?: AbortSignal;
}

export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

/** Builds the request listener; the caller owns `services` (opening and closing the database). */
export function createApp(services: Services, options: AppOptions = {}): RequestListener {
  const logger = options.logger ?? jsonLogger;
  // The system module serves the document built from all modules, itself included.
  const modules = [systemModule(() => document), ...(options.modules ?? apiModules)];
  const document: Json = buildOpenApiDocument(modules);
  const router = new Router(modules.flatMap((m) => m.routes));
  const closing = options.closing ?? new AbortController().signal;

  const handle = async (request: IncomingMessage): Promise<Reply> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = router.match(request.method ?? "GET", url.pathname);
    if (match.kind === "none") throw notFound(`No endpoint at ${url.pathname}`);
    if (match.kind === "wrong-method") {
      throw new ApiError(
        405,
        "method_not_allowed",
        `${request.method ?? ""} is not allowed here; use ${match.allowed.join(", ")}`,
        undefined,
        { allow: match.allowed.join(", ") },
      );
    }
    return match.route.handler({
      request,
      url,
      params: match.params,
      services,
      readJson: () => readJsonBody(request, services.config.limits.maxRequestBodyBytes),
    });
  };

  return (request, response) => {
    handle(request)
      .catch((error: unknown): Reply => {
        if (error instanceof ApiError) return error.toReply();
        logger.error("Unhandled error", {
          method: request.method,
          url: request.url,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        return new ApiError(500, "internal_error", "Internal server error").toReply();
      })
      .then((reply) => {
        if (reply.events === undefined) send(response, reply);
        else stream(response, reply, reply.events, closing);
      })
      .catch((error: unknown) => {
        logger.error("Failed to send response", { error: String(error) });
        response.destroy();
      });
  };
}

function send(response: ServerResponse, reply: Reply): void {
  const hasBody = reply.body !== undefined;
  const status = reply.status ?? (hasBody ? 200 : 204);
  const payload = hasBody ? JSON.stringify(reply.body) : undefined;
  response.writeHead(status, {
    ...(payload === undefined
      ? {}
      : { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) }),
    ...reply.headers,
  });
  response.end(payload);
}

function stream(response: ServerResponse, reply: Reply, events: EventStream, closing: AbortSignal): void {
  response.writeHead(reply.status ?? 200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    // Tells nginx-style proxies not to buffer the stream.
    "x-accel-buffering": "no",
    ...reply.headers,
  });
  response.flushHeaders();
  let open = true;
  let cancel = (): void => undefined;
  const heartbeat = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();
  const finish = (): void => {
    open = false;
    clearInterval(heartbeat);
    response.off("close", cutShort);
    closing.removeEventListener("abort", cutShort);
    response.end();
  };
  // The client went away, or the server is shutting down.
  const cutShort = (): void => {
    if (!open) return;
    finish();
    cancel();
  };
  response.on("close", cutShort);
  closing.addEventListener("abort", cutShort);
  cancel = events({
    send: (event) => {
      if (open) response.write(formatEvent(event));
    },
    close: () => {
      if (open) finish();
    },
  });
  if (closing.aborted) cutShort();
}

export interface RunningServer {
  /** Base URL, e.g. `http://127.0.0.1:8080`. */
  readonly url: string;
  readonly server: Server;
  readonly services: Services;
  /**
   * Stops accepting connections, ends event streams, waits for in-flight
   * requests, stops the Game runner (Running Games stay Running, to be
   * resumed at the next startup), then closes the database.
   */
  close(): Promise<void>;
}

/** Opens the database (running migrations), starts listening, and resumes every Running Game. */
export async function startServer(config: ServerConfig, options: AppOptions = {}): Promise<RunningServer> {
  const logger = options.logger ?? jsonLogger;
  const rulesets = options.rulesets ?? defaultRulesetCatalog();
  const db = Database.open(config.databasePath);
  const base = {
    config,
    db,
    rulesets,
    clock: options.clock ?? (() => new Date()),
    objects: options.objects ?? createObjectStore(config.storage),
  };
  const runner = new GameRunner(base, { logger, ...options.pacing });
  const services: Services = { ...base, runner };
  const closing = new AbortController();
  const server = createServer(createApp(services, { ...options, closing: closing.signal }));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    db.close();
    throw error;
  }

  runner.pickUp();
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${String(address.port)}`,
    server,
    services,
    close: async () => {
      // Event streams last as long as their Game; end them so the server can close.
      closing.abort();
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeIdleConnections();
        });
      } finally {
        // The runner writes to the database, so it stops first.
        await runner.stop();
        db.close();
      }
    },
  };
}
