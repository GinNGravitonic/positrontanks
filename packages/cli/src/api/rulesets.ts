/**
 * `positrontanks rulesets` (docs/spec/cli-api.md): the Rulesets the server hosts,
 * their rules, language, Parts Catalog and Terrains, and their documents.
 * `rulesets docs VERSION DOC` prints the Markdown as is in both output
 * modes: it is how an agent reads the rules it plays under.
 */

import type { Schema } from "./client.js";
import { emit, segment, type Command, type Context, type Group } from "./context.js";
import { table } from "../report.js";

type RulesetSummary = Schema<"RulesetSummary">;

const base = (version: string) => `/rulesets/${segment(version)}`;

const budget = ({ pointBudget }: RulesetSummary) => `${String(pointBudget.min)} to ${String(pointBudget.max)}`;
const formats = ({ mapFormats }: RulesetSummary) => mapFormats.join(", ");

function summaryLines(r: RulesetSummary): string[][] {
  return [
    ["version:", r.version],
    ["tick rate:", `${String(r.tickRate)} Ticks per second`],
    ["Point Budget:", budget(r)],
    ["Map Formats:", formats(r)],
  ];
}

const args = (min: number, max: number) => (min === max ? String(min) : `${String(min)}-${String(max)}`);

/** What each of a Ruleset's sub-resources answers, by its path under `/rulesets/{version}`. */
interface SubResources {
  "": "RulesetSummary";
  "/rules": "RulesetRules";
  "/language": "RulesetLanguage";
  "/parts": "PartsCatalog";
  "/terrains": "TerrainTable";
}

/** The command for one GET of a Ruleset's sub-resource. */
function show<P extends keyof SubResources>(summary: string, path: P, human: (body: Schema<SubResources[P]>) => readonly string[]): Command {
  return {
    synopsis: "VERSION",
    summary,
    args: ["VERSION"],
    run: async (context, [version = ""]) => {
      const body = await context.client.request<Schema<SubResources[P]>>("GET", `${base(version)}${path}`);
      emit(context, body, () => human(body));
    },
  };
}

async function printDoc(context: Context, version: string, doc: string): Promise<void> {
  const response = await context.client.send("GET", `${base(version)}/docs/${segment(doc)}`);
  context.io.out(response.text.replace(/\n$/, ""));
}

export const rulesetsCommands: Group = {
  list: {
    synopsis: "",
    summary: "List the Rulesets the server hosts, oldest first (GET /rulesets)",
    run: async (context) => {
      const list = await context.client.request<Schema<"RulesetList">>("GET", "/rulesets");
      emit(context, list, () =>
        table([["Version", "Tick rate", "Point Budget", "Map Formats"], ...list.rulesets.map((r) => [r.version, String(r.tickRate), budget(r), formats(r)])], ""),
      );
    },
  },

  show: show("Show a Ruleset's summary (GET /rulesets/{version})", "", (r) => table(summaryLines(r), "")),

  rules: show("Show a Ruleset's global rules and language limits (GET /rulesets/{version}/rules)", "/rules", (r) => [
    ...table([...summaryLines(r), ["Slot types:", r.slotTypes.join(", ")]], ""),
    "Limits:",
    ...table(Object.entries(r.limits).map(([name, value]) => [name, String(value)])),
  ]),

  language: show("Show what the Ruleset's language gives Programs (GET /rulesets/{version}/language)", "/language", (l) => [
    `Ruleset ${l.version}: built-in functions (cost in operations per call):`,
    ...table([
      ["Function", "Args", "Cost", "In init()"],
      ...Object.entries(l.functions).map(([name, f]) => [name, args(f.minArgs, f.maxArgs), String(f.cost), f.initPhase ? "yes" : "no"]),
    ]),
    `Built-in values: ${Object.keys(l.values).join(", ")}`,
    ...(["listMethods", "stringMethods"] as const).flatMap((kind) => [
      `${kind === "listMethods" ? "List" : "String"} methods:`,
      ...table(Object.entries(l[kind]).map(([name, m]) => [name, `args ${args(m.minArgs, m.maxArgs)}`, `cost ${String(m.cost)}`])),
    ]),
    "Limits:",
    ...table(Object.entries(l.limits).map(([name, value]) => [name, String(value)])),
  ]),

  parts: show("Show a Ruleset's Parts Catalog (GET /rulesets/{version}/parts)", "/parts", (c) => [
    `Ruleset ${c.version}: Chassis:`,
    ...table([["ID", "Name", "Cost", "Slots"], ...c.chassis.map((ch) => [ch.id, ch.name, String(ch.cost), ch.slots.map((s) => `${s.id} (${s.type})`).join(", ")])]),
    "Components:",
    ...table([["ID", "Name", "Kind", "Cost", "Slot types"], ...c.components.map((co) => [co.id, co.name, co.kind, String(co.cost), co.slotTypes.join(", ") || "side"])]),
  ]),

  terrains: show("Show a Ruleset's Terrains (GET /rulesets/{version}/terrains)", "/terrains", (t) =>
    table([["Terrain", "Speed", "Accel", "Description"], ...t.terrains.map((te) => [te.name, String(te.speed), String(te.accel), te.description])], ""),
  ),

  docs: {
    synopsis: "VERSION [DOC]",
    summary: "List a Ruleset's documents, or print one (engine, language or catalog) as Markdown",
    args: ["VERSION", "[DOC]"],
    run: async (context, [version = "", doc]) => {
      if (doc !== undefined) {
        await printDoc(context, version, doc);
        return;
      }
      const list = await context.client.request<Schema<"RulesetDocList">>("GET", `${base(version)}/docs`);
      emit(context, list, () => [
        ...table([["Doc", "Title"], ...list.docs.map((d) => [d.id, d.title])], ""),
        `Print one with: positrontanks rulesets docs ${list.version} DOC`,
      ]);
    },
  },
};
