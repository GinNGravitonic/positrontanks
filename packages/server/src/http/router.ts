/**
 * Routes and their registration.
 *
 * Each feature area (accounts, Rulesets, Garage, Maps, Games, ...) is an
 * ApiModule: a list of routes plus the OpenAPI schemas they reference. A
 * route carries its own OpenAPI operation, so the served document is built
 * from exactly the routes that are registered and cannot drift from them.
 *
 * Paths use OpenAPI template syntax (`/games/{gameId}`); a `{name}` segment
 * matches any one non-empty segment and is passed to the handler decoded.
 */

import type { IncomingMessage } from "node:http";
import type { ServerConfig } from "../config.js";
import type { Database } from "../db/database.js";
import type { RulesetCatalog } from "../rulesets/catalog.js";
import { badRequest } from "./errors.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** An OpenAPI 3.1 Operation Object, minus the parts the router fills in. */
export interface Operation {
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly Json[];
  readonly requestBody?: Json;
  /** Success (and expected error) responses; a default error response is added. */
  readonly responses: Readonly<Record<string, Json>>;
  readonly security?: readonly Json[];
}

/** What every handler can reach. Later tasks add object storage, the Game runner, etc. */
export interface Services {
  readonly config: ServerConfig;
  readonly db: Database;
  /** The Ruleset versions this server hosts. */
  readonly rulesets: RulesetCatalog;
  /** The current time; injectable so tests can move it (e.g. past a fill timeout). */
  readonly clock: () => Date;
}

export interface RequestContext {
  readonly request: IncomingMessage;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly services: Services;
  /** Reads and parses a JSON body, enforcing the content type and size limit. */
  readonly readJson: () => Promise<unknown>;
}

export interface Reply {
  /** Defaults to 200, or 204 when there is no body. */
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type Handler = (context: RequestContext) => Reply | Promise<Reply>;

export interface Route {
  readonly method: Method;
  readonly path: string;
  readonly operation: Operation;
  readonly handler: Handler;
}

export interface ApiModule {
  readonly tags?: readonly { readonly name: string; readonly description: string }[];
  /** Component schemas, referenced as `#/components/schemas/<name>`. */
  readonly schemas?: Readonly<Record<string, Json>>;
  readonly routes: readonly Route[];
}

export type Match =
  | { readonly kind: "found"; readonly route: Route; readonly params: Record<string, string> }
  | { readonly kind: "wrong-method"; readonly allowed: readonly Method[] }
  | { readonly kind: "none" };

type Segment = { readonly literal: string } | { readonly param: string };

interface Compiled {
  readonly route: Route;
  readonly segments: readonly Segment[];
}

const PARAM = /^\{([A-Za-z][A-Za-z0-9]*)\}$/;

export class Router {
  readonly #routes: Compiled[] = [];

  constructor(routes: readonly Route[]) {
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (const route of routes) {
      if (!route.path.startsWith("/")) throw new Error(`Route path must start with "/": ${route.path}`);
      const segments = split(route.path).map((s): Segment => {
        const m = PARAM.exec(s);
        if (m?.[1] !== undefined) return { param: m[1] };
        if (s.includes("{") || s.includes("}")) throw new Error(`Bad path segment "${s}" in ${route.path}`);
        return { literal: s };
      });
      // Two routes differing only in parameter names would be ambiguous.
      const shape = `${route.method} /${segments.map((s) => ("param" in s ? "{}" : s.literal)).join("/")}`;
      if (seen.has(shape)) throw new Error(`Duplicate route ${route.method} ${route.path}`);
      if (ids.has(route.operation.operationId)) {
        throw new Error(`Duplicate operationId ${route.operation.operationId}`);
      }
      seen.add(shape);
      ids.add(route.operation.operationId);
      this.#routes.push({ route, segments });
    }
  }

  match(method: string, pathname: string): Match {
    const parts = split(pathname);
    const allowed: Method[] = [];
    for (const { route, segments } of this.#routes) {
      const params = matchSegments(segments, parts);
      if (params === undefined) continue;
      if (route.method === method) return { kind: "found", route, params };
      allowed.push(route.method);
    }
    return allowed.length > 0 ? { kind: "wrong-method", allowed } : { kind: "none" };
  }
}

/** `/a/b/` and `/a/b` are the same path; empty segments are kept so `//` never matches. */
function split(path: string): string[] {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed === "/" ? [] : trimmed.slice(1).split("/");
}

function matchSegments(segments: readonly Segment[], parts: readonly string[]): Record<string, string> | undefined {
  if (segments.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const part = parts[i];
    if (segment === undefined || part === undefined) return undefined;
    if ("literal" in segment) {
      if (segment.literal !== part) return undefined;
    } else {
      if (part === "") return undefined;
      try {
        params[segment.param] = decodeURIComponent(part);
      } catch {
        throw badRequest(`Malformed path parameter "${segment.param}"`);
      }
    }
  }
  return params;
}
