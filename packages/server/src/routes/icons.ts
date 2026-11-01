/**
 * Bot Design Icons: one optional square PNG per Bot Design, shown next to its
 * Bots' names.
 *
 * The Icon belongs to the design, not a Revision: it is always current,
 * setting it adds no Revision, and Game Records and Replays never copy it.
 * Bot Design responses carry `icon`, the SHA-256 hex hash of the image (or
 * null), and so does every GameEntryBot whose Build is shown, read fresh
 * from the design. The image is fetched by hash alone, by any authenticated
 * Player, so a client can cache it for as long as the hash is unchanged.
 *
 * Images are stored once per hash and shared by every design with that
 * hash (Copy to Ruleset keeps the Icon, for one). Replacing or clearing an
 * Icon deletes the old image only once no design references it.
 *
 * Uploads are checked and stripped by `checkImagePng`, exactly as Emblems
 * are. Taking an Icon down is done by deleting its stored object; fetching it
 * then answers 404 and clients draw nothing.
 */

import { createHash } from "node:crypto";
import { authenticate } from "../accounts/auth.js";
import { checkImagePng, IMAGE_MAX_BYTES, IMAGE_MAX_SIZE, IMAGE_MIN_SIZE } from "../images/png.js";
import { notFound, validationFailed } from "../http/errors.js";
import type { ApiModule, Json, RequestContext } from "../http/router.js";
import { designJson, loadDesign } from "./garage.js";

const PNG = "image/png";
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const errorResponse: Json = { $ref: "#/components/responses/Error" };
const bearer: readonly Json[] = [{ bearerAuth: [] }];
const TAG = "Icons";
const designIdParameter: Json = { name: "designId", in: "path", required: true, schema: { type: "string" } };

/** Where the Icon with this hash is stored. */
export const iconKey = (hash: string): string => `icons/${hash}.png`;

/**
 * Runs `fn` once every earlier call for the same hash has settled, so that
 * storing an image and deciding it is unused (then deleting it) never
 * interleave. The server is a single process, so an in-memory queue is
 * enough.
 */
const queues = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(hash: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(hash) ?? Promise.resolve()).then(fn, fn);
  const settled = run.catch(() => undefined);
  queues.set(hash, settled);
  try {
    return await run;
  } finally {
    if (queues.get(hash) === settled) queues.delete(hash);
  }
}

/** Deletes the image with this hash unless a design still has it as its Icon. */
async function release(context: RequestContext, hash: string): Promise<void> {
  const { db, objects } = context.services;
  await oneAtATime(hash, async () => {
    if (!db.garage.iconInUse(hash)) await objects.delete(iconKey(hash));
  });
}

export const iconsModule: ApiModule = {
  tags: [{ name: TAG, description: "Bot Design Icons: a small square PNG shown next to the design's Bots." }],
  routes: [
    {
      method: "PUT",
      path: "/bot-designs/{designId}/icon",
      operation: {
        operationId: "setBotDesignIcon",
        summary: "Set or replace the Icon of one of your Bot Designs",
        description:
          `The body is the PNG file itself: square, ${String(IMAGE_MIN_SIZE)} to ${String(IMAGE_MAX_SIZE)} ` +
          `pixels a side, at most ${String(IMAGE_MAX_BYTES)} bytes. Only the chunks needed to draw it are kept ` +
          "(IHDR, PLTE, tRNS, IDAT, IEND); metadata such as text and EXIF is dropped. The Icon belongs to the " +
          "design, not a Revision, so this adds no Revision, and archived designs can be changed too.",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter],
        requestBody: { required: true, content: { [PNG]: { schema: { type: "string", format: "binary" } } } },
        responses: {
          "200": { description: "The design with its new Icon.", content: { "application/json": { schema: ref("BotDesign") } } },
          "401": errorResponse,
          "404": errorResponse,
          "413": errorResponse,
          "415": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const { design } = loadDesign(context, player.id);
        const checked = checkImagePng(await context.readBytes(PNG, IMAGE_MAX_BYTES));
        if ("problem" in checked) throw validationFailed([{ path: "(body)", message: checked.problem }]);

        const hash = createHash("sha256").update(checked.png).digest("hex");
        const { objects, db } = context.services;
        const set = await oneAtATime(hash, async () => {
          await objects.put(iconKey(hash), checked.png);
          return db.garage.setIcon(player.id, design.id, hash, new Date());
        });
        if (set === undefined) {
          await release(context, hash);
          throw notFound(`You have no Bot Design ${design.id}`);
        }
        if (set.previous !== null && set.previous !== hash) await release(context, set.previous);
        const updated = loadDesign(context, player.id);
        return { body: designJson(updated.design, updated.latest) };
      },
    },
    {
      method: "DELETE",
      path: "/bot-designs/{designId}/icon",
      operation: {
        operationId: "clearBotDesignIcon",
        summary: "Remove the Icon of one of your Bot Designs",
        description: "Removing an Icon the design does not have is not an error. Archived designs can be changed too.",
        tags: [TAG],
        security: bearer,
        parameters: [designIdParameter],
        responses: { "204": { description: "The design has no Icon." }, "401": errorResponse, "404": errorResponse },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const id = context.params.designId ?? "";
        const set = context.services.db.garage.setIcon(player.id, id, null, new Date());
        if (set === undefined) throw notFound(`You have no Bot Design ${id}`);
        if (set.previous !== null) await release(context, set.previous);
        return {};
      },
    },
    {
      method: "GET",
      path: "/icons/{hash}",
      operation: {
        operationId: "getIcon",
        summary: "Get a Bot Design Icon image",
        description:
          "`hash` is the `icon` field of a Bot Design or a Game Entry's Bot. The image never changes for a given " +
          "hash, so it may be cached. 404 when no Icon has that hash, including one no longer used or taken down.",
        tags: [TAG],
        security: bearer,
        parameters: [{ name: "hash", in: "path", required: true, schema: { type: "string", pattern: HASH_PATTERN.source } }],
        responses: {
          "200": { description: "The Icon.", content: { [PNG]: { schema: { type: "string", format: "binary" } } } },
          "401": errorResponse,
          "404": errorResponse,
        },
      },
      handler: async (context) => {
        authenticate(context);
        const hash = context.params.hash ?? "";
        const image = HASH_PATTERN.test(hash) ? await context.services.objects.get(iconKey(hash)) : undefined;
        if (image === undefined) throw notFound(`There is no Icon ${hash}`);
        return {
          bytes: { type: PNG, content: image },
          headers: { "x-content-type-options": "nosniff", "cache-control": "private, max-age=86400" },
        };
      },
    },
  ],
};
