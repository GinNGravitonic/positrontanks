/**
 * Builds the OpenAPI 3.1 document from the registered ApiModules.
 *
 * Every operation gets a `default` response in the shared error format, so
 * clients can rely on it for any status the operation does not list.
 */

import { errorSchema } from "./errors.js";
import type { ApiModule, Json } from "./router.js";

export const API_VERSION = "0.0.0";

export function buildOpenApiDocument(modules: readonly ApiModule[]): Record<string, Json> {
  const paths: Record<string, Record<string, Json>> = {};
  const schemas: Record<string, Json> = { Error: errorSchema };
  const tags: Json[] = [];

  for (const module of modules) {
    for (const [name, schema] of Object.entries(module.schemas ?? {})) {
      if (name in schemas) throw new Error(`Duplicate OpenAPI schema ${name}`);
      schemas[name] = schema;
    }
    for (const tag of module.tags ?? []) tags.push(tag);
    for (const route of module.routes) {
      const item = (paths[route.path] ??= {});
      item[route.method.toLowerCase()] = {
        ...route.operation,
        responses: { ...route.operation.responses, default: { $ref: "#/components/responses/Error" } },
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Aumohta API",
      version: API_VERSION,
      description:
        "Programmable robot combat. Errors use one format everywhere: " +
        '`{"error": {"code", "message", "details"?}}`; branch on `code`. ' +
        "Lists are paged: pass `limit` (1-200, default 50) and, for later pages, the previous response's " +
        "`nextCursor` as `cursor`, repeating any filters; `nextCursor` is null on the last page.",
    },
    tags,
    paths,
    components: {
      schemas,
      responses: {
        Error: {
          description: "An error, in the shared error format.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A session token (from `logIn`) or an API key (from `createApiKey`).",
        },
      },
    },
  };
}
