/**
 * `positrontanks tick-cost --entry FILE --remote` (docs/spec/cli-api.md): the
 * offline tick cost check's input and output, run on the server with
 * `POST /tick-cost-checks`, one request per Bot of the Entry file. The
 * Entry file's Ruleset defaults to the latest the server hosts.
 */

import { InputError, readEntryFile } from "../entry-file.js";
import { formatTickCosts } from "../tick-cost.js";
import { CliError, inputError, usageError, type Schema } from "./client.js";
import { emit, optionalNumber, rulesetOrLatest, str, type Command } from "./context.js";
import { tickCostHeader, tickCostRequest } from "./designs.js";

export const remoteTickCostCommand: Command = {
  synopsis: "--entry FILE --remote [--ticks N] [--seed N]",
  summary: "Run the tick cost check for each Bot of an Entry file on the server (POST /tick-cost-checks; local servers only)",
  options: { entry: { type: "string" }, remote: { type: "boolean" }, ticks: { type: "string" }, seed: { type: "string" } },
  run: async (context, _args, values) => {
    const path = str(values, "entry");
    if (path === undefined) throw usageError("--entry is required");
    const options = { ticks: optionalNumber(values, "ticks"), seed: optionalNumber(values, "seed", 0) };
    let file;
    try {
      file = await readEntryFile(path);
    } catch (e) {
      throw e instanceof InputError ? inputError(e.message) : e;
    }
    const rulesetVersion = await rulesetOrLatest(context, file.ruleset ?? undefined);
    const bots: { name: string; report: Schema<"TickCostReport"> }[] = [];
    for (const bot of file.bots) {
      const body = { rulesetVersion, build: bot.build, program: bot.program, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
      const programFile = bot.programSource === file.path ? undefined : bot.programSource;
      try {
        bots.push({ name: bot.name, report: await tickCostRequest(context, "/tick-cost-checks", body, programFile) });
      } catch (e) {
        // Say which Bot the server refused; JSON output keeps the server's error body as is.
        if (context.json || !(e instanceof CliError) || file.bots.length === 1) throw e;
        throw new CliError(e.exitCode, e.code, `Bot "${bot.name}": ${e.message}`, e.details);
      }
    }
    const [first] = bots;
    emit(context, { player: file.player, bots }, () => [
      ...(first === undefined ? [] : [tickCostHeader(context, first.report, `Entry ${path} (${file.player})`), ""]),
      ...formatTickCosts(bots),
    ]);
  },
};
