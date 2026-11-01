/**
 * The typed fetch client for the API (frontend spec section 4). The client is
 * same-origin with the API (ADR-0006), so paths are sent as they are.
 *
 * Every request carries the session token, when there is one, as
 * `Authorization: Bearer <token>`. A 401 to a request that carried a token
 * means the session has ended: the client calls `onUnauthorized`, which
 * returns the Player to log-in, then throws as for any other error.
 *
 * Request and response types come from the CLI's schema, generated from the
 * server's OpenAPI document (docs/spec/cli-api.md, HTTP client).
 */

import type { components } from "@positrontanks/cli/schema";

/** A schema of the API, by its name in the OpenAPI document. */
export type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];

export type ErrorDetail = NonNullable<Schema<"Error">["error"]["details"]>[number];

/** A failed request: the server's error, or `network` / `bad_response` when there was none. */
export class ApiError extends Error {
  constructor(
    /** The HTTP status; 0 when the server could not be reached. */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly ErrorDetail[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type Query = Readonly<Record<string, string | number | boolean | undefined>>;

export interface RequestOptions {
  readonly query?: Query;
  /** Sent as JSON. */
  readonly body?: unknown;
}

export interface ApiClientOptions {
  /** `fetch`, or a stand-in for tests. */
  readonly fetch: typeof fetch;
  /** The session token to send, if any. */
  readonly token: () => string | undefined;
  /** Called when a request that carried a token is answered 401. */
  readonly onUnauthorized: () => void;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  /** Sends one request and returns its JSON body (`undefined` for a 204); throws ApiError for anything but a 2xx. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const token = this.options.token();
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    let text: string;
    try {
      response = await this.options.fetch(withQuery(path, options.query), {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      text = await response.text();
    } catch {
      throw new ApiError(0, "network", "Cannot reach the server. Check your connection and try again.");
    }
    if (response.status === 401 && token !== undefined) this.options.onUnauthorized();
    if (!response.ok) throw responseError(response.status, text);
    if (response.status === 204 || text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(response.status, "bad_response", `The server's answer to ${method} ${path} is not JSON.`);
    }
  }

  /**
   * Opens an event stream (`GET path`, as `text/event-stream`) and returns
   * its body to read; throws ApiError as `request` does if it cannot. Native
   * EventSource is not used because it cannot send the session token.
   */
  async openStream(path: string, options: { readonly signal?: AbortSignal; readonly lastEventId?: string } = {}): Promise<ReadableStream<Uint8Array>> {
    const token = this.options.token();
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (options.lastEventId !== undefined) headers["last-event-id"] = options.lastEventId;

    let response: Response;
    try {
      response = await this.options.fetch(path, { headers, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      throw new ApiError(0, "network", "Cannot reach the server. Check your connection and try again.");
    }
    if (response.status === 401 && token !== undefined) this.options.onUnauthorized();
    if (!response.ok) throw responseError(response.status, await response.text().catch(() => ""));
    if (response.body === null) throw new ApiError(response.status, "bad_response", `The server answered GET ${path} without a body.`);
    return response.body;
  }
}

/** `path` with the query's defined values appended. */
function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.append(key, String(value));
  const search = params.toString();
  return search === "" ? path : `${path}?${search}`;
}

/** The ApiError for a non-2xx response: the server's own error, if the body is one. */
function responseError(status: number, text: string): ApiError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const error = (body as { error?: Partial<Schema<"Error">["error"]> } | undefined)?.error;
  if (typeof error?.code !== "string" || typeof error.message !== "string") {
    return new ApiError(status, "bad_response", `The server answered ${String(status)} without an error body.`);
  }
  return new ApiError(status, error.code, error.message, error.details ?? []);
}
