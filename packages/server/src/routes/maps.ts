/**
 * Maps and Map Revisions (spec sections 6 and 9).
 *
 * Maps are readable by anyone, signed in or not: listing, getting a Map, and
 * reading its Revisions need no credential. Creating a Map needs a Player,
 * who becomes its creator; only the creator may add Revisions, rename or
 * describe it, or archive it. Since a Map's existence is public, another
 * Player trying to change it is answered 403 `forbidden`, not 404. The name
 * and description belong to the Map, not a Revision, and are public like the
 * rest of it; changing them adds no Revision and is allowed on archived Maps
 * too.
 *
 * Saving (creating a Map or a new Revision) validates the content as Map
 * Format 1 with ruleset-data's validateMap under the server's Map size
 * limits, and rejects the save with every problem listed. Map Formats are
 * independent of Rulesets, so Terrain names are not checked against any
 * Ruleset here; that happens when a Game picks a Ruleset and a Map Revision.
 * Revisions are immutable and numbered from 1; editing a Map always adds a
 * Revision.
 *
 * "Deleting" a Map archives it: it disappears from listings (unless asked
 * for) and accepts no new Revisions, but it and its Revisions stay readable
 * by everyone, since Games may reference them. A Revision no Game uses,
 * other than the latest, may be truly deleted by the creator.
 */

import { randomUUID } from "node:crypto";
import { validateMap, type MapFormat1 } from "@aumohta/ruleset-data";
import { authenticate } from "../accounts/auth.js";
import { USERNAME_PATTERN } from "./accounts.js";
import type { MapRecord, MapRevisionRecord, MapRevisionSummary } from "../db/maps.js";
import {
  ApiError,
  badRequest,
  forbidden,
  notFound,
  validationFailed,
  type ErrorDetail,
} from "../http/errors.js";
import type { ApiModule, Json, RequestContext } from "../http/router.js";
import { descriptionSchema, readChanges, readDescription } from "./description.js";

export const MAP_NAME_MAX_LENGTH = 64;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: Json): Json => ({ "application/json": { schema } });
const errorResponse: Json = { $ref: "#/components/responses/Error" };
const bearer: readonly Json[] = [{ bearerAuth: [] }];
const TAG = "Maps";

const mapIdParameter: Json = { name: "mapId", in: "path", required: true, schema: { type: "string" } };
const revisionParameter: Json = {
  name: "revision",
  in: "path",
  required: true,
  schema: { type: "integer", minimum: 1 },
  description: "The Revision number.",
};

const nameSchema: Json = { type: "string", minLength: 1, maxLength: MAP_NAME_MAX_LENGTH };
const timestamp: Json = { type: "string", format: "date-time" };

const point: Json = {
  type: "object",
  required: ["x", "y"],
  additionalProperties: false,
  properties: { x: { type: "number" }, y: { type: "number" } },
};

/** The geometry every Map feature carries next to its own fields. */
const shapeProperties: Record<string, Json> = {
  shape: { type: "string", enum: ["polygon", "circle"] },
  points: {
    type: "array",
    minItems: 3,
    items: point,
    description: 'For `shape: "polygon"`: a simple, non-degenerate polygon.',
  },
  x: { type: "number", description: 'For `shape: "circle"`: the centre.' },
  y: { type: "number", description: 'For `shape: "circle"`: the centre.' },
  radius: { type: "number", exclusiveMinimum: 0, description: 'For `shape: "circle"`.' },
};

const shapeNote = 'Either `shape: "polygon"` with `points`, or `shape: "circle"` with `x`, `y` and `radius`.';

const schemas: Record<string, Json> = {
  MapFormat1: {
    type: "object",
    description:
      "A Map in Map Format 1. A rectangle [0, width] x [0, height] in meters, origin top-left, y down. " +
      "Every feature must lie within the bounds; Spawn Zones may not touch or overlap Obstacles or each other; " +
      "at least 2 Spawn Zones. Unknown fields are errors. The server's Map size limits also apply.",
    required: ["format", "width", "height", "baseTerrain", "terrainRegions", "obstacles", "spawnZones"],
    additionalProperties: false,
    properties: {
      format: { const: 1 },
      width: { type: "number", exclusiveMinimum: 0 },
      height: { type: "number", exclusiveMinimum: 0 },
      baseTerrain: { type: "string", minLength: 1, description: "The Terrain everywhere no Terrain Region covers." },
      terrainRegions: {
        type: "array",
        description: `Later-listed regions win where they overlap. ${shapeNote}`,
        items: {
          type: "object",
          required: ["terrain", "shape"],
          additionalProperties: false,
          properties: { terrain: { type: "string", minLength: 1 }, ...shapeProperties },
        },
      },
      obstacles: {
        type: "array",
        description: `Permanent, or destructible with Hit Points. ${shapeNote}`,
        items: {
          type: "object",
          required: ["id", "destructible", "shape"],
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Unique within the Map." },
            destructible: { type: "boolean" },
            hitPoints: { type: "number", exclusiveMinimum: 0, description: "Required on, and only on, destructible Obstacles." },
            ...shapeProperties,
          },
        },
      },
      spawnZones: {
        type: "array",
        minItems: 2,
        description: `One per supported Player. ${shapeNote}`,
        items: {
          type: "object",
          required: ["heading", "capacity", "shape"],
          additionalProperties: false,
          properties: {
            heading: { type: "number", minimum: 0, exclusiveMaximum: 360, description: "Starting Heading, degrees." },
            capacity: { type: "integer", minimum: 1, description: "The most Bots one Entry may place here." },
            ...shapeProperties,
          },
        },
      },
    },
  },
  MapRevision: {
    type: "object",
    description: "An immutable snapshot of a Map.",
    required: ["mapId", "number", "map", "createdAt"],
    additionalProperties: false,
    properties: {
      mapId: { type: "string" },
      number: { type: "integer", minimum: 1 },
      map: ref("MapFormat1"),
      createdAt: timestamp,
    },
  },
  MapRevisionSummary: {
    type: "object",
    required: ["number", "format", "width", "height", "spawnZones", "createdAt"],
    additionalProperties: false,
    properties: {
      number: { type: "integer", minimum: 1 },
      format: { type: "integer", description: "The Map Format." },
      width: { type: "number" },
      height: { type: "number" },
      spawnZones: { type: "integer", description: "How many Spawn Zones, and so at most how many Players." },
      createdAt: timestamp,
    },
  },
  MapCreator: {
    type: "object",
    required: ["id", "username"],
    additionalProperties: false,
    properties: { id: { type: "string" }, username: { type: "string" } },
  },
  MapSummary: {
    type: "object",
    required: ["id", "name", "description", "creator", "latestRevision", "createdAt", "updatedAt", "archivedAt"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: descriptionSchema,
      creator: ref("MapCreator"),
      latestRevision: ref("MapRevisionSummary"),
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: { type: ["string", "null"], format: "date-time", description: "Set once the Map is archived." },
    },
  },
  Map: {
    type: "object",
    required: ["id", "name", "description", "creator", "latestRevision", "createdAt", "updatedAt", "archivedAt"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: descriptionSchema,
      creator: ref("MapCreator"),
      latestRevision: ref("MapRevision"),
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: { type: ["string", "null"], format: "date-time", description: "Set once the Map is archived." },
    },
  },
  MapList: {
    type: "object",
    required: ["maps"],
    additionalProperties: false,
    properties: { maps: { type: "array", items: ref("MapSummary") } },
  },
  MapRevisionList: {
    type: "object",
    required: ["revisions"],
    additionalProperties: false,
    properties: { revisions: { type: "array", items: ref("MapRevisionSummary") } },
  },
  NewMap: {
    type: "object",
    required: ["name", "map"],
    additionalProperties: false,
    properties: { name: nameSchema, description: { ...descriptionSchema, default: "" }, map: ref("MapFormat1") },
  },
  MapUpdate: {
    type: "object",
    description: "The fields to change; at least one. Fields left out are kept.",
    minProperties: 1,
    additionalProperties: false,
    properties: { name: nameSchema, description: descriptionSchema },
  },
  NewMapRevision: {
    type: "object",
    required: ["map"],
    additionalProperties: false,
    properties: { map: ref("MapFormat1") },
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

/** A trimmed Map name, or undefined after recording a problem. */
function readName(value: unknown, details: ErrorDetail[]): string | undefined {
  if (typeof value !== "string") {
    details.push({ path: "name", message: "must be a string" });
    return undefined;
  }
  const name = value.trim();
  if (name.length === 0 || name.length > MAP_NAME_MAX_LENGTH) {
    details.push({ path: "name", message: `must be 1 to ${String(MAP_NAME_MAX_LENGTH)} characters` });
    return undefined;
  }
  return name;
}

/**
 * The content as a valid Map Format 1 Map, or undefined after recording
 * every problem. Problem paths start with `map`, which is also the request
 * field holding the content.
 */
function readMap(context: RequestContext, value: unknown, details: ErrorDetail[]): MapFormat1 | undefined {
  const result = validateMap(value, context.services.config.limits.map);
  if (result.ok) return result.map;
  details.push(...result.errors);
  return undefined;
}

function revisionNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9]\d{0,8}$/.test(raw)) return undefined;
  return Number(raw);
}

// --- responses -------------------------------------------------------------

const revisionSummaryJson = (r: MapRevisionSummary): Json => ({
  number: r.number,
  format: r.format,
  width: r.width,
  height: r.height,
  spawnZones: r.spawnZones,
  createdAt: r.createdAt,
});

const revisionJson = (r: MapRevisionRecord): Json => ({
  mapId: r.mapId,
  number: r.number,
  map: r.map as unknown as Json,
  createdAt: r.createdAt,
});

const mapFields = (m: MapRecord): Record<string, Json> => ({
  id: m.id,
  name: m.name,
  description: m.description,
  creator: { id: m.creator.id, username: m.creator.username },
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
  archivedAt: m.archivedAt,
});

const mapSummaryJson = (m: MapRecord): Json => ({ ...mapFields(m), latestRevision: revisionSummaryJson(m.latestRevision) });

const mapJson = (m: MapRecord, latest: MapRevisionRecord): Json => ({ ...mapFields(m), latestRevision: revisionJson(latest) });

const noMap = (id: string): ApiError => notFound(`There is no Map ${id}`);

const notCreator = (id: string): ApiError => forbidden(`Only the creator of Map ${id} can change it`);

const archived = (id: string): ApiError => new ApiError(409, "map_archived", `Map ${id} is archived and cannot be changed`);

/** A Map with its latest Revision, or 404. */
function loadMap(context: RequestContext): { map: MapRecord; latest: MapRevisionRecord } {
  const id = context.params.mapId ?? "";
  const maps = context.services.db.maps;
  const map = maps.getMap(id);
  const latest = map === undefined ? undefined : maps.getRevision(id, map.latestRevision.number);
  if (map === undefined || latest === undefined) throw noMap(id);
  return { map, latest };
}

// --- the module ------------------------------------------------------------

export const mapsModule: ApiModule = {
  tags: [
    {
      name: TAG,
      description:
        "Maps and their immutable Revisions. Anyone may read Maps; only a Map's creator may add Revisions, " +
        "rename or describe it, or archive it.",
    },
  ],
  schemas,
  routes: [
    {
      method: "POST",
      path: "/maps",
      operation: {
        operationId: "createMap",
        summary: "Create a Map with its first Revision",
        description:
          "Validates the content as Map Format 1 under this server's Map size limits; on any problem nothing is " +
          "saved and every problem is listed in `details`, with paths such as `map.obstacles[2].hitPoints`. " +
          "Terrain names are checked against a Ruleset only when a Game uses the Map.",
        tags: [TAG],
        security: bearer,
        requestBody: { required: true, content: jsonContent(ref("NewMap")) },
        responses: {
          "201": { description: "The new Map, at Revision 1.", content: jsonContent(ref("Map")) },
          "401": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const body = readObject(await context.readJson(), ["name", "description", "map"], ["name", "map"]);
        const details: ErrorDetail[] = [];
        const name = readName(body.name, details);
        const description = body.description === undefined ? "" : readDescription(body.description, details);
        const content = readMap(context, body.map, details);
        if (details.length > 0 || name === undefined || description === undefined || content === undefined) {
          throw validationFailed(details);
        }

        const { map, revision } = context.services.db.maps.createMap(
          { id: randomUUID(), playerId: player.id, name, description },
          content,
          new Date(),
        );
        return { status: 201, body: mapJson(map, revision) };
      },
    },
    {
      method: "GET",
      path: "/maps",
      operation: {
        operationId: "listMaps",
        summary: "List Maps",
        description:
          "Anyone may list Maps; no credential is needed. Archived Maps are left out unless `includeArchived` is " +
          "true. Map content is not included.",
        tags: [TAG],
        security: [],
        parameters: [
          {
            name: "includeArchived",
            in: "query",
            required: false,
            schema: { type: "boolean", default: false },
          },
          {
            name: "creator",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Only Maps created by the Player with this username.",
          },
        ],
        responses: {
          "200": { description: "Maps, most recently changed first.", content: jsonContent(ref("MapList")) },
          "400": errorResponse,
        },
      },
      handler: (context) => {
        const query = context.url.searchParams;
        const includeArchived = query.get("includeArchived");
        if (includeArchived !== null && includeArchived !== "true" && includeArchived !== "false") {
          throw badRequest('includeArchived must be "true" or "false"');
        }
        const creator = query.get("creator");
        // No Player can have a malformed username, so such a filter matches nothing.
        if (creator !== null && !USERNAME_PATTERN.test(creator)) return { body: { maps: [] } };
        const maps = context.services.db.maps.listMaps({
          includeArchived: includeArchived === "true",
          ...(creator === null ? {} : { creatorUsername: creator }),
        });
        return { body: { maps: maps.map(mapSummaryJson) } };
      },
    },
    {
      method: "GET",
      path: "/maps/{mapId}",
      operation: {
        operationId: "getMap",
        summary: "Get a Map with its latest Revision",
        description: "Anyone may read any Map, archived or not; no credential is needed.",
        tags: [TAG],
        security: [],
        parameters: [mapIdParameter],
        responses: {
          "200": { description: "The Map.", content: jsonContent(ref("Map")) },
          "404": errorResponse,
        },
      },
      handler: (context) => {
        const { map, latest } = loadMap(context);
        return { body: mapJson(map, latest) };
      },
    },
    {
      method: "DELETE",
      path: "/maps/{mapId}",
      operation: {
        operationId: "archiveMap",
        summary: "Archive a Map you created",
        description:
          "Deleting a Map archives it: it is left out of listings, accepts no new Revisions, and cannot be chosen " +
          "for new Games. It and its Revisions remain readable by everyone, since Games may reference them. " +
          "Archiving an archived Map does nothing. Only the Map's creator may archive it.",
        tags: [TAG],
        security: bearer,
        parameters: [mapIdParameter],
        responses: {
          "204": { description: "Archived." },
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const id = context.params.mapId ?? "";
        const result = context.services.db.maps.archiveMap(player.id, id, new Date());
        if (result === "not_found") throw noMap(id);
        if (result === "not_creator") throw notCreator(id);
        return {};
      },
    },
    {
      method: "PATCH",
      path: "/maps/{mapId}",
      operation: {
        operationId: "updateMap",
        summary: "Rename or describe a Map you created",
        description:
          "Changes the name and/or description; fields left out are kept. They belong to the Map, not a Revision, " +
          "so this adds no Revision, and archived Maps can be changed too. Both are public, like the rest of the " +
          "Map. Only the Map's creator may change them.",
        tags: [TAG],
        security: bearer,
        parameters: [mapIdParameter],
        requestBody: { required: true, content: jsonContent(ref("MapUpdate")) },
        responses: {
          "200": { description: "The updated Map.", content: jsonContent(ref("Map")) },
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const { map } = loadMap(context);
        if (map.creator.id !== player.id) throw notCreator(map.id);
        const changes = readChanges(readName, await context.readJson());
        const result = context.services.db.maps.updateMap(player.id, map.id, changes, new Date());
        if (result === "not_found") throw noMap(map.id);
        if (result === "not_creator") throw notCreator(map.id);
        const updated = loadMap(context);
        return { body: mapJson(updated.map, updated.latest) };
      },
    },
    {
      method: "POST",
      path: "/maps/{mapId}/revisions",
      operation: {
        operationId: "createMapRevision",
        summary: "Save an edit to a Map you created as a new Revision",
        description:
          "Validated exactly as when creating a Map. Earlier Revisions are unchanged, and Games that use them are " +
          "unaffected. Only the Map's creator may add Revisions.",
        tags: [TAG],
        security: bearer,
        parameters: [mapIdParameter],
        requestBody: { required: true, content: jsonContent(ref("NewMapRevision")) },
        responses: {
          "201": { description: "The new Revision.", content: jsonContent(ref("MapRevision")) },
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const { map } = loadMap(context);
        if (map.creator.id !== player.id) throw notCreator(map.id);
        if (map.archivedAt !== null) throw archived(map.id);
        const body = readObject(await context.readJson(), ["map"], ["map"]);
        const details: ErrorDetail[] = [];
        const content = readMap(context, body.map, details);
        if (content === undefined) throw validationFailed(details);

        const result = context.services.db.maps.addRevision(player.id, map.id, content, new Date());
        if (result === "not_found") throw noMap(map.id);
        if (result === "not_creator") throw notCreator(map.id);
        if (result === "archived") throw archived(map.id);
        return { status: 201, body: revisionJson(result) };
      },
    },
    {
      method: "GET",
      path: "/maps/{mapId}/revisions",
      operation: {
        operationId: "listMapRevisions",
        summary: "List the Revisions of a Map",
        description: "Anyone may list them; no credential is needed.",
        tags: [TAG],
        security: [],
        parameters: [mapIdParameter],
        responses: {
          "200": { description: "The Revisions, newest first.", content: jsonContent(ref("MapRevisionList")) },
          "404": errorResponse,
        },
      },
      handler: (context) => {
        const id = context.params.mapId ?? "";
        const revisions = context.services.db.maps.listRevisions(id);
        if (revisions === undefined) throw noMap(id);
        return { body: { revisions: revisions.map(revisionSummaryJson) } };
      },
    },
    {
      method: "GET",
      path: "/maps/{mapId}/revisions/{revision}",
      operation: {
        operationId: "getMapRevision",
        summary: "Get one Revision of a Map, with its content",
        description: "Anyone may read it; no credential is needed. Revisions never change once saved.",
        tags: [TAG],
        security: [],
        parameters: [mapIdParameter, revisionParameter],
        responses: {
          "200": { description: "The Revision.", content: jsonContent(ref("MapRevision")) },
          "404": errorResponse,
        },
      },
      handler: (context) => {
        const id = context.params.mapId ?? "";
        const number = revisionNumber(context.params.revision);
        const revision = number === undefined ? undefined : context.services.db.maps.getRevision(id, number);
        if (revision === undefined) {
          throw notFound(`There is no Map ${id} with Revision ${context.params.revision ?? ""}`);
        }
        return { body: revisionJson(revision) };
      },
    },
    {
      method: "DELETE",
      path: "/maps/{mapId}/revisions/{revision}",
      operation: {
        operationId: "deleteMapRevision",
        summary: "Delete a Revision of a Map you created that no Game uses",
        description:
          "Truly deletes the Revision; its number is not reused. Refused with 409 `revision_in_use` if any Game, " +
          "in any state, uses it, and with 409 `latest_revision` for the Map's latest Revision, which is its " +
          "current state (archive the Map instead). Only the Map's creator may delete Revisions; those of " +
          "archived Maps can be deleted too.",
        tags: [TAG],
        security: bearer,
        parameters: [mapIdParameter, revisionParameter],
        responses: {
          "204": { description: "Deleted." },
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const id = context.params.mapId ?? "";
        const number = revisionNumber(context.params.revision);
        const result = number === undefined ? "not_found" : context.services.db.maps.deleteRevision(player.id, id, number);
        const label = `Revision ${context.params.revision ?? ""} of Map ${id}`;
        if (result === "not_found") throw notFound(`There is no Map ${id} with Revision ${context.params.revision ?? ""}`);
        if (result === "not_creator") throw notCreator(id);
        if (result === "latest") {
          throw new ApiError(409, "latest_revision", `${label} is its latest Revision; archive the Map instead`);
        }
        if (result === "in_use") throw new ApiError(409, "revision_in_use", `${label} is used by a Game`);
        return {};
      },
    },
  ],
};
