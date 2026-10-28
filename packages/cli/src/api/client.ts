/**
 * The HTTP client for the server commands (docs/spec/cli-api.md, HTTP client
 * and Output): one `send` over Node's `fetch` that sets the base URL, the
 * API key and a 30 s timeout, and turns every failure into a CliError in the
 * server's error format with the spec's exit code.
 *
 * Request and response types come from `schema.ts`, generated from the
 * committed OpenAPI snapshot (`pnpm --filter @aumohta/cli gen:api`).
 */

import type { components } from "./schema.js";

/** A schema of the API, by its name in the OpenAPI document. */
export type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];

export type ErrorBody = Schema<"Error">;
export type ErrorDetail = NonNullable<ErrorBody["error"]["details"]>[number];

/** Exit codes (docs/spec/cli-api.md, Exit codes). */
export const EXIT = {
  ok: 0,
  /** A 4xx response other than 401, or a bad local input file. */
  refused: 1,
  usage: 2,
  /** No credential, or a 401 response. */
  notAuthenticated: 3,
  /** Unreachable server, timeout, 5xx, or a response that is not the expected JSON. Worth retrying. */
  server: 4,
} as const;

/** A failure of a server command: printed in the error format, then the CLI exits with `exitCode`. */
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    readonly code: string,
    message: string,
    readonly details?: readonly ErrorDetail[],
  ) {
    super(message);
    this.name = "CliError";
  }

  get body(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: [...this.details] }) } };
  }
}

export const usageError = (message: string): CliError => new CliError(EXIT.usage, "usage", message);
export const inputError = (message: string): CliError => new CliError(EXIT.refused, "input", message);

export const REQUEST_TIMEOUT_MS = 30_000;

export type Query = Readonly<Record<string, string | number | boolean | undefined>> | readonly (readonly [string, string])[];

export interface RequestOptions {
  readonly query?: Query;
  /** Sent as JSON. */
  readonly body?: unknown;
  /** Fail with exit code 3, before sending, when there is no credential. */
  readonly auth?: boolean;
  /** A credential for this request instead of the client's API key (`auth login`'s session token). */
  readonly token?: string;
}

/** A 2xx response. */
export interface RawResponse {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
}

export const NOT_AUTHENTICATED_MESSAGE =
  "No API key: log in with 'aumohta auth login USERNAME', store a key with 'aumohta auth use-key', or set AUMOHTA_API_KEY";

export class ApiClient {
  constructor(
    readonly server: string,
    readonly apiKey: string | undefined,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  url(path: string, query: Query = {}): URL {
    const url = new URL(this.server.replace(/\/+$/, "") + path);
    for (const [key, value] of queryPairs(query)) url.searchParams.append(key, value);
    return url;
  }

  /** Sends one request and returns the 2xx response; throws CliError for anything else. */
  async send(method: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
    const token = options.token ?? this.apiKey;
    if (options.auth === true && token === undefined) throw new CliError(EXIT.notAuthenticated, "not_authenticated", NOT_AUTHENTICATED_MESSAGE);
    const url = this.url(path, options.query);
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      text = await response.text();
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new CliError(EXIT.server, "network", `${method} ${url.href} timed out after ${String(this.timeoutMs / 1000)} s`);
      }
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : String(e);
      throw new CliError(EXIT.server, "network", `cannot reach ${this.server}: ${cause}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok) return { status: response.status, contentType, text };
    throw responseError(response.status, text, `${method} ${url.pathname}`);
  }

  /** Sends one request and returns its JSON body; a 204 is `{}`. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, path, options);
    if (response.status === 204 || response.text === "") return {} as T;
    return parseJson(response.text, `${method} ${path}`) as T;
  }
}

/** The query's parameters, in order, leaving out undefined values. */
function queryPairs(query: Query): (readonly [string, string])[] {
  if (Array.isArray(query)) return [...(query as readonly (readonly [string, string])[])];
  return Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)] as const]));
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(EXIT.server, "bad_response", `${what} answered with a body that is not JSON; is the server an Aumohta server?`);
  }
}

/** The CliError for a non-2xx response: the server's own error, with the exit code its status calls for. */
function responseError(status: number, text: string, what: string): CliError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const error = (body as { error?: unknown } | undefined)?.error as Partial<ErrorBody["error"]> | undefined;
  if (typeof error?.code !== "string" || typeof error.message !== "string") {
    return new CliError(EXIT.server, "bad_response", `${what} answered ${String(status)} without an Aumohta error body; is the server an Aumohta server?`);
  }
  const exitCode = status === 401 ? EXIT.notAuthenticated : status >= 400 && status < 500 ? EXIT.refused : EXIT.server;
  return new CliError(exitCode, error.code, error.message, error.details);
}

/** `--limit`, `--cursor` and `--all` of a list command (docs/spec/cli-api.md, Paging). */
export interface PageOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly all: boolean;
}

/** A page of a list: the server's wrapper object, with the list under one field. */
export type Page<Field extends string, Item> = Record<Field, Item[]> & { nextCursor: string | null };

/**
 * Fetches one page of a list, or with `all` every page from `cursor` on,
 * merged into one list with `nextCursor` null. `query` holds the list's
 * filters, repeated on every page.
 */
export async function fetchList<Field extends string, Item>(
  client: ApiClient,
  path: string,
  field: Field,
  page: PageOptions,
  options: RequestOptions = {},
): Promise<Page<Field, Item>> {
  const query = (cursor: string | undefined): Query => [
    ...queryPairs(options.query ?? {}),
    ...(page.limit === undefined ? [] : [["limit", String(page.limit)] as const]),
    ...(cursor === undefined ? [] : [["cursor", cursor] as const]),
  ];
  let body = await client.request<Page<Field, Item>>("GET", path, { ...options, query: query(page.cursor) });
  if (!page.all) return body;
  const items = [...body[field]];
  while (body.nextCursor !== null) {
    body = await client.request<Page<Field, Item>>("GET", path, { ...options, query: query(body.nextCursor) });
    items.push(...body[field]);
  }
  return { ...body, [field]: items, nextCursor: null };
}
