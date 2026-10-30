/**
 * Endpoints about the server itself: health, the optional features it
 * enables (config.ts), and the OpenAPI document.
 */

import { ApiError } from "../http/errors.js";
import type { ApiModule, Json } from "../http/router.js";

const healthSchema: Json = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: { status: { const: "ok" } },
};

const serverSchema: Json = {
  type: "object",
  required: ["features"],
  additionalProperties: false,
  properties: {
    features: {
      type: "object",
      description: "Optional features, and whether this server enables each. Disabled features answer 410 `feature_disabled`.",
      required: ["tickCostCheck"],
      additionalProperties: false,
      properties: {
        tickCostCheck: {
          type: "boolean",
          description:
            "The tick cost check (`checkTickCost`, `checkBotDesignTickCost`), a local-server feature: on only where " +
            "the server sets POSITRONTANKS_TICK_COST_CHECK=on.",
        },
      },
    },
  },
};

/** `document` is called per request, so the served document includes every registered module. */
export function systemModule(document: () => Json): ApiModule {
  return {
    tags: [{ name: "System", description: "The server itself." }],
    schemas: { Health: healthSchema, Server: serverSchema },
    routes: [
      {
        method: "GET",
        path: "/health",
        operation: {
          operationId: "getHealth",
          summary: "Check that the server and its database are up",
          tags: ["System"],
          responses: {
            "200": {
              description: "Healthy.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
            },
            "503": { $ref: "#/components/responses/Error" },
          },
        },
        handler: ({ services }) => {
          try {
            services.db.ping();
          } catch (error) {
            throw new ApiError(503, "unavailable", "The database is not responding", undefined, undefined, {
              cause: error,
            });
          }
          return { body: { status: "ok" } };
        },
      },
      {
        method: "GET",
        path: "/server",
        operation: {
          operationId: "getServerInfo",
          summary: "Get which optional features this server enables",
          tags: ["System"],
          responses: {
            "200": {
              description: "This server's features.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Server" } } },
            },
          },
        },
        handler: ({ services }) => ({
          body: { features: { tickCostCheck: services.config.features.tickCostCheck } },
        }),
      },
      {
        method: "GET",
        path: "/openapi.json",
        operation: {
          operationId: "getOpenApiDocument",
          summary: "Get this OpenAPI document",
          tags: ["System"],
          responses: {
            "200": {
              description: "The OpenAPI 3.1 document describing this server.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
        handler: () => ({ body: document() }),
      },
    ],
  };
}
