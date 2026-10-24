import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateRuleset, type Component, type Ruleset, type Slot } from "./ruleset.js";
import { RULESET_VERSIONS, isRulesetVersion, loadRuleset, readRulesetJson, rulesetPath } from "./rulesets.js";

// The approved catalog. These tests read its tables, so r1.json is checked
// against the document itself rather than against a second transcription.
const catalog = readFileSync(new URL("../../../docs/spec/catalog-r1.md", import.meta.url), "utf8").split(/\r?\n/);

function cell(row: readonly string[], i: number): string {
  const v = row[i];
  if (v === undefined) throw new Error(`row ${row.join(" | ")} has no column ${String(i)}`);
  return v;
}

/** The body rows of the first table after the line starting with `marker`. */
function table(marker: string): string[][] {
  const start = catalog.findIndex((line) => line.startsWith(marker));
  if (start < 0) throw new Error(`catalog-r1.md has no line starting "${marker}"`);
  let i = start + 1;
  while (i < catalog.length && !catalog[i]?.startsWith("|")) i++;
  const rows: string[][] = [];
  for (; catalog[i]?.startsWith("|") === true; i++) {
    rows.push((catalog[i] ?? "").slice(1, -1).split("|").map((c) => c.trim()));
  }
  return rows.slice(2); // header and separator
}

/** A numeric cell: "1,000" is 1000, "–" is 0, and trailing notes such as "(ignored)" are dropped. */
function num(text: string): number {
  if (text === "–") return 0;
  const v = Number.parseFloat(text.replace(/,/g, ""));
  if (Number.isNaN(v)) throw new Error(`"${text}" is not a number`);
  return v;
}

/** The backticked id in a cell such as "Pellet Gun (`pelletGun`)", or undefined. */
function idOf(text: string): string | undefined {
  return /`([^`]+)`/.exec(text)?.[1];
}

function nameOf(text: string): string {
  return text.replace(/\s*\(`[^`]+`\)$/, "");
}

/** Rows that name a catalog entry, as [id, name, row]. */
function entries(marker: string): [string, string, string[]][] {
  return table(marker).flatMap((row) => {
    const id = idOf(cell(row, 0));
    return id === undefined ? [] : [[id, nameOf(cell(row, 0)), row] as [string, string, string[]]];
  });
}

const r1 = loadRuleset("r1");

function ofKind(kind: string): Component[] {
  return r1.components.filter((c) => c.kind === kind);
}

describe("shipped Rulesets", () => {
  it("each version validates", () => {
    for (const version of RULESET_VERSIONS) {
      const result = validateRuleset(JSON.parse(readRulesetJson(version)));
      expect(result.ok ? [] : result.errors).toEqual([]);
    }
  });

  it("knows which versions it ships", () => {
    expect(isRulesetVersion("r1")).toBe(true);
    expect(isRulesetVersion("sample")).toBe(false);
    expect(isRulesetVersion("../r1")).toBe(false);
    expect(rulesetPath("r1").replace(/\\/g, "/")).toMatch(/\/ruleset-data\/rulesets\/r1\.json$/);
  });
});

describe("r1 matches catalog-r1.md", () => {
  it("has the global values (section 2)", () => {
    const globals = new Map(table("## 2. Global values").map((row) => [idOf(cell(row, 0)), cell(row, 1)]));
    expect(r1.version).toBe("r1");
    expect(r1.tickRate).toBe(num(globals.get("tickRate") ?? ""));
    const [min, max] = (globals.get("pointBudget") ?? "").split("–").map(num);
    expect(r1.pointBudget).toEqual({ min, max });
    expect(r1.mapFormats).toEqual([1]);
    expect(globals.get("mapFormats")).toBe("`[1]`");
    expect(r1.slotTypes).toEqual((globals.get("slotTypes") ?? "").split(",").map((s) => idOf(s)));
  });

  it("has the Terrains, in order (section 3)", () => {
    const expected = table("## 3. Terrain").map((row) => ({
      name: idOf(cell(row, 0)),
      speed: num(cell(row, 1)),
      accel: num(cell(row, 2)),
    }));
    expect(r1.terrains).toEqual(expected);
  });

  it("has the language limits (section 7)", () => {
    const expected = Object.fromEntries(
      table("## 7. Language limits").flatMap((row) => {
        const key = idOf(cell(row, 0));
        return key === undefined ? [] : [[key, num(cell(row, 1))]];
      }),
    );
    expect(r1.limits).toEqual(expected);
    expect(r1.limits.initBudgetMultiplier).toBe(50);
  });

  it("has the Chassis (section 4)", () => {
    const rows = entries("## 4. Chassis");
    expect(r1.chassis.map((c) => c.id)).toEqual(rows.map(([id]) => id));
    for (const [id, name, row] of rows) {
      const c = r1.chassis.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      if (c === undefined) continue;
      expect(c.name).toBe(name);
      expect(c.cost).toBe(num(cell(row, 1)));
      expect(c.stats).toEqual({ mass: num(cell(row, 4)), hitPoints: num(cell(row, 5)), operationBudget: 1000 });

      const shape = cell(row, 2);
      const circle = /^circle r ([\d.]+)$/.exec(shape);
      const rect = /^rectangle ([\d.]+) × ([\d.]+)$/.exec(shape);
      if (circle) {
        expect(c.shape).toEqual({ shape: "circle", radius: num(circle[1] ?? "") });
      } else if (rect) {
        const w = num(rect[1] ?? "") / 2;
        const h = num(rect[2] ?? "") / 2;
        expect(c.shape).toEqual({
          shape: "polygon",
          points: [
            { x: -w, y: -h },
            { x: w, y: -h },
            { x: w, y: h },
            { x: -w, y: h },
          ],
        });
      } else {
        const triangle = /The Wedge outline is the triangle (.*)\. /.exec(catalog.join("\n"))?.[1] ?? "";
        const points = [...triangle.matchAll(/\((-?[\d.]+), (-?[\d.]+)\)/g)].map((m) => ({
          x: num(m[1] ?? ""),
          y: num(m[2] ?? ""),
        }));
        expect(id).toBe("wedge");
        expect(c.shape).toEqual({ shape: "polygon", points });
      }

      const reach =
        c.shape.shape === "circle" ? c.shape.radius : Math.max(...c.shape.points.map((p) => Math.hypot(p.x, p.y)));
      expect(Math.round(reach * 100) / 100).toBe(num(cell(row, 3)));

      const counts: Record<string, number> = {};
      for (const part of cell(row, 6).split(",")) {
        const [n, type] = part.trim().split(" ");
        counts[type ?? ""] = num(n ?? "");
      }
      const actual: Record<string, number> = {};
      for (const slot of c.slots) actual[slot.type] = (actual[slot.type] ?? 0) + 1;
      expect(actual).toEqual(counts);
    }
  });

  it("has the Slots, in order (section 4)", () => {
    const names = new Map(r1.chassis.map((c) => [c.name, c.id]));
    const expected: Record<string, Slot[]> = {};
    let current = "";
    for (const row of table("### Slots")) {
      if (cell(row, 0) !== "") current = names.get(cell(row, 0)) ?? cell(row, 0);
      (expected[current] ??= []).push({
        id: idOf(cell(row, 1)) ?? "",
        type: cell(row, 2),
        x: num(cell(row, 3)),
        y: num(cell(row, 4)),
        direction: num(cell(row, 5)),
      });
    }
    expect(Object.fromEntries(r1.chassis.map((c) => [c.id, c.slots]))).toEqual(expected);
  });

  it("has the weapons (section 5.1)", () => {
    const expected = entries("### 5.1 Weapons").map(([id, name, row]) => ({
      id,
      name,
      kind: "weapon",
      cost: num(cell(row, 1)),
      slotTypes: ["weapon"],
      stats: {
        category: cell(row, 2),
        arcWidth: num(cell(row, 3)),
        range: num(cell(row, 4)),
        reloadTicks: num(cell(row, 5)),
        damage: num(cell(row, 6)),
        projectileSpeed: num(cell(row, 8)),
        mass: num(cell(row, 9)),
      },
    }));
    expect(ofKind("weapon")).toEqual(expected);
    for (const [id, , row] of entries("### 5.1 Weapons")) {
      const w = ofKind("weapon").find((c) => c.id === id);
      const dps = ((w?.stats.damage as number) * r1.tickRate) / (w?.stats.reloadTicks as number);
      expect(Math.round(dps * 10) / 10, id).toBe(num(cell(row, 7)));
    }
  });

  it("has the sensors (section 5.2)", () => {
    const expected = entries("### 5.2 Sensors").map(([id, name, row]) => ({
      id,
      name,
      kind: "sensor",
      cost: num(cell(row, 1)),
      slotTypes: ["sensor"],
      stats: { kind: cell(row, 2), arcWidth: num(cell(row, 3)), range: num(cell(row, 4)), mass: num(cell(row, 5)) },
    }));
    expect(ofKind("sensor")).toEqual(expected);
  });

  it("has the motors and their Terrain modifiers (section 5.3)", () => {
    const terrainRows = table("`motorTerrain` modifiers");
    const terrainHeader = ["road", "sand", "mud", "ice"];
    const expected = entries("### 5.3 Motors").map(([id, name, row]) => {
      const mods = terrainRows.find((r) => r[0] === name);
      if (mods === undefined) throw new Error(`no motorTerrain row for ${name}`);
      const motorTerrain = Object.fromEntries(
        terrainHeader.map((terrain, i) => {
          const [speed, accel] = cell(mods, i + 1).split("/").map(num);
          return [terrain, { speed, accel }];
        }),
      );
      return {
        id,
        name,
        kind: "motor",
        cost: num(cell(row, 1)),
        slotTypes: ["motor"],
        stats: {
          force: num(cell(row, 2)),
          maxSpeed: num(cell(row, 3)),
          turnRate: num(cell(row, 4)),
          mass: num(cell(row, 5)),
          motorTerrain,
        },
      };
    });
    expect(ofKind("motor")).toEqual(expected);
  });

  it("has the Processors (section 5.4)", () => {
    const expected = entries("### 5.4 Processors").map(([id, name, row]) => ({
      id,
      name,
      kind: "processor",
      cost: num(cell(row, 1)),
      slotTypes: ["utility"],
      stats: { operationBudget: num(cell(row, 2)), mass: num(cell(row, 3)) },
    }));
    expect(ofKind("processor")).toEqual(expected);
  });

  it("has the Armor (section 5.5)", () => {
    const expected = entries("### 5.5 Armor").map(([id, name, row]) => ({
      id,
      name,
      kind: "armor",
      cost: num(cell(row, 1)),
      slotTypes: [],
      stats: { armor: num(cell(row, 2)), mass: num(cell(row, 3)) },
    }));
    expect(ofKind("armor")).toEqual(expected);
  });

  it("has nothing outside the catalog", () => {
    const kinds: Ruleset["components"][number]["kind"][] = ["weapon", "sensor", "motor", "processor", "armor"];
    expect(Object.keys(r1.componentKinds)).toEqual(kinds);
    expect(r1.components.every((c) => kinds.includes(c.kind))).toBe(true);
  });
});
