/**
 * The Garage: a Player's private Bot Designs and their Revisions (spec
 * sections 3 and 9).
 *
 * A Bot Design is authored against one Ruleset version. Saving (creating a
 * design or a new Revision) validates the Build and the Program together and
 * rejects the save with every problem listed. Revisions are immutable and
 * numbered from 1; editing a design always adds a Revision.
 *
 * Copy to Ruleset re-validates a Revision under another hosted Ruleset
 * version and, if it is valid there, saves it as a new design in that
 * version; otherwise it reports the problems. `dryRun` reports without
 * saving.
 *
 * "Deleting" a design archives it: it disappears from listings and accepts
 * no new Revisions, but it and its Revisions stay readable by the owner,
 * since Games may reference them.
 *
 * Everything here is owner-only. Programs are visible only to their owner,
 * ever, so another Player's design answers 404 exactly as a missing one does.
 */

import { randomUUID } from "node:crypto";
import { authenticate } from "../accounts/auth.js";
import type { DesignRecord, RevisionRecord, RevisionSummary } from "../db/garage.js";
import { checkDesign } from "../garage/design-check.js";
import {
  ApiError,
  badRequest,
  errorDetailSchema,
  notFound,
  validationFailed,
  type ErrorDetail,
} from "../http/errors.js";
import type { ApiModule, Json, RequestContext } from "../http/router.js";
import type { HostedRuleset } from "../rulesets/catalog.js";

export const DESIGN_NAME_MAX_LENGTH = 64;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: Json): Json => ({ "application/json": { schema } });
const errorResponse: Json = { $ref: "#/components/responses/Error" };
const bearer: readonly Json[] = [{ bearerAuth: [] }];
const TAG = "Garage";

const designIdParameter: Json = { name: "designId", in: "path", required: true, schema: { type: "string" } };
const revisionParameter: Json = {
  name: "revision",
  in: "path",
  required: true,
  schema: { type: "integer", minimum: 1 },
  description: "The Revision number.",
};

const nameSchema: Json = { type: "string", minLength: 1, maxLength: DESIGN_NAME_MAX_LENGTH };
const timestamp: Json = { type: "string", format: "date-time" };

const schemas: Record<string, Json> = {
  Build: {
    type: "object",
    description:
      "The physical half of a Bot Design: one Chassis, Components installed by Slot id, and Armor per side. " +
      "Ids refer to the design's Ruleset's Parts Catalog.",
    required: ["chassis", "components", "armor"],
    additionalProperties: false,
    properties: {
      chassis: { type: "string", examples: ["scout"] },
      components: {
        type: "object",
        description: "Slot id to Component id; empty Slots are omitted.",
        additionalProperties: { type: "string" },
        examples: [{ gun: "pelletGun", eye: "radar", drive: "wheels" }],
      },
      armor: {
        type: "object",
        description: "An Armor Component id per side, or null for none.",
        required: ["front", "left", "right", "rear"],
        additionalProperties: false,
        properties: Object.fromEntries(
          ["front", "left", "right", "rear"].map((side) => [side, { type: ["string", "null"] }]),
        ),
      },
    },
  },
  BotDesignRevision: {
    type: "object",
    description: "An immutable snapshot of a Bot Design. The Program is visible only to the design's owner.",
    required: ["designId", "number", "build", "program", "cost", "createdAt"],
    additionalProperties: false,
    properties: {
      designId: { type: "string" },
      number: { type: "integer", minimum: 1 },
      build: ref("Build"),
      program: { type: "string", description: "Source code in the design's Ruleset's language." },
      cost: { type: "integer", description: "The Build's point cost." },
      createdAt: timestamp,
    },
  },
  BotDesignRevisionSummary: {
    type: "object",
    required: ["number", "cost", "createdAt"],
    additionalProperties: false,
    properties: { number: { type: "integer", minimum: 1 }, cost: { type: "integer" }, createdAt: timestamp },
  },
  CopiedFrom: {
    type: ["object", "null"],
    description: "The design and Revision this design was copied from, if it was made by Copy to Ruleset.",
    required: ["designId", "revision"],
    additionalProperties: false,
    properties: { designId: { type: "string" }, revision: { type: "integer", minimum: 1 } },
  },
  BotDesignSummary: {
    type: "object",
    required: ["id", "name", "rulesetVersion", "latestRevision", "copiedFrom", "createdAt", "updatedAt", "archivedAt"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      rulesetVersion: { type: "string" },
      latestRevision: ref("BotDesignRevisionSummary"),
      copiedFrom: ref("CopiedFrom"),
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: { type: ["string", "null"], format: "date-time", description: "Set once the design is archived." },
    },
  },
  BotDesign: {
    type: "object",
    required: ["id", "name", "rulesetVersion", "latestRevision", "copiedFrom", "createdAt", "updatedAt", "archivedAt"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      rulesetVersion: { type: "string" },
      latestRevision: ref("BotDesignRevision"),
      copiedFrom: ref("CopiedFrom"),
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: { type: ["string", "null"], format: "date-time", description: "Set once the design is archived." },
    },
  },
  BotDesignList: {
    type: "object",
    required: ["botDesigns"],
    additionalProperties: false,
    properties: { botDesigns: { type: "array", items: ref("BotDesignSummary") } },
  },
  BotDesignRevisionList: {
    type: "object",
    required: ["revisions"],
    additionalProperties: false,
    properties: { revisions: { type: "array", items: ref("BotDesignRevisionSummary") } },
  },
  NewBotDesign: {
    type: "object",
    required: ["name", "rulesetVersion", "build", "program"],
    additionalProperties: false,
    properties: {
      name: nameSchema,
      rulesetVersion: { type: "string", examples: ["r1"] },
      build: ref("Build"),
      program: { type: "string" },
    },
  },
  NewBotDesignRevision: {
    type: "object",
    required: ["build", "program"],
    additionalProperties: false,
    properties: { build: ref("Build"), program: { type: "string" } },
  },
  BotDesignUpdate: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: { name: nameSchema },
  },
  CopyToRuleset: {
    type: "object",
    required: ["rulesetVersion"],
    additionalProperties: false,
    properties: {
      rulesetVersion: { type: "string", description: "The hosted Ruleset version to copy into." },
      revision: { type: "integer", minimum: 1, description: "The Revision to copy; defaults to the latest." },
      name: { ...nameSchema, description: "The new design's name; defaults to the source design's." },
      dryRun: { type: "boolean", default: false, description: "Report problems without saving anything." },
    },
  },
  CopyReport: {
    type: "object",
    description: "How a Revision fares under another Ruleset version.",
    required: ["rulesetVersion", "sourceRevision", "ok", "cost", "problems"],
    additionalProperties: false,
    properties: {
      rulesetVersion: { type: "string" },
      sourceRevision: { type: "integer", minimum: 1 },
      ok: { type: "boolean", description: "True when the copy is valid under the target Ruleset." },
      cost: { type: ["integer", "null"], description: "The Build's cost under the target Ruleset, if the Build is valid there." },
      problems: {
        type: "array",
        description:
          "Everything that makes the copy invalid: Components or Chassis the target Ruleset lacks, a cost over its " +
          "largest Point Budget, and Program errors such as unknown built-ins. Same entries as error `details`.",
        items: errorDetailSchema,
      },
    },
  },
  CopiedBotDesign: {
    type: "object",
    required: ["botDesign", "report"],
    additionalProperties: false,
    properties: { botDesign: ref("BotDesign"), report: ref("CopyReport") },
  },
};

// --- request parsing -------------------------------------------------------

/** Reads a JSON object body, reporting fields outside `allowed` and missing `required` ones. */
function readObject(body: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationFailed([{ path: "(body)", message: "must be a JSON object" }]);
  }
  const record = body as Record<string, unknown>;
  const details: ErrorDetail[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) details.push({ path: key, message: "is not a known field" });
  }
  for (const key of required) {
    if (record[key] === undefined) details.push({ path: key, message: "is required" });
  }
  if (details.length > 0) throw validationFailed(details);
  return record;
}

/** A trimmed design name, or undefined after recording a problem. */
function readName(value: unknown, details: ErrorDetail[]): string | undefined {
  if (typeof value !== "string") {
    details.push({ path: "name", message: "must be a string" });
    return undefined;
  }
  const name = value.trim();
  if (name.length === 0 || name.length > DESIGN_NAME_MAX_LENGTH) {
    details.push({ path: "name", message: `must be 1 to ${String(DESIGN_NAME_MAX_LENGTH)} characters` });
    return undefined;
  }
  return name;
}

/** The hosted Ruleset with this version, or undefined after recording a problem. */
function readRuleset(context: RequestContext, value: unknown, details: ErrorDetail[]): HostedRuleset | undefined {
  if (typeof value !== "string") {
    details.push({ path: "rulesetVersion", message: "must be a string" });
    return undefined;
  }
  const hosted = context.services.rulesets.get(value);
  if (hosted === undefined) {
    const known = context.services.rulesets.versions().join(", ");
    details.push({ path: "rulesetVersion", message: `is not a Ruleset version this server hosts (${known})` });
  }
  return hosted;
}

function revisionNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9]\d{0,8}$/.test(raw)) return undefined;
  return Number(raw);
}

// --- responses -------------------------------------------------------------

const copiedFromJson = (d: DesignRecord): Json =>
  d.copiedFrom === null ? null : { designId: d.copiedFrom.designId, revision: d.copiedFrom.revision };

const revisionSummaryJson = (r: RevisionSummary): Json => ({ number: r.number, cost: r.cost, createdAt: r.createdAt });

const revisionJson = (r: RevisionRecord): Json => ({
  designId: r.designId,
  number: r.number,
  build: { chassis: r.build.chassis, components: { ...r.build.components }, armor: { ...r.build.armor } },
  program: r.program,
  cost: r.cost,
  createdAt: r.createdAt,
});

const designFields = (d: DesignRecord): Record<string, Json> => ({
  id: d.id,
  name: d.name,
  rulesetVersion: d.rulesetVersion,
  copiedFrom: copiedFromJson(d),
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  archivedAt: d.archivedAt,
});

const designSummaryJson = (d: DesignRecord): Json => ({ ...designFields(d), latestRevision: revisionSummaryJson(d.latestRevision) });

const designJson = (d: DesignRecord, latest: RevisionRecord): Json => ({ ...designFields(d), latestRevision: revisionJson(latest) });

const noDesign = (id: string): ApiError => notFound(`You have no Bot Design ${id}`);

const archived = (id: string): ApiError =>
  new ApiError(409, "design_archived", `Bot Design ${id} is archived and cannot be changed`);

/** One of the authenticated Player's designs with its latest Revision, or 404. */
function loadDesign(context: RequestContext, playerId: string): { design: DesignRecord; latest: RevisionRecord } {
  const id = context.params.designId ?? "";
  const garage = context.services.db.garage;
  const design = garage.getDesign(playerId, id);
  const latest = design === undefined ? undefined : garage.getRevision(playerId, id, design.latestRevision.number);
  if (design === undefined || latest === undefined) throw noDesign(id);
  return { design, latest };
}

// --- the module ------------------------------------------------------------

export const garageModule: ApiModule = {
  tags: [
    {
      name: TAG,
      description:
        "Your private Bot Designs and their immutable Revisions. Programs are visible only to their owner; " +
        "other Players' designs are indistinguishable from missing ones.",
    },
  ],
  schemas,
  routes: [
    {
      method: "POST",
      path: "/bot-designs",
      operation: {
        operationId: "createBotDesign",
        summary: "Create a Bot Design with its first Revision",
        description:
          "Validates the Build (parts exist, Components fit their Slots, cost within the Ruleset's largest Point " +
          "Budget) and checks the Program; on any problem nothing is saved and every problem is listed in " +
          "`details`. Program problems have path `program` plus `line` and `column`.",
        tags: [TAG],
        security: bearer,
        requestBody: { required: true, content: jsonContent(ref("NewBotDesign")) },
        responses: {
          "201": { description: "The new design, at Revision 1.", content: jsonContent(ref("BotDesign")) },
          "401": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const fields = ["name", "rulesetVersion", "build", "program"];
        const body = readObject(await context.readJson(), fields, fields);
        const details: ErrorDetail[] = [];
        const name = readName(body.name, details);
        const hosted = readRuleset(context, body.rulesetVersion, details);
        const checked = hosted === undefined ? undefined : checkDesign(hosted, body.build, body.program);
        if (checked !== undefined && !checked.ok) details.push(...checked.problems);
        if (details.length > 0 || name === undefined || hosted === undefined || checked?.ok !== true) {
          throw validationFailed(details);
        }

        const { design, revision } = context.services.db.garage.createDesign(
          { id: randomUUID(), playerId: player.id, name, rulesetVersion: hosted.ruleset.version },
          { build: checked.build, program: checked.program, cost: checked.cost },
          new Date(),
        );
        return { status: 201, body: designJson(design, revision) };
      },
    },
    {
      method: "GET",
      path: "/bot-designs",
      operation: {
        operationId: "listBotDesigns",
        summary: "List your Bot Designs",
        description: "Archived designs are left out unless `includeArchived` is true. Programs are not included.",
        tags: [TAG],
        security: bearer,
        parameters: [
          {
            name: "includeArchived",
            in: "query",
            required: false,
            schema: { type: "boolean", default: false },
          },
          {
            name: "rulesetVersion",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Only designs authored against this Ruleset version.",
          },
        ],
        responses: {
          "200": { description: "Your designs, most recently changed first.", content: jsonContent(ref("BotDesignList")) },
          "400": errorResponse,
          "401": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const query = context.url.searchParams;
        const includeArchived = query.get("includeArchived");
        if (includeArchived !== null && includeArchived !== "true" && includeArchived !== "false") {
          throw badRequest('includeArchived must be "true" or "false"');
        }
        const rulesetVersion = query.get("rulesetVersion");
        const designs = context.services.db.garage.listDesigns(player.id, {
          includeArchived: includeArchived === "true",
          ...(rulesetVersion === null ? {} : { rulesetVersion }),
        });
        return { body: { botDesigns: designs.map(designSummaryJson) } };
      },
    },
    {
      method: "GET",
      path: "/bot-designs/{designId}",
      operation: {
        operationId: "getBotDesign",
        summary: "Get one of your Bot Designs with its latest Revision",
        description: "Archived designs can still be read.",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter],
        responses: {
          "200": { description: "The design.", content: jsonContent(ref("BotDesign")) },
          "401": errorResponse,
          "404": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const { design, latest } = loadDesign(context, player.id);
        return { body: designJson(design, latest) };
      },
    },
    {
      method: "PATCH",
      path: "/bot-designs/{designId}",
      operation: {
        operationId: "renameBotDesign",
        summary: "Rename one of your Bot Designs",
        description: "The name belongs to the design, not a Revision, so renaming adds no Revision.",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter],
        requestBody: { required: true, content: jsonContent(ref("BotDesignUpdate")) },
        responses: {
          "200": { description: "The renamed design.", content: jsonContent(ref("BotDesign")) },
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const body = readObject(await context.readJson(), ["name"], ["name"]);
        const details: ErrorDetail[] = [];
        const name = readName(body.name, details);
        if (name === undefined) throw validationFailed(details);
        const garage = context.services.db.garage;
        return context.services.db.transaction(() => {
          const { design } = loadDesign(context, player.id);
          if (design.archivedAt !== null) throw archived(design.id);
          garage.renameDesign(player.id, design.id, name, new Date());
          const renamed = loadDesign(context, player.id);
          return { body: designJson(renamed.design, renamed.latest) };
        });
      },
    },
    {
      method: "DELETE",
      path: "/bot-designs/{designId}",
      operation: {
        operationId: "archiveBotDesign",
        summary: "Archive one of your Bot Designs",
        description:
          "Deleting a design archives it: it is left out of listings, accepts no new Revisions, and cannot be used " +
          "in new Entries. It and its Revisions remain readable, since Games may reference them. Archiving an " +
          "archived design does nothing.",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter],
        responses: { "204": { description: "Archived." }, "401": errorResponse, "404": errorResponse },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const id = context.params.designId ?? "";
        if (!context.services.db.garage.archiveDesign(player.id, id, new Date())) throw noDesign(id);
        return {};
      },
    },
    {
      method: "POST",
      path: "/bot-designs/{designId}/revisions",
      operation: {
        operationId: "createBotDesignRevision",
        summary: "Save an edit to one of your Bot Designs as a new Revision",
        description:
          "Validated exactly as when creating a design, under the design's Ruleset version. Earlier Revisions are " +
          "unchanged.",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter],
        requestBody: { required: true, content: jsonContent(ref("NewBotDesignRevision")) },
        responses: {
          "201": { description: "The new Revision.", content: jsonContent(ref("BotDesignRevision")) },
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const body = readObject(await context.readJson(), ["build", "program"], ["build", "program"]);
        const { design } = loadDesign(context, player.id);
        if (design.archivedAt !== null) throw archived(design.id);
        const hosted = context.services.rulesets.get(design.rulesetVersion);
        if (hosted === undefined) {
          throw new ApiError(
            409,
            "ruleset_not_hosted",
            `Ruleset ${design.rulesetVersion} is no longer hosted; copy the design to a hosted Ruleset`,
          );
        }
        const checked = checkDesign(hosted, body.build, body.program);
        if (!checked.ok) throw validationFailed(checked.problems);

        const result = context.services.db.garage.addRevision(
          player.id,
          design.id,
          { build: checked.build, program: checked.program, cost: checked.cost },
          new Date(),
        );
        if (result === undefined) throw noDesign(design.id);
        if (result === "archived") throw archived(design.id);
        return { status: 201, body: revisionJson(result) };
      },
    },
    {
      method: "GET",
      path: "/bot-designs/{designId}/revisions",
      operation: {
        operationId: "listBotDesignRevisions",
        summary: "List the Revisions of one of your Bot Designs",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter],
        responses: {
          "200": { description: "The Revisions, newest first.", content: jsonContent(ref("BotDesignRevisionList")) },
          "401": errorResponse,
          "404": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const id = context.params.designId ?? "";
        const revisions = context.services.db.garage.listRevisions(player.id, id);
        if (revisions === undefined) throw noDesign(id);
        return { body: { revisions: revisions.map(revisionSummaryJson) } };
      },
    },
    {
      method: "GET",
      path: "/bot-designs/{designId}/revisions/{revision}",
      operation: {
        operationId: "getBotDesignRevision",
        summary: "Get one Revision of one of your Bot Designs, with its Build and Program",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter, revisionParameter],
        responses: {
          "200": { description: "The Revision.", content: jsonContent(ref("BotDesignRevision")) },
          "401": errorResponse,
          "404": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const id = context.params.designId ?? "";
        const number = revisionNumber(context.params.revision);
        const revision = number === undefined ? undefined : context.services.db.garage.getRevision(player.id, id, number);
        if (revision === undefined) {
          throw notFound(`You have no Bot Design ${id} with Revision ${context.params.revision ?? ""}`);
        }
        return { body: revisionJson(revision) };
      },
    },
    {
      method: "POST",
      path: "/bot-designs/{designId}/copies",
      operation: {
        operationId: "copyBotDesignToRuleset",
        summary: "Copy one of your Bot Designs to another Ruleset version",
        description:
          "Re-validates a Revision (the latest by default) under the target Ruleset. If it is valid there, it is " +
          "saved as a new design in that version, at Revision 1, and the source is untouched. Otherwise nothing " +
          "is saved and the response is 422 `copy_has_problems` listing every problem (removed Components, a " +
          "cost over the largest Point Budget, unknown built-ins, ...). With `dryRun` the report is returned " +
          "with 200 and nothing is saved either way. Archived designs can be copied.",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter],
        requestBody: { required: true, content: jsonContent(ref("CopyToRuleset")) },
        responses: {
          "200": { description: "The dry-run report.", content: jsonContent(ref("CopyReport")) },
          "201": { description: "The copy and its (clean) report.", content: jsonContent(ref("CopiedBotDesign")) },
          "401": errorResponse,
          "404": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const body = readObject(await context.readJson(), ["rulesetVersion", "revision", "name", "dryRun"], [
          "rulesetVersion",
        ]);
        const details: ErrorDetail[] = [];
        const hosted = readRuleset(context, body.rulesetVersion, details);
        const name = body.name === undefined ? undefined : readName(body.name, details);
        if (body.revision !== undefined && !(Number.isSafeInteger(body.revision) && Number(body.revision) >= 1)) {
          details.push({ path: "revision", message: "must be a positive integer" });
        }
        if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
          details.push({ path: "dryRun", message: "must be a boolean" });
        }
        if (details.length > 0 || hosted === undefined) throw validationFailed(details);

        const { design, latest } = loadDesign(context, player.id);
        const garage = context.services.db.garage;
        const source =
          body.revision === undefined ? latest : garage.getRevision(player.id, design.id, Number(body.revision));
        if (source === undefined) {
          throw notFound(`Bot Design ${design.id} has no Revision ${String(body.revision)}`);
        }

        const checked = checkDesign(hosted, source.build, source.program);
        const report = {
          rulesetVersion: hosted.ruleset.version,
          sourceRevision: source.number,
          ok: checked.ok,
          cost: checked.cost,
          problems: checked.ok ? [] : checked.problems,
        };
        if (body.dryRun === true) return { body: report };
        if (!checked.ok) {
          throw new ApiError(
            422,
            "copy_has_problems",
            `Revision ${String(source.number)} is not valid under Ruleset ${hosted.ruleset.version}`,
            checked.problems,
          );
        }

        const copy = garage.createDesign(
          {
            id: randomUUID(),
            playerId: player.id,
            name: name ?? design.name,
            rulesetVersion: hosted.ruleset.version,
            copiedFrom: { designId: design.id, revision: source.number },
          },
          { build: checked.build, program: checked.program, cost: checked.cost },
          new Date(),
        );
        return { status: 201, body: { botDesign: designJson(copy.design, copy.revision), report } };
      },
    },
  ],
};
