/**
 * Player Emblems: one optional square PNG per Player, shown wherever the
 * Player appears.
 *
 * Every Player reference in the API carries `emblem`, the SHA-256 hex hash of
 * the Player's current Emblem (or null). The image is fetched by Player and
 * hash, so a client can cache it for as long as the hash is unchanged. Only
 * the current Emblem is stored: replacing or removing it deletes the old
 * image, and Game Records and Replays never copy it.
 *
 * Uploads are checked and stripped by `checkEmblemPng`. Taking an Emblem
 * down is done by deleting its stored object; fetching it then answers 404
 * and clients fall back to their placeholder.
 */

import { createHash } from "node:crypto";
import { authenticate } from "../accounts/auth.js";
import { checkEmblemPng, EMBLEM_MAX_BYTES, EMBLEM_MAX_SIZE, EMBLEM_MIN_SIZE } from "../emblems/png.js";
import { notFound, validationFailed } from "../http/errors.js";
import type { ApiModule, Json } from "../http/router.js";
import { playerJson } from "./accounts.js";

const PNG = "image/png";
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const errorResponse: Json = { $ref: "#/components/responses/Error" };
const bearer: readonly Json[] = [{ bearerAuth: [] }];
const TAG = "Emblems";

/** Where a Player's Emblem with this hash is stored. */
export const emblemKey = (playerId: string, hash: string): string => `emblems/${playerId}/${hash}.png`;

export const emblemsModule: ApiModule = {
  tags: [{ name: TAG, description: "Player Emblems: a small square PNG shown wherever the Player appears." }],
  routes: [
    {
      method: "PUT",
      path: "/players/me/emblem",
      operation: {
        operationId: "setEmblem",
        summary: "Set or replace the authenticated Player's Emblem",
        description:
          `The body is the PNG file itself: square, ${String(EMBLEM_MIN_SIZE)} to ${String(EMBLEM_MAX_SIZE)} ` +
          `pixels a side, at most ${String(EMBLEM_MAX_BYTES)} bytes. Only the chunks needed to draw it are kept ` +
          "(IHDR, PLTE, tRNS, IDAT, IEND); metadata such as text and EXIF is dropped. Replacing an Emblem deletes " +
          "the old one.",
        tags: [TAG],
        security: bearer,
        requestBody: { required: true, content: { [PNG]: { schema: { type: "string", format: "binary" } } } },
        responses: {
          "200": { description: "The Player with its new Emblem.", content: { "application/json": { schema: ref("Player") } } },
          "401": errorResponse,
          "413": errorResponse,
          "415": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const checked = checkEmblemPng(await context.readBytes(PNG, EMBLEM_MAX_BYTES));
        if ("problem" in checked) throw validationFailed([{ path: "(body)", message: checked.problem }]);

        const hash = createHash("sha256").update(checked.png).digest("hex");
        const { objects, db } = context.services;
        await objects.put(emblemKey(player.id, hash), checked.png);
        const old = db.accounts.setEmblem(player.id, hash);
        if (old !== null && old !== hash) await objects.delete(emblemKey(player.id, old));
        return { body: playerJson({ ...player, emblem: hash }) };
      },
    },
    {
      method: "DELETE",
      path: "/players/me/emblem",
      operation: {
        operationId: "clearEmblem",
        summary: "Remove the authenticated Player's Emblem",
        description: "Removing an Emblem the Player does not have is not an error.",
        tags: [TAG],
        security: bearer,
        responses: { "204": { description: "The Player has no Emblem." }, "401": errorResponse },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const old = context.services.db.accounts.setEmblem(player.id, null);
        if (old !== null) await context.services.objects.delete(emblemKey(player.id, old));
        return {};
      },
    },
    {
      method: "GET",
      path: "/players/{playerId}/emblem/{hash}",
      operation: {
        operationId: "getEmblem",
        summary: "Get a Player's Emblem image",
        description:
          "`hash` is the `emblem` field of a Player reference. The image never changes for a given hash, so it " +
          "may be cached. 404 when the Player has no such Emblem, including one that was replaced or taken down.",
        tags: [TAG],
        security: bearer,
        parameters: [
          { name: "playerId", in: "path", required: true, schema: { type: "string" } },
          { name: "hash", in: "path", required: true, schema: { type: "string", pattern: HASH_PATTERN.source } },
        ],
        responses: {
          "200": { description: "The Emblem.", content: { [PNG]: { schema: { type: "string", format: "binary" } } } },
          "401": errorResponse,
          "404": errorResponse,
        },
      },
      handler: async (context) => {
        authenticate(context);
        const playerId = context.params.playerId ?? "";
        const hash = context.params.hash ?? "";
        const player = context.services.db.accounts.getPlayer(playerId);
        const image =
          player === undefined || !HASH_PATTERN.test(hash)
            ? undefined
            : await context.services.objects.get(emblemKey(player.id, hash));
        if (image === undefined) throw notFound(`Player ${playerId} has no Emblem ${hash}`);
        return {
          bytes: { type: PNG, content: image },
          headers: { "x-content-type-options": "nosniff", "cache-control": "private, max-age=86400" },
        };
      },
    },
  ],
};
