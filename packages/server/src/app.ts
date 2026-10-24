/**
 * The HTTP application: routing, the error format, and server lifecycle.
 *
 * New feature areas are added to `apiModules` below (or passed in via
 * `modules`, as tests do). Handlers return a Reply or throw an ApiError; any
 * other exception is logged and answered with a generic 500 so internals
 * never leak to clients.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "./config.js";
import { Database } from "./db/database.js";
import { readJsonBody } from "./http/body.js";
import { ApiError, notFound } from "./http/errors.js";
import { buildOpenApiDocument } from "./http/openapi.js";
import { Router, type ApiModule, type Json, type Reply, type Services } from "./http/router.js";
import { accountsModule } from "./routes/accounts.js";
import { garageModule } from "./routes/garage.js";
import { systemModule } from "./routes/system.js";
import { defaultRulesetCatalog, type RulesetCatalog } from "./rulesets/catalog.js";

/** The feature areas served in production, besides the system endpoints. */
export const apiModules: readonly ApiModule[] = [accountsModule, garageModule];

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
}

export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

/** Builds the request listener; the caller owns `services` (opening and closing the database). */
export function createApp(services: Services, options: AppOptions = {}): RequestListener {
  const logger = options.logger ?? jsonLogger;
  // The system module serves the document built from all modules, itself included.
  const modules = [systemModule(() => document), ...(options.modules ?? apiModules)];
  const document: Json = buildOpenApiDocument(modules);
  const router = new Router(modules.flatMap((m) => m.routes));

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
        send(response, reply);
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

export interface RunningServer {
  /** Base URL, e.g. `http://127.0.0.1:8080`. */
  readonly url: string;
  readonly server: Server;
  readonly services: Services;
  /** Stops accepting connections, waits for in-flight requests, then closes the database. */
  close(): Promise<void>;
}

/** Opens the database (running migrations) and starts listening. */
export async function startServer(config: ServerConfig, options: AppOptions = {}): Promise<RunningServer> {
  const rulesets = options.rulesets ?? defaultRulesetCatalog();
  const db = Database.open(config.databasePath);
  const services: Services = { config, db, rulesets };
  const server = createServer(createApp(services, options));
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

  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${String(address.port)}`,
    server,
    services,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      db.close();
    },
  };
}
