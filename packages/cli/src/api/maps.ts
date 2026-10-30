/**
 * `positrontanks maps` (docs/spec/cli-api.md): Maps and their Revisions.
 *
 * `--map FILE` is Map Format JSON, the file `positrontanks run --map` reads, so a
 * Map tried locally is uploaded unchanged; `--out FILE` writes a Revision's
 * Map Format JSON back. Map reads need no credentials.
 */

import { fetchList, usageError, type Schema } from "./client.js";
import {
  ago,
  emit,
  flag,
  moreHint,
  PAGE_OPTIONS,
  pageOptions,
  readJsonInput,
  segment,
  str,
  textOptions,
  wholeNumber,
  writeOutput,
  type Context,
  type Group,
  type Values,
} from "./context.js";
import { table } from "../report.js";

type GameMap = Schema<"Map">;
type MapRevision = Schema<"MapRevision">;

const mapPath = (id: string) => `/maps/${segment(id)}`;
const revisionPath = (id: string, n: number) => `${mapPath(id)}/revisions/${String(n)}`;

const size = (r: { width: number; height: number }) => `${String(r.width)} x ${String(r.height)} m`;

function revisionLines(r: MapRevision, out: string | undefined): string[][] {
  return [
    ["Revision:", `${String(r.number)}, created ${ago(r.createdAt)}`],
    ...(r.notes === "" ? [] : [["notes:", r.notes]]),
    ["Map:", `Format ${String(r.map.format)}, ${size(r.map)}, ${String(r.map.spawnZones.length)} Spawn Zones, ${String(r.map.obstacles.length)} Obstacles`],
    ...(out === undefined ? [] : [["written to:", out]]),
  ];
}

async function saveMap(values: Values, revision: MapRevision): Promise<string | undefined> {
  const out = str(values, "out");
  if (out !== undefined) await writeOutput(out, `${JSON.stringify(revision.map, null, 2)}\n`);
  return out;
}

const readMap = (context: Context, values: Values) => {
  const file = str(values, "map");
  if (file === undefined) throw usageError("--map is required");
  return readJsonInput(context, file, "--map");
};

export const mapsCommands: Group = {
  create: {
    synopsis: "--name NAME --map FILE [--description TEXT] [--notes TEXT]",
    summary: "Create a Map with its Revision 1 (POST /maps)",
    options: { name: { type: "string" }, map: { type: "string" }, description: { type: "string" }, notes: { type: "string" } },
    run: async (context, _args, values) => {
      const name = str(values, "name");
      if (name === undefined) throw usageError("--name is required");
      const body = { name, map: await readMap(context, values), ...textOptions(values, "description", "notes") };
      const map = await context.client.request<GameMap>("POST", "/maps", { auth: true, body });
      emit(context, map, () => [`Created Map ${map.id} ("${map.name}"), ${size(map.latestRevision.map)}, ${String(map.latestRevision.map.spawnZones.length)} Spawn Zones.`]);
    },
  },

  list: {
    synopsis: "[--creator USERNAME] [--mine] [--include-archived] [--limit N] [--cursor CURSOR] [--all]",
    summary: "List Maps, newest first (GET /maps)",
    options: { creator: { type: "string" }, mine: { type: "boolean" }, "include-archived": { type: "boolean" }, ...PAGE_OPTIONS },
    run: async (context, _args, values) => {
      let creator = str(values, "creator");
      if (flag(values, "mine")) {
        if (creator !== undefined) throw usageError("give --creator or --mine, not both");
        creator = (await context.client.request<Schema<"Player">>("GET", "/players/me", { auth: true })).username;
      }
      const query = { creator, ...(flag(values, "include-archived") ? { includeArchived: true } : {}) };
      const list = await fetchList<"maps", Schema<"MapSummary">>(context.client, "/maps", "maps", pageOptions(values), { query });
      emit(context, list, () =>
        list.maps.length === 0
          ? ["No Maps."]
          : table(
              [
                ["ID", "Name", "Creator", "Revision", "Size", "Spawn Zones", "Updated", ""],
                ...list.maps.map((m) => [
                  m.id,
                  m.name,
                  m.creator.username,
                  String(m.latestRevision.number),
                  size(m.latestRevision),
                  String(m.latestRevision.spawnZones),
                  ago(m.updatedAt),
                  m.archivedAt === null ? "" : "archived",
                ]),
              ],
              "",
            ),
      );
      moreHint(context, list.nextCursor);
    },
  },

  show: {
    synopsis: "MAP_ID [--out FILE]",
    summary: "Show a Map and its latest Revision (GET /maps/{mapId})",
    args: ["MAP_ID"],
    options: { out: { type: "string" } },
    run: async (context, [id = ""], values) => {
      const map = await context.client.request<GameMap>("GET", mapPath(id));
      const out = await saveMap(values, map.latestRevision);
      emit(context, map, () =>
        table(
          [
            ["id:", map.id],
            ["name:", map.name],
            ...(map.description === "" ? [] : [["description:", map.description]]),
            ["creator:", map.creator.username],
            ["updated:", ago(map.updatedAt)],
            ...(map.archivedAt === null ? [] : [["archived:", ago(map.archivedAt)]]),
            ...revisionLines(map.latestRevision, out),
          ],
          "",
        ),
      );
    },
  },

  update: {
    synopsis: "MAP_ID [--name NAME] [--description TEXT]",
    summary: "Rename a Map or change its description (PATCH /maps/{mapId})",
    args: ["MAP_ID"],
    options: { name: { type: "string" }, description: { type: "string" } },
    run: async (context, [id = ""], values) => {
      const body = textOptions(values, "name", "description");
      if (Object.keys(body).length === 0) throw usageError("give --name, --description or both");
      const map = await context.client.request<GameMap>("PATCH", mapPath(id), { auth: true, body });
      emit(context, map, () => [`Updated Map ${map.id} ("${map.name}").`]);
    },
  },

  revise: {
    synopsis: "MAP_ID --map FILE [--notes TEXT]",
    summary: "Add a Revision to a Map (POST /maps/{mapId}/revisions)",
    args: ["MAP_ID"],
    options: { map: { type: "string" }, notes: { type: "string" } },
    run: async (context, [id = ""], values) => {
      const body = { map: await readMap(context, values), ...textOptions(values, "notes") };
      const revision = await context.client.request<MapRevision>("POST", `${mapPath(id)}/revisions`, { auth: true, body });
      emit(context, revision, () => [`Added Revision ${String(revision.number)} to Map ${revision.mapId}.`]);
    },
  },

  revisions: {
    synopsis: "MAP_ID [--limit N] [--cursor CURSOR] [--all]",
    summary: "List a Map's Revisions (GET /maps/{mapId}/revisions)",
    args: ["MAP_ID"],
    options: PAGE_OPTIONS,
    run: async (context, [id = ""], values) => {
      const list = await fetchList<"revisions", Schema<"MapRevisionSummary">>(context.client, `${mapPath(id)}/revisions`, "revisions", pageOptions(values));
      emit(context, list, () =>
        table(
          [
            ["Revision", "Size", "Spawn Zones", "Created", "Notes"],
            ...list.revisions.map((r) => [String(r.number), size(r), String(r.spawnZones), ago(r.createdAt), r.notes]),
          ],
          "",
        ),
      );
      moreHint(context, list.nextCursor);
    },
  },

  revision: {
    synopsis: "MAP_ID N [--out FILE]",
    summary: "Show one Revision of a Map (GET /maps/{mapId}/revisions/{revision})",
    args: ["MAP_ID", "N"],
    options: { out: { type: "string" } },
    run: async (context, [id = "", n = ""], values) => {
      const revision = await context.client.request<MapRevision>("GET", revisionPath(id, wholeNumber("N", n)));
      const out = await saveMap(values, revision);
      emit(context, revision, () => table([["Map id:", revision.mapId], ...revisionLines(revision, out)], ""));
    },
  },

  "delete-revision": {
    synopsis: "MAP_ID N",
    summary: "Delete a Revision no Game uses that is not the latest (DELETE /maps/{mapId}/revisions/{revision})",
    args: ["MAP_ID", "N"],
    run: async (context, [id = "", n = ""]) => {
      const number = wholeNumber("N", n);
      await context.client.request("DELETE", revisionPath(id, number), { auth: true });
      emit(context, {}, () => [`Deleted Revision ${String(number)} of Map ${id}.`]);
    },
  },

  archive: {
    synopsis: "MAP_ID",
    summary: "Archive a Map (DELETE /maps/{mapId})",
    args: ["MAP_ID"],
    run: async (context, [id = ""]) => {
      await context.client.request("DELETE", mapPath(id), { auth: true });
      emit(context, {}, () => [`Archived Map ${id}.`]);
    },
  },
};
