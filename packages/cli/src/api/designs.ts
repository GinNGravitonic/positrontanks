/**
 * `positrontanks designs` (docs/spec/cli-api.md): the Garage, a Player's Bot
 * Designs and their Revisions, Copy to Ruleset and the tick cost check.
 *
 * `--build FILE` is a Build as JSON and `--program FILE` Program source;
 * either may be `-` for stdin. `designs revise` sends the latest Revision's
 * half for the one not given. `--program-out FILE` writes a Revision's
 * Program source, so a design can be pulled, edited and revised; human
 * output otherwise shows the Build and the Program's length.
 *
 * `icon set` sends the file as is; the server checks it (the same limits as
 * an Emblem) and strips its metadata, so the CLI does not check it first.
 */

import { CliError, fetchList, usageError, type Schema } from "./client.js";
import {
  ago,
  emit,
  flag,
  moreHint,
  optionalNumber,
  PAGE_OPTIONS,
  pageOptions,
  readBinaryInput,
  readInput,
  readJsonInput,
  rulesetOrLatest,
  segment,
  str,
  textOptions,
  wholeNumber,
  withProgramFile,
  writeOutput,
  type Context,
  type Group,
  type Values,
} from "./context.js";
import { table } from "../report.js";
import { formatTickCosts } from "../tick-cost.js";

type BotDesign = Schema<"BotDesign">;
type Revision = Schema<"BotDesignRevision">;
type CopyReport = Schema<"CopyReport">;
type TickCostReport = Schema<"TickCostReport">;

const designPath = (id: string) => `/bot-designs/${segment(id)}`;
const revisionPath = (id: string, n: number) => `${designPath(id)}/revisions/${String(n)}`;

/** `--build` and `--program` as given; each is undefined when left out. */
async function readHalves(context: Context, values: Values): Promise<{ build?: unknown; program?: string; programFile?: string }> {
  const buildFile = str(values, "build");
  const programFile = str(values, "program");
  return {
    ...(buildFile === undefined ? {} : { build: await readJsonInput(context, buildFile, "--build") }),
    ...(programFile === undefined ? {} : { program: await readInput(context, programFile, "--program"), programFile }),
  };
}

function lines(text: string): number {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function revisionLines(r: Revision, programOut: string | undefined): string[][] {
  return [
    ["Revision:", `${String(r.number)}, ${String(r.cost)} points, created ${ago(r.createdAt)}`],
    ...(r.notes === "" ? [] : [["notes:", r.notes]]),
    ["Build:", JSON.stringify(r.build)],
    [
      "Program:",
      `${String(lines(r.program))} lines, ${String(r.program.length)} characters${programOut === undefined ? " (save it with --program-out FILE)" : `, written to ${programOut}`}`,
    ],
  ];
}

function designLines(d: BotDesign, programOut: string | undefined): string[] {
  return table(
    [
      ["id:", d.id],
      ["name:", d.name],
      ...(d.description === "" ? [] : [["description:", d.description]]),
      ["Ruleset:", d.rulesetVersion],
      ...(d.copiedFrom === null ? [] : [["copied from:", `${d.copiedFrom.designId} Revision ${String(d.copiedFrom.revision)}`]]),
      ["Icon:", d.icon ?? "none"],
      ["updated:", ago(d.updatedAt)],
      ...(d.archivedAt === null ? [] : [["archived:", ago(d.archivedAt)]]),
      ...revisionLines(d.latestRevision, programOut),
    ],
    "",
  );
}

async function saveProgram(values: Values, revision: Revision): Promise<string | undefined> {
  const out = str(values, "program-out");
  if (out !== undefined) await writeOutput(out, revision.program);
  return out;
}

function copyReportLines(report: CopyReport): string[] {
  const head = `Revision ${String(report.sourceRevision)} under Ruleset ${report.rulesetVersion}: `;
  if (report.ok) return [`${head}valid, ${String(report.cost)} points.`];
  return [
    `${head}not valid${report.cost === null ? "" : ` (${String(report.cost)} points)`}:`,
    ...report.problems.map((p) => `  ${p.path}${p.line === undefined ? "" : `:${String(p.line)}:${String(p.column ?? 1)}`}: ${p.message}`),
  ];
}

/**
 * Runs a tick cost check, pointing a `feature_disabled` answer to the
 * offline check in human output.
 */
export async function tickCostRequest(context: Context, path: string, body: unknown, programFile?: string): Promise<TickCostReport> {
  try {
    return await withProgramFile(context, programFile, () => context.client.request<TickCostReport>("POST", path, { auth: true, body }));
  } catch (e) {
    if (context.json || !(e instanceof CliError) || e.code !== "feature_disabled") throw e;
    throw new CliError(
      e.exitCode,
      e.code,
      `${context.settings.server} has the tick cost check off (it is a local-server feature); run it offline with 'positrontanks tick-cost --entry FILE'`,
    );
  }
}

/** The human header of a tick cost report. */
export function tickCostHeader(context: Context, report: TickCostReport, what: string): string {
  return `Ruleset ${report.rulesetVersion}, ${what}, seed ${String(report.seed)}, ${String(report.ticks)} Ticks in the sample world on ${context.settings.server}`;
}

export const designsCommands: Group = {
  create: {
    synopsis: "--name NAME --build FILE --program FILE [--ruleset VERSION] [--description TEXT] [--notes TEXT]",
    summary: "Create a Bot Design with its Revision 1 (POST /bot-designs)",
    options: {
      name: { type: "string" },
      build: { type: "string" },
      program: { type: "string" },
      ruleset: { type: "string" },
      description: { type: "string" },
      notes: { type: "string" },
    },
    run: async (context, _args, values) => {
      const name = str(values, "name");
      if (name === undefined) throw usageError("--name is required");
      if (str(values, "build") === undefined || str(values, "program") === undefined) throw usageError("--build and --program are required");
      const { build, program, programFile } = await readHalves(context, values);
      const rulesetVersion = await rulesetOrLatest(context, str(values, "ruleset"));
      const body = { name, rulesetVersion, build, program, ...textOptions(values, "description", "notes") };
      const design = await withProgramFile(context, programFile, () => context.client.request<BotDesign>("POST", "/bot-designs", { auth: true, body }));
      emit(context, design, () => [`Created Bot Design ${design.id} ("${design.name}") under Ruleset ${design.rulesetVersion}, ${String(design.latestRevision.cost)} points.`]);
    },
  },

  list: {
    synopsis: "[--include-archived] [--limit N] [--cursor CURSOR] [--all]",
    summary: "List your Bot Designs (GET /bot-designs)",
    options: { "include-archived": { type: "boolean" }, ...PAGE_OPTIONS },
    run: async (context, _args, values) => {
      const query = flag(values, "include-archived") ? { includeArchived: true } : {};
      const list = await fetchList<"botDesigns", Schema<"BotDesignSummary">>(context.client, "/bot-designs", "botDesigns", pageOptions(values), { auth: true, query });
      emit(context, list, () =>
        list.botDesigns.length === 0
          ? ["No Bot Designs."]
          : table(
              [
                ["ID", "Name", "Ruleset", "Revision", "Cost", "Updated", ""],
                ...list.botDesigns.map((d) => [
                  d.id,
                  d.name,
                  d.rulesetVersion,
                  String(d.latestRevision.number),
                  String(d.latestRevision.cost),
                  ago(d.updatedAt),
                  d.archivedAt === null ? "" : "archived",
                ]),
              ],
              "",
            ),
      );
      moreHint(context, list.nextCursor);
    },
  },

  show: {
    synopsis: "DESIGN_ID [--program-out FILE]",
    summary: "Show a Bot Design and its latest Revision (GET /bot-designs/{designId})",
    args: ["DESIGN_ID"],
    options: { "program-out": { type: "string" } },
    run: async (context, [id = ""], values) => {
      const design = await context.client.request<BotDesign>("GET", designPath(id), { auth: true });
      const out = await saveProgram(values, design.latestRevision);
      emit(context, design, () => designLines(design, out));
    },
  },

  update: {
    synopsis: "DESIGN_ID [--name NAME] [--description TEXT]",
    summary: "Rename a Bot Design or change its description (PATCH /bot-designs/{designId})",
    args: ["DESIGN_ID"],
    options: { name: { type: "string" }, description: { type: "string" } },
    run: async (context, [id = ""], values) => {
      const body = textOptions(values, "name", "description");
      if (Object.keys(body).length === 0) throw usageError("give --name, --description or both");
      const design = await context.client.request<BotDesign>("PATCH", designPath(id), { auth: true, body });
      emit(context, design, () => [`Updated Bot Design ${design.id} ("${design.name}").`]);
    },
  },

  revise: {
    synopsis: "DESIGN_ID [--build FILE] [--program FILE] [--notes TEXT]",
    summary: "Add a Revision, keeping the latest Revision's Build or Program for the half not given",
    args: ["DESIGN_ID"],
    options: { build: { type: "string" }, program: { type: "string" }, notes: { type: "string" } },
    run: async (context, [id = ""], values) => {
      if (str(values, "build") === undefined && str(values, "program") === undefined) throw usageError("give --build, --program or both");
      const given = await readHalves(context, values);
      let { build, program } = given;
      if (build === undefined || program === undefined) {
        const { latestRevision } = await context.client.request<BotDesign>("GET", designPath(id), { auth: true });
        build ??= latestRevision.build;
        program ??= latestRevision.program;
      }
      const body = { build, program, ...textOptions(values, "notes") };
      const revision = await withProgramFile(context, given.programFile, () =>
        context.client.request<Revision>("POST", `${designPath(id)}/revisions`, { auth: true, body }),
      );
      emit(context, revision, () => [`Added Revision ${String(revision.number)} to Bot Design ${revision.designId}, ${String(revision.cost)} points.`]);
    },
  },

  revisions: {
    synopsis: "DESIGN_ID [--limit N] [--cursor CURSOR] [--all]",
    summary: "List a Bot Design's Revisions (GET /bot-designs/{designId}/revisions)",
    args: ["DESIGN_ID"],
    options: PAGE_OPTIONS,
    run: async (context, [id = ""], values) => {
      const list = await fetchList<"revisions", Schema<"BotDesignRevisionSummary">>(context.client, `${designPath(id)}/revisions`, "revisions", pageOptions(values), {
        auth: true,
      });
      emit(context, list, () =>
        table([["Revision", "Cost", "Created", "Notes"], ...list.revisions.map((r) => [String(r.number), String(r.cost), ago(r.createdAt), r.notes])], ""),
      );
      moreHint(context, list.nextCursor);
    },
  },

  revision: {
    synopsis: "DESIGN_ID N [--program-out FILE]",
    summary: "Show one Revision of a Bot Design (GET /bot-designs/{designId}/revisions/{revision})",
    args: ["DESIGN_ID", "N"],
    options: { "program-out": { type: "string" } },
    run: async (context, [id = "", n = ""], values) => {
      const revision = await context.client.request<Revision>("GET", revisionPath(id, wholeNumber("N", n)), { auth: true });
      const out = await saveProgram(values, revision);
      emit(context, revision, () => table([["design:", revision.designId], ...revisionLines(revision, out)], ""));
    },
  },

  "delete-revision": {
    synopsis: "DESIGN_ID N",
    summary: "Delete a Revision that is not the latest (DELETE /bot-designs/{designId}/revisions/{revision})",
    args: ["DESIGN_ID", "N"],
    run: async (context, [id = "", n = ""]) => {
      const number = wholeNumber("N", n);
      await context.client.request("DELETE", revisionPath(id, number), { auth: true });
      emit(context, {}, () => [`Deleted Revision ${String(number)} of Bot Design ${id}.`]);
    },
  },

  copy: {
    synopsis: "DESIGN_ID --ruleset VERSION [--revision N] [--name NAME] [--notes TEXT] [--dry-run]",
    summary: "Copy a Revision into a new Bot Design under another Ruleset (POST /bot-designs/{designId}/copies)",
    args: ["DESIGN_ID"],
    options: { ruleset: { type: "string" }, revision: { type: "string" }, name: { type: "string" }, notes: { type: "string" }, "dry-run": { type: "boolean" } },
    run: async (context, [id = ""], values) => {
      const rulesetVersion = str(values, "ruleset");
      if (rulesetVersion === undefined) throw usageError("--ruleset is required");
      const revision = optionalNumber(values, "revision");
      const dryRun = flag(values, "dry-run");
      const body = { rulesetVersion, ...(revision === undefined ? {} : { revision }), ...textOptions(values, "name", "notes"), ...(dryRun ? { dryRun } : {}) };
      const path = `${designPath(id)}/copies`;
      if (dryRun) {
        const report = await context.client.request<CopyReport>("POST", path, { auth: true, body });
        emit(context, report, () => [...copyReportLines(report), "Nothing was saved (--dry-run)."]);
        return;
      }
      const copied = await context.client.request<Schema<"CopiedBotDesign">>("POST", path, { auth: true, body });
      emit(context, copied, () => [
        `Copied Bot Design ${id} into Bot Design ${copied.botDesign.id} ("${copied.botDesign.name}") under Ruleset ${copied.botDesign.rulesetVersion}.`,
        ...copyReportLines(copied.report),
      ]);
    },
  },

  archive: {
    synopsis: "DESIGN_ID",
    summary: "Archive a Bot Design (DELETE /bot-designs/{designId})",
    args: ["DESIGN_ID"],
    run: async (context, [id = ""]) => {
      await context.client.request("DELETE", designPath(id), { auth: true });
      emit(context, {}, () => [`Archived Bot Design ${id}.`]);
    },
  },

  "icon set": {
    synopsis: "DESIGN_ID FILE",
    summary: "Set or replace a Bot Design's Icon from a PNG file (PUT /bot-designs/{designId}/icon)",
    args: ["DESIGN_ID", "FILE"],
    run: async (context, [id = "", file = ""]) => {
      const content = await readBinaryInput(file);
      const design = await context.client.request<BotDesign>("PUT", `${designPath(id)}/icon`, { auth: true, bytes: { type: "image/png", content } });
      emit(context, design, () => [`Set the Icon of Bot Design ${design.id} ("${design.name}") (Icon ${design.icon ?? "none"}).`]);
    },
  },

  "icon clear": {
    synopsis: "DESIGN_ID",
    summary: "Remove a Bot Design's Icon (DELETE /bot-designs/{designId}/icon)",
    args: ["DESIGN_ID"],
    run: async (context, [id = ""]) => {
      await context.client.request("DELETE", `${designPath(id)}/icon`, { auth: true });
      emit(context, {}, () => [`Removed the Icon of Bot Design ${id}.`]);
    },
  },

  "tick-cost": {
    synopsis: "DESIGN_ID [--revision N] [--ticks N] [--seed N]",
    summary: "Run the tick cost check on a Revision (POST /bot-designs/{designId}/tick-cost-checks; local servers only)",
    args: ["DESIGN_ID"],
    options: { revision: { type: "string" }, ticks: { type: "string" }, seed: { type: "string" } },
    run: async (context, [id = ""], values) => {
      const options = { revision: optionalNumber(values, "revision"), ticks: optionalNumber(values, "ticks"), seed: optionalNumber(values, "seed", 0) };
      const body = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
      const report = await tickCostRequest(context, `${designPath(id)}/tick-cost-checks`, body);
      const revision = options.revision === undefined ? "latest Revision" : `Revision ${String(options.revision)}`;
      emit(context, report, () => [tickCostHeader(context, report, `Bot Design ${id} (${revision})`), "", ...formatTickCosts([{ name: id, report }])]);
    },
  },
};
