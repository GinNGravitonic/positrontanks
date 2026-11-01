/**
 * `positrontanks players` (docs/spec/cli-api.md): the authenticated Player's
 * own settings, so far only the Emblem.
 *
 * `emblem set` sends the file as is; the server checks it (a square PNG,
 * 32 to 256 pixels a side, at most 64 KB) and strips its metadata, so the
 * CLI does not check it first.
 */

import type { Schema } from "./client.js";
import { emit, readBinaryInput, type Group } from "./context.js";

type Player = Schema<"Player">;

export const playersCommands: Group = {
  "emblem set": {
    synopsis: "FILE",
    summary: "Set or replace your Emblem from a PNG file (PUT /players/me/emblem)",
    args: ["FILE"],
    run: async (context, [file = ""]) => {
      const content = await readBinaryInput(file);
      const player = await context.client.request<Player>("PUT", "/players/me/emblem", { auth: true, bytes: { type: "image/png", content } });
      emit(context, player, () => [`Set the Emblem of ${player.username} (Emblem ${player.emblem ?? "none"}).`]);
    },
  },

  "emblem clear": {
    synopsis: "",
    summary: "Remove your Emblem (DELETE /players/me/emblem)",
    run: async (context) => {
      await context.client.request("DELETE", "/players/me/emblem", { auth: true });
      emit(context, {}, () => ["Removed your Emblem."]);
    },
  },
};
