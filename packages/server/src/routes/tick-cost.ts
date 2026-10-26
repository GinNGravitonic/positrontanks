/**
 * The tick cost check (ADR-0002; spec section 9, Garage): runs a Program's
 * `tick()` in a sample world and reports the operations it used per Tick,
 * the peak, and persistent memory (garage/tick-cost.ts).
 *
 * A Program can be checked inline, before it is saved, or as a Revision of
 * one of the Player's own Bot Designs. Either way the Build and Program are
 * validated exactly as when saving, and nothing is saved.
 *
 * A check never shows anything of another Player: the sample world is built
 * from the Ruleset alone, the report covers only the checked Bot, and
 * another Player's design answers 404 exactly as a missing one does.
 *
 * The check is a local-server feature (config.ts, `features.tickCostCheck`):
 * where it is off, both endpoints answer 410 `feature_disabled`, and
 * `GET /server` tells clients which it is before they call.
 */

import { authenticate } from "../accounts/auth.js";
import { checkDesign } from "../garage/design-check.js";
import {
  SAMPLE_BOT_NAME,
  SAMPLE_FOE_NAME,
  TICK_COST_DEFAULT_SEED,
  TICK_COST_DEFAULT_TICKS,
  TICK_COST_MAX_TICKS,
  type TickCost,
  type TickCostOptions,
} from "../garage/tick-cost.js";
import { ApiError, notFound, validationFailed, type ErrorDetail } from "../http/errors.js";
import type { ApiModule, Json, Reply, RequestContext } from "../http/router.js";
import type { HostedRuleset } from "../rulesets/catalog.js";
import { readObject, readRuleset } from "./garage.js";

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: Json): Json => ({ "application/json": { schema } });
const errorResponse: Json = { $ref: "#/components/responses/Error" };
const bearer: readonly Json[] = [{ bearerAuth: [] }];
const TAG = "Garage";

const designIdParameter: Json = { name: "designId", in: "path", required: true, schema: { type: "string" } };

const optionProperties: Record<string, Json> = {
  ticks: {
    type: "integer",
    minimum: 1,
    maximum: TICK_COST_MAX_TICKS,
    default: TICK_COST_DEFAULT_TICKS,
    description: "How many Ticks to run `tick()` for.",
  },
  seed: {
    type: "integer",
    minimum: 0,
    maximum: 2 ** 32 - 1,
    default: TICK_COST_DEFAULT_SEED,
    description: "The sample Game's seed, which drives `random()` and which side the Bot starts on.",
  },
};

const stopSchema: Json = {
  type: ["object", "null"],
  description: "Where and why the run stopped early, or null if it completed.",
  required: ["line", "column", "message"],
  additionalProperties: false,
  properties: { line: { type: "integer" }, column: { type: "integer" }, message: { type: "string" } },
};

const runProperties: Record<string, Json> = {
  outcome: { type: "string", enum: ["completed", "outOfBudget", "error"] },
  operations: { type: "integer", description: "Operations charged during the run." },
  memoryCells: { type: "integer", description: "Persistent state at the end of the run, in cells." },
  error: stopSchema,
};

const schemas: Record<string, Json> = {
  TickCostCheck: {
    type: "object",
    description: "A Build and Program to check, as when creating a Bot Design.",
    required: ["rulesetVersion", "build", "program"],
    additionalProperties: false,
    properties: {
      rulesetVersion: { type: "string", examples: ["r1"] },
      build: ref("Build"),
      program: { type: "string" },
      ...optionProperties,
    },
  },
  BotDesignTickCostCheck: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      revision: { type: "integer", minimum: 1, description: "The Revision to check; defaults to the latest." },
      ...optionProperties,
    },
  },
  TickCostReport: {
    type: "object",
    description:
      `How a Program used its Operation Budget in the sample world: a fixed Map, the checked Bot ("${SAMPLE_BOT_NAME}") ` +
      `and one sample Foe ("${SAMPLE_FOE_NAME}") 20 m ahead, facing it, with the same Build and a Program that only ` +
      "drives in a circle. Only the checked Bot's runs are reported. The same request always gives the same report.",
    required: ["rulesetVersion", "operationBudget", "seed", "ticks", "init", "runs", "peak", "memory", "halt"],
    additionalProperties: false,
    properties: {
      rulesetVersion: { type: "string" },
      operationBudget: { type: "integer", description: "Operations per Tick, set by the Build's Processor." },
      seed: { type: "integer" },
      ticks: { type: "integer", description: "The Ticks asked for." },
      init: {
        type: "object",
        description: "The init phase, with its own budget.",
        required: ["outcome", "operations", "memoryCells", "error", "budget"],
        additionalProperties: false,
        properties: { ...runProperties, budget: { type: "integer" } },
      },
      runs: {
        type: "array",
        description:
          "One per Tick `tick()` ran, from Tick 1. Fewer than `ticks` if the Program halted or the sample Game ended " +
          "early (one Bot Disabled the other).",
        items: {
          type: "object",
          required: ["tick", "outcome", "operations", "memoryCells", "error"],
          additionalProperties: false,
          properties: { tick: { type: "integer", minimum: 1 }, ...runProperties },
        },
      },
      peak: {
        type: ["object", "null"],
        description: "The most operations one `tick()` used, and the first Tick it did; null if `tick()` never ran.",
        required: ["operations", "tick"],
        additionalProperties: false,
        properties: { operations: { type: "integer" }, tick: { type: "integer", minimum: 1 } },
      },
      memory: {
        type: "object",
        description: "The largest persistent state over every run, and the Ruleset's cap, in cells.",
        required: ["peak", "cap"],
        additionalProperties: false,
        properties: { peak: { type: "integer" }, cap: { type: "integer" } },
      },
      halt: {
        type: ["object", "null"],
        description: "When (0 for the init phase) and why the Program halted, or null.",
        required: ["tick", "reason"],
        additionalProperties: false,
        properties: { tick: { type: "integer", minimum: 0 }, reason: { type: "string" } },
      },
    },
  },
};

/**
 * Answers 410 unless this server enables the check. 410 is heuristically
 * cacheable, so it is marked no-store: enabling the feature takes effect at once.
 */
function requireEnabled(context: RequestContext): void {
  if (context.services.config.features.tickCostCheck) return;
  throw new ApiError(
    410,
    "feature_disabled",
    "The tick cost check is a local-server feature and is off on this server; run a local server with " +
      "AUMOHTA_TICK_COST_CHECK=on (see docs/docker.md) to check tick costs",
    undefined,
    { "cache-control": "no-store" },
  );
}

/** The `ticks` and `seed` options, defaulted, after recording any problems. */
function readOptions(body: Record<string, unknown>, details: ErrorDetail[]): TickCostOptions {
  const integer = (key: string, min: number, max: number, fallback: number): number => {
    const value = body[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      details.push({ path: key, message: `must be an integer from ${String(min)} to ${String(max)}` });
      return fallback;
    }
    return value;
  };
  return {
    ticks: integer("ticks", 1, TICK_COST_MAX_TICKS, TICK_COST_DEFAULT_TICKS),
    seed: integer("seed", 0, 2 ** 32 - 1, TICK_COST_DEFAULT_SEED),
  };
}

/** Validates the Build and Program as when saving, then runs the check. */
function check(hosted: HostedRuleset, build: unknown, program: unknown, options: TickCostOptions, details: ErrorDetail[]): Reply {
  const checked = checkDesign(hosted, build, program);
  if (!checked.ok) details.push(...checked.problems);
  if (details.length > 0 || !checked.ok) throw validationFailed(details);
  const report: TickCost = hosted.checkTickCost(checked.build, checked.program, options);
  return { body: report };
}

const reportResponse: Json = { description: "The report.", content: jsonContent(ref("TickCostReport")) };

export const tickCostModule: ApiModule = {
  schemas,
  routes: [
    {
      method: "POST",
      path: "/tick-cost-checks",
      operation: {
        operationId: "checkTickCost",
        summary: "Check the tick cost of a Program in a sample world",
        description:
          "Validates the Build and Program exactly as `createBotDesign` does (problems answer 422 with every problem " +
          "in `details`), then runs the Program's init phase and `tick()` for `ticks` Ticks in the sample world and " +
          "reports the operations each run used, the peak, and persistent memory. Nothing is saved. A local-server " +
          "feature: servers that do not enable it answer 410 `feature_disabled` (see `getServerInfo`).",
        tags: [TAG],
        security: bearer,
        requestBody: { required: true, content: jsonContent(ref("TickCostCheck")) },
        responses: { "200": reportResponse, "401": errorResponse, "410": errorResponse, "422": errorResponse },
      },
      handler: async (context) => {
        requireEnabled(context);
        authenticate(context);
        const body = readObject(
          await context.readJson(),
          ["rulesetVersion", "build", "program", "ticks", "seed"],
          ["rulesetVersion", "build", "program"],
        );
        const details: ErrorDetail[] = [];
        const hosted = readRuleset(context, body.rulesetVersion, details);
        const options = readOptions(body, details);
        if (hosted === undefined) throw validationFailed(details);
        return check(hosted, body.build, body.program, options, details);
      },
    },
    {
      method: "POST",
      path: "/bot-designs/{designId}/tick-cost-checks",
      operation: {
        operationId: "checkBotDesignTickCost",
        summary: "Check the tick cost of a Revision of one of your Bot Designs",
        description:
          "As `checkTickCost`, for a saved Revision (the latest by default) under the design's Ruleset version. " +
          "Archived designs can be checked. Another Player's design answers 404.",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter],
        requestBody: { required: true, content: jsonContent(ref("BotDesignTickCostCheck")) },
        responses: {
          "200": reportResponse,
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "410": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        requireEnabled(context);
        const { player } = authenticate(context);
        const body = readObject(await context.readJson(), ["revision", "ticks", "seed"], []);
        const details: ErrorDetail[] = [];
        const options = readOptions(body, details);
        if (body.revision !== undefined && !(Number.isSafeInteger(body.revision) && Number(body.revision) >= 1)) {
          details.push({ path: "revision", message: "must be a positive integer" });
        }
        if (details.length > 0) throw validationFailed(details);

        const id = context.params.designId ?? "";
        const garage = context.services.db.garage;
        const design = garage.getDesign(player.id, id);
        if (design === undefined) throw notFound(`You have no Bot Design ${id}`);
        const number = body.revision === undefined ? design.latestRevision.number : Number(body.revision);
        const revision = garage.getRevision(player.id, id, number);
        if (revision === undefined) throw notFound(`Bot Design ${id} has no Revision ${String(number)}`);
        const hosted = context.services.rulesets.get(design.rulesetVersion);
        if (hosted === undefined) {
          throw new ApiError(
            409,
            "ruleset_not_hosted",
            `Ruleset ${design.rulesetVersion} is no longer hosted; copy the design to a hosted Ruleset`,
          );
        }
        return check(hosted, revision.build, revision.program, options, details);
      },
    },
  ],
};
