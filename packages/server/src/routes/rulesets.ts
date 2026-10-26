/**
 * Rulesets (spec sections 5 and 8): the versions this server hosts, and for
 * each its rules, language spec, Parts Catalog and Terrain table.
 *
 * Everything here is public and needs no credential. A hosted version's data
 * is frozen, so these responses never change for a given version. They are
 * served as machine-readable data straight from the Ruleset data and the
 * version's language definition, the same values the server validates Bot
 * Designs against and the engine runs; the prose documents that explain them
 * (docs/spec/*-r1.md) are not served here.
 *
 * An unknown version is answered 404 `not_found`, naming the hosted versions.
 */

import type { Ruleset } from "@aumohta/ruleset-data";
import { notFound } from "../http/errors.js";
import type { ApiModule, Json, RequestContext, Route } from "../http/router.js";
import type { HostedRuleset } from "../rulesets/catalog.js";

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: Json): Json => ({ "application/json": { schema } });
const errorResponse: Json = { $ref: "#/components/responses/Error" };
const TAG = "Rulesets";

const versionParameter: Json = {
  name: "version",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "A hosted Ruleset version, such as `r1`.",
  examples: { r1: { value: "r1" } },
};

const version: Json = { type: "string", description: "The Ruleset version.", examples: ["r1"] };
const stringList: Json = { type: "array", items: { type: "string" } };
const recordOf = (schema: Json): Json => ({ type: "object", additionalProperties: schema });

const point: Json = {
  type: "object",
  required: ["x", "y"],
  additionalProperties: false,
  properties: { x: { type: "number" }, y: { type: "number" } },
};

const terrainMultipliers: Record<string, Json> = {
  speed: { type: "number", description: "Multiplies maximum speed." },
  accel: { type: "number", description: "Multiplies acceleration." },
};

const statValue: Json = {
  description: "A number, an enum value, or (for `terrainModifiers` stats) per-Terrain multipliers keyed by Terrain name.",
  oneOf: [
    { type: "number" },
    { type: "string" },
    recordOf({
      type: "object",
      required: ["speed", "accel"],
      additionalProperties: false,
      properties: terrainMultipliers,
    }),
  ],
};

const summaryProperties: Record<string, Json> = {
  version,
  tickRate: { type: "integer", minimum: 1, description: "Ticks per simulated second." },
  pointBudget: {
    type: "object",
    description: "The range an Initiator may choose a Game's Point Budget from.",
    required: ["min", "max"],
    additionalProperties: false,
    properties: { min: { type: "number" }, max: { type: "number" } },
  },
  mapFormats: { type: "array", items: { type: "integer" }, description: "The Map Formats this Ruleset supports." },
};

const schemas: Record<string, Json> = {
  RulesetSummary: {
    type: "object",
    required: ["version", "tickRate", "pointBudget", "mapFormats"],
    additionalProperties: false,
    properties: summaryProperties,
  },
  RulesetList: {
    type: "object",
    required: ["rulesets"],
    additionalProperties: false,
    properties: { rulesets: { type: "array", items: ref("RulesetSummary"), description: "Oldest first." } },
  },
  RulesetLimits: {
    type: "object",
    description: "Language limits (language spec section 11).",
    required: [
      "initBudgetMultiplier",
      "memoryCells",
      "maxCallDepth",
      "maxCollectionLength",
      "maxSourceBytes",
      "logLinesPerTick",
      "logLineLength",
    ],
    additionalProperties: false,
    properties: {
      initBudgetMultiplier: { type: "number", description: "The init phase's Operation Budget, as a multiple of the per-Tick one." },
      memoryCells: { type: "integer", description: "The memory cap on persistent state, in cells." },
      maxCallDepth: { type: "integer" },
      maxCollectionLength: { type: "integer" },
      maxSourceBytes: { type: "integer", description: "The largest Program source, in UTF-8 bytes." },
      logLinesPerTick: { type: "integer" },
      logLineLength: { type: "integer" },
    },
  },
  RulesetRules: {
    type: "object",
    description: "The Ruleset's global rules.",
    required: ["version", "tickRate", "pointBudget", "mapFormats", "slotTypes", "limits"],
    additionalProperties: false,
    properties: {
      ...summaryProperties,
      slotTypes: { ...stringList, description: "The Slot types Chassis may have." },
      limits: ref("RulesetLimits"),
    },
  },
  ValueType: {
    description:
      "The static shape of a built-in value: `number`, `string`, `boolean` or `any`; a record with known " +
      "fields; a list; or a map keyed by data (such as Terrain names) whose fields share one type.",
    oneOf: [
      { type: "string", enum: ["number", "string", "boolean", "any"] },
      {
        type: "object",
        required: ["record"],
        additionalProperties: false,
        properties: { record: recordOf(ref("ValueType")) },
      },
      { type: "object", required: ["list"], additionalProperties: false, properties: { list: ref("ValueType") } },
      { type: "object", required: ["map"], additionalProperties: false, properties: { map: ref("ValueType") } },
    ],
  },
  BuiltinFunction: {
    type: "object",
    required: ["minArgs", "maxArgs", "cost", "initPhase"],
    additionalProperties: false,
    properties: {
      minArgs: { type: "integer", minimum: 0 },
      maxArgs: { type: "integer", minimum: 0 },
      cost: { type: "integer", minimum: 0, description: "Operations charged for a call." },
      initPhase: { type: "boolean", description: "False for commands and sensors, which `init()` may not call." },
      slotArgument: {
        type: "string",
        enum: ["weapon", "rangefinder"],
        description: "The first argument names a Slot holding this kind of Component.",
      },
      mutatesFirstArgument: { type: "boolean", description: "Mutates its first argument, so it may not be read-only." },
    },
  },
  BuiltinMethod: {
    type: "object",
    required: ["minArgs", "maxArgs", "cost"],
    additionalProperties: false,
    properties: {
      minArgs: { type: "integer", minimum: 0 },
      maxArgs: { type: "integer", minimum: 0 },
      cost: { type: "integer", minimum: 0, description: "Operations charged for a call." },
      mutates: { type: "boolean", description: "Mutates the receiver, so it may not be called on a read-only value." },
    },
  },
  RulesetLanguage: {
    type: "object",
    description:
      "What the Ruleset's language gives Programs: built-in functions with their costs, the read-only built-in " +
      "values (`self`, `game`, `map`), list and string methods, and the language limits. A Program naming " +
      "anything not listed here fails validation when its Revision is saved.",
    required: ["version", "functions", "values", "listMethods", "stringMethods", "lengthCost", "limits"],
    additionalProperties: false,
    properties: {
      version,
      functions: recordOf(ref("BuiltinFunction")),
      values: recordOf(ref("ValueType")),
      listMethods: recordOf(ref("BuiltinMethod")),
      stringMethods: recordOf(ref("BuiltinMethod")),
      lengthCost: { type: "integer", minimum: 0, description: "Operations charged for reading `.length`." },
      limits: ref("RulesetLimits"),
    },
  },
  StatDefinition: {
    description: "The type and bounds of one stat. Each Ruleset defines its own open-ended set of stats.",
    oneOf: [
      {
        type: "object",
        required: ["type"],
        additionalProperties: false,
        properties: {
          type: { const: "number" },
          min: { type: "number" },
          max: { type: "number" },
          integer: { type: "boolean" },
        },
      },
      {
        type: "object",
        required: ["type", "values"],
        additionalProperties: false,
        properties: { type: { const: "enum" }, values: stringList },
      },
      {
        type: "object",
        required: ["type"],
        additionalProperties: false,
        properties: { type: { const: "terrainModifiers" } },
      },
    ],
  },
  ComponentKind: {
    type: "object",
    required: ["mount", "stats"],
    additionalProperties: false,
    properties: {
      mount: {
        type: "string",
        enum: ["slot", "side"],
        description: "`slot`: installed in a compatible Slot. `side`: bought per side of the Bot, as Armor.",
      },
      stats: recordOf(ref("StatDefinition")),
    },
  },
  Chassis: {
    type: "object",
    required: ["id", "name", "cost", "shape", "slots", "stats"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      cost: { type: "number" },
      shape: {
        description: "The outline in the Bot frame (meters, x right, y toward the rear); a circle is centred on the Bot.",
        oneOf: [
          {
            type: "object",
            required: ["shape", "radius"],
            additionalProperties: false,
            properties: { shape: { const: "circle" }, radius: { type: "number" } },
          },
          {
            type: "object",
            required: ["shape", "points"],
            additionalProperties: false,
            properties: { shape: { const: "polygon" }, points: { type: "array", items: point } },
          },
        ],
      },
      slots: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "type", "x", "y", "direction"],
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "The Slot name, which Programs use as a weapon or sensor id." },
            type: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            direction: { type: "number", description: "Facing relative to the Heading, degrees in (-180, 180]." },
          },
        },
      },
      stats: recordOf(statValue),
      artwork: { type: "string", description: "Top-down SVG reference; absent means a placeholder." },
    },
  },
  Component: {
    type: "object",
    required: ["id", "name", "kind", "cost", "slotTypes", "stats"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      kind: { type: "string", description: "A key of the catalog's `componentKinds`." },
      cost: { type: "number" },
      slotTypes: { ...stringList, description: "The Slot types it fits; empty for side-mounted kinds." },
      stats: recordOf(statValue),
      artwork: {
        type: "string",
        description:
          "Top-down SVG reference; absent means a placeholder. Drawn in meters, origin at the Slot, pointing along " +
          "the Slot direction.",
      },
      visualSize: {
        type: "object",
        description:
          "How big clients draw a Slot-mounted Component, in meters, origin at the Slot: `length` along the Slot " +
          "direction, `width` across it. Each is at most the largest Chassis dimension. Purely visual: no engine " +
          "reads it, and drawn Components may overlap.",
        required: ["length", "width"],
        additionalProperties: false,
        properties: { length: { type: "number", exclusiveMinimum: 0 }, width: { type: "number", exclusiveMinimum: 0 } },
      },
    },
  },
  PartsCatalog: {
    type: "object",
    description:
      "Every Chassis and Component a Build may use, with the stat definitions that give their stats types " +
      "and bounds.",
    required: ["version", "slotTypes", "chassisStats", "componentKinds", "chassis", "components"],
    additionalProperties: false,
    properties: {
      version,
      slotTypes: stringList,
      chassisStats: recordOf(ref("StatDefinition")),
      componentKinds: recordOf(ref("ComponentKind")),
      chassis: { type: "array", items: ref("Chassis") },
      components: { type: "array", items: ref("Component") },
    },
  },
  TerrainTable: {
    type: "object",
    required: ["version", "terrains"],
    additionalProperties: false,
    properties: {
      version,
      terrains: {
        type: "array",
        description: "In declared order, which is the order `terrainTable()` reports.",
        items: {
          type: "object",
          required: ["name", "speed", "accel"],
          additionalProperties: false,
          properties: { name: { type: "string" }, ...terrainMultipliers },
        },
      },
    },
  },
};

// --- responses -------------------------------------------------------------

const summaryJson = (r: Ruleset) => ({
  version: r.version,
  tickRate: r.tickRate,
  pointBudget: r.pointBudget,
  mapFormats: r.mapFormats,
});

const rulesJson = (r: Ruleset) => ({ ...summaryJson(r), slotTypes: r.slotTypes, limits: r.limits });

const languageJson = ({ ruleset, language }: HostedRuleset) => ({
  version: ruleset.version,
  functions: language.functions,
  values: language.values,
  listMethods: language.listMethods,
  stringMethods: language.stringMethods,
  lengthCost: language.lengthCost,
  limits: ruleset.limits,
});

const catalogJson = (r: Ruleset) => ({
  version: r.version,
  slotTypes: r.slotTypes,
  chassisStats: r.chassisStats,
  componentKinds: r.componentKinds,
  chassis: r.chassis,
  components: r.components,
});

const terrainJson = (r: Ruleset) => ({ version: r.version, terrains: r.terrains });

/** The hosted Ruleset named by the `version` path parameter, or 404. */
function hosted(context: RequestContext): HostedRuleset {
  const name = context.params.version ?? "";
  const found = context.services.rulesets.get(name);
  if (found === undefined) {
    const known = context.services.rulesets.versions().join(", ");
    throw notFound(`There is no hosted Ruleset ${name}; this server hosts ${known}`);
  }
  return found;
}

interface VersionRoute {
  /** Appended to `/rulesets/{version}`. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  /** The component schema of the 200 response, and its description. */
  readonly schema: string;
  readonly returns: string;
  readonly body: (h: HostedRuleset) => unknown;
}

/** A public GET of one part of a hosted Ruleset. */
function versionRoute(r: VersionRoute): Route {
  return {
    method: "GET",
    path: `/rulesets/{version}${r.path}`,
    operation: {
      operationId: r.operationId,
      summary: r.summary,
      description: `${r.description} Anyone may read it; no credential is needed. A hosted version never changes.`,
      tags: [TAG],
      security: [],
      parameters: [versionParameter],
      responses: {
        "200": { description: r.returns, content: jsonContent(ref(r.schema)) },
        "404": errorResponse,
      },
    },
    handler: (context) => ({ body: r.body(hosted(context)) }),
  };
}

// --- the module ------------------------------------------------------------

export const rulesetsModule: ApiModule = {
  tags: [
    {
      name: TAG,
      description:
        "The Ruleset versions this server hosts, side by side: each version's rules, language spec, Parts " +
        "Catalog and Terrain table. Public and frozen per version.",
    },
  ],
  schemas,
  routes: [
    {
      method: "GET",
      path: "/rulesets",
      operation: {
        operationId: "listRulesets",
        summary: "List the hosted Ruleset versions",
        description: "Anyone may list them; no credential is needed.",
        tags: [TAG],
        security: [],
        responses: {
          "200": { description: "The hosted versions, oldest first.", content: jsonContent(ref("RulesetList")) },
        },
      },
      handler: ({ services }) => {
        const rulesets = services.rulesets.versions().flatMap((v) => {
          const h = services.rulesets.get(v);
          return h === undefined ? [] : [summaryJson(h.ruleset)];
        });
        return { body: { rulesets } };
      },
    },
    versionRoute({
      path: "",
      operationId: "getRuleset",
      summary: "Get a hosted Ruleset version's summary",
      description: "Its Tick rate, Point Budget range and supported Map Formats.",
      schema: "RulesetSummary",
      returns: "The summary.",
      body: (h) => summaryJson(h.ruleset),
    }),
    versionRoute({
      path: "/rules",
      operationId: "getRulesetRules",
      summary: "Get a Ruleset version's rules",
      description: "Its global values: Tick rate, Point Budget range, Map Formats, Slot types and language limits.",
      schema: "RulesetRules",
      returns: "The rules.",
      body: (h) => rulesJson(h.ruleset),
    }),
    versionRoute({
      path: "/language",
      operationId: "getRulesetLanguage",
      summary: "Get a Ruleset version's language spec",
      description:
        "The built-in functions (with argument counts and operation costs), the built-in values a Program may " +
        "read (`self.*`, `game.*`, `map.*`), list and string methods, and the language limits.",
      schema: "RulesetLanguage",
      returns: "The language spec.",
      body: languageJson,
    }),
    versionRoute({
      path: "/parts",
      operationId: "getPartsCatalog",
      summary: "Get a Ruleset version's Parts Catalog",
      description: "Every Chassis and Component with its cost, Slots and stats, and the stat definitions.",
      schema: "PartsCatalog",
      returns: "The Parts Catalog.",
      body: (h) => catalogJson(h.ruleset),
    }),
    versionRoute({
      path: "/terrains",
      operationId: "getTerrainTable",
      summary: "Get a Ruleset version's Terrain table",
      description: "Every Terrain with its speed and acceleration multipliers.",
      schema: "TerrainTable",
      returns: "The Terrain table.",
      body: (h) => terrainJson(h.ruleset),
    }),
  ],
};
