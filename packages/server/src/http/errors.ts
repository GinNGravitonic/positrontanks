/**
 * The API error format.
 *
 * Every error response, from any endpoint, has the body
 *
 *     { "error": { "code": "not_found", "message": "...", "details": [...] } }
 *
 * `code` is a stable snake_case identifier for programs (and LLM agents) to
 * branch on; `message` is for people and may change. `details` is present
 * only for errors about specific parts of the request, one entry per problem,
 * each with a `path` into the request such as `map.obstacles[2].hitPoints`
 * (the same shape ruleset-data's validators report). Problems in a Program
 * also carry the 1-based `line` and `column` the language checker reports.
 */

export interface ErrorDetail {
  readonly path: string;
  readonly message: string;
  /** For a problem in source text (a Program): where it is, 1-based. */
  readonly line?: number;
  readonly column?: number;
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly ErrorDetail[];
  };
}

/** Thrown by handlers (or the framework) to send an error response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: readonly ErrorDetail[],
    readonly headers?: Readonly<Record<string, string>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
  }

  /** The response this error sends. */
  toReply(): { status: number; body: ErrorBody; headers?: Readonly<Record<string, string>> } {
    return { status: this.status, body: this.toBody(), ...(this.headers === undefined ? {} : { headers: this.headers }) };
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (message: string, details?: readonly ErrorDetail[]): ApiError =>
  new ApiError(400, "bad_request", message, details);

export const validationFailed = (details: readonly ErrorDetail[]): ApiError =>
  new ApiError(422, "validation_failed", "The request is not valid", details);

export const notFound = (message = "Not found"): ApiError => new ApiError(404, "not_found", message);

/** The JSON Schema of ErrorDetail, for the OpenAPI document. */
export const errorDetailSchema = {
  type: "object",
  required: ["path", "message"],
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    message: { type: "string" },
    line: { type: "integer", minimum: 1, description: "For a problem in a Program: its line." },
    column: { type: "integer", minimum: 1, description: "For a problem in a Program: its column." },
  },
} as const;

/** The JSON Schema of ErrorBody, for the OpenAPI document. */
export const errorSchema = {
  type: "object",
  required: ["error"],
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      additionalProperties: false,
      properties: {
        code: { type: "string", description: "Stable snake_case identifier.", examples: ["not_found"] },
        message: { type: "string", description: "Human-readable explanation." },
        details: {
          type: "array",
          description: "One entry per problem with a specific part of the request.",
          items: errorDetailSchema,
        },
      },
    },
  },
} as const;
