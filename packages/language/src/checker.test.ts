import { describe, expect, it } from "vitest";
import { check, type CheckOptions } from "./checker.js";
import { R1_LANGUAGE } from "./definition.js";
import type { Diagnostic } from "./lexer.js";

const options: CheckOptions = { language: R1_LANGUAGE, maxSourceBytes: 65536 };

function errorsOf(source: string, extra: Partial<CheckOptions> = {}): readonly Diagnostic[] {
  const result = check(source, { ...options, ...extra });
  return result.ok ? [] : result.errors;
}

function messages(source: string, extra: Partial<CheckOptions> = {}): string[] {
  return errorsOf(source, extra).map((e) => e.message);
}

/** The messages for `body` placed inside tick(). */
function inTick(body: string, extra: Partial<CheckOptions> = {}): string[] {
  return messages(`function tick() {\n${body}\n}`, extra);
}

describe("check", () => {
  it("accepts a valid Program", () => {
    const source = `
      let target = null;
      let plan = [];
      const ARC = 30;

      function init() {
        plan = map.spawnZones.map((z) => z.heading);
        log("start " + str(self.armor.front) + " " + terrainHere());
        for (const w of self.weapons) { log(w.id); }
        const t = terrainTable();
        if (has(self.motorTerrain, "road")) { log(self.motorTerrain.road.speed); }
      }

      function pick(foes) {
        return foes.reduce((best, c) => best == null || c.distance < best.distance ? c : best, null);
      }

      function tick() {
        const foes = scan().filter((c) => c.isFoe);
        target = pick(foes);
        if (target != null) {
          turn(clamp(bearingTo(target.x, target.y) / ARC, -1, 1));
          fire("gun", target);
        }
        throttle(1);
        let i = 0;
        while (i < self.weapons.length) { i++; }
        const copy = self.weapons.slice(0);
        copy.push(1);
        const r = { a: 1 };
        r.b = 2;
        remove(r, "a");
        self.weapons[0].ticksUntilReady;
        map.obstacles.find((o) => o.destructible);
      }`;
    const result = check(source, options);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.ok && result.program.body.length).toBe(6);
  });

  it("reports syntax errors with locations", () => {
    expect(errorsOf("function tick() {\n  let x = 1 +;\n}")).toEqual([
      { line: 2, column: 14, message: "expected an expression but found ';'" },
    ]);
  });

  it("rejects source over maxSourceBytes", () => {
    expect(messages("function tick() {} // é", { maxSourceBytes: 23 })).toEqual([
      "the Program is 24 bytes, over the 23-byte limit",
    ]);
    expect(messages("function tick() {} // é", { maxSourceBytes: 24 })).toEqual([]);
  });

  describe("entry points", () => {
    it("requires tick", () => {
      expect(errorsOf("function init() {}")).toEqual([
        { line: 1, column: 1, message: "the Program must declare function tick()" },
      ]);
      expect(messages("let tick = () => null;")).toEqual(["'tick' must be declared as a function"]);
    });

    it("forbids parameters on tick and init", () => {
      expect(errorsOf("function init(a) {}\nfunction tick(b) {}")).toEqual([
        { line: 1, column: 10, message: "init() cannot take parameters" },
        { line: 2, column: 10, message: "tick() cannot take parameters" },
      ]);
    });
  });

  describe("names", () => {
    it("reports undeclared names", () => {
      expect(errorsOf("function tick() {\n  foo(bar);\n}")).toEqual([
        { line: 2, column: 3, message: "'foo' is not declared" },
        { line: 2, column: 7, message: "'bar' is not declared" },
      ]);
      expect(inTick("toString();")).toEqual(["'toString' is not declared"]);
      expect(inTick("x = 1;")).toEqual(["'x' is not declared"]);
    });

    it("hoists functions but not let and const", () => {
      expect(messages("function tick() { a(); }\nfunction a() { return b(); }\nfunction b() { return 1; }")).toEqual([]);
      expect(inTick("x = 1;\nlet x = 0;")).toEqual(["'x' is used before its declaration"]);
      expect(inTick("let y = y + 1;")).toEqual(["'y' is used before its declaration"]);
      expect(messages("let a = b;\nlet b = 1;\nfunction tick() {}")).toEqual(["'b' is used before its declaration"]);
      expect(messages("let a = () => b;\nlet b = 1;\nfunction tick() {}")).toEqual([]);
      expect(messages("function tick() { log(late); }\nlet late = 1;")).toEqual([]);
    });

    it("finds the shadowed name, not the outer one, when used before its declaration", () => {
      expect(inTick("let x = 1;\n{ log(x); let x = 2; }")).toEqual(["'x' is used before its declaration"]);
    });

    it("reports duplicate declarations in one scope", () => {
      expect(errorsOf("let a = 1;\nfunction a() {}\nfunction tick() {}")).toEqual([
        { line: 2, column: 10, message: "'a' is already declared in this scope" },
      ]);
      expect(messages("function f(a, a) {}\nfunction tick() {}")).toEqual(["'a' is already declared in this scope"]);
      expect(messages("function f(a) { let a = 1; }\nfunction tick() {}")).toEqual(["'a' is already declared in this scope"]);
      expect(inTick("let a = 1;\n{ let a = 2; }\nfor (let a = 0; a < 1; a++) { let a = 3; }")).toEqual([]);
    });

    it("reports assignment to a const", () => {
      expect(inTick("const a = 1;\na = 2;")).toEqual(["'a' is a const and cannot be assigned"]);
      expect(inTick("const a = 1;\na++;")).toEqual(["'a' is a const and cannot be assigned"]);
      expect(inTick("for (const c of []) { c = 1; }")).toEqual(["'c' is a const and cannot be assigned"]);
      expect(inTick("const r = {};\nr.x = 1;")).toEqual([]);
    });

    it("forbids redeclaring built-ins and built-in values", () => {
      expect(messages("let scan = 1;\nfunction tick() {}")).toEqual(["'scan' is a built-in function and cannot be declared again"]);
      expect(messages("function self() {}\nfunction tick() {}")).toEqual(["'self' is a built-in value and cannot be declared again"]);
      expect(inTick("[].map((map) => map);")).toEqual(["'map' is a built-in value and cannot be declared again"]);
      expect(inTick("scan = 1;")).toEqual(["'scan' is a built-in and cannot be assigned"]);
    });
  });

  describe("control flow", () => {
    it("allows break and continue only inside loops", () => {
      expect(inTick("break;")).toEqual(["'break' is only allowed inside a loop"]);
      expect(inTick("while (true) { if (true) { continue; } }")).toEqual([]);
      expect(inTick("while (true) { [1].map((x) => { break; }); }")).toEqual(["'break' is only allowed inside a loop"]);
      expect(inTick("for (;;) { function g() { continue; } }")).toEqual(["'continue' is only allowed inside a loop"]);
    });

    it("allows return inside functions and arrows", () => {
      expect(inTick("return;\n[1].map((x) => { return x; });")).toEqual([]);
    });
  });

  describe("built-in values", () => {
    it("reports unknown fields written directly", () => {
      expect(errorsOf("function tick() {\n  log(self.foo);\n}")).toEqual([
        { line: 2, column: 12, message: "self has no field 'foo'" },
      ]);
      expect(inTick("log(game.tickRate + game.ticks);")).toEqual(["game has no field 'ticks'"]);
      expect(inTick("log(map.obstacles[0].hp);")).toEqual(["map.obstacles[] has no field 'hp'"]);
      expect(inTick("log(self.armor.top);")).toEqual(["self.armor has no field 'top'"]);
      expect(inTick('log(self["armor"]["top"]);')).toEqual(["self.armor has no field 'top'"]);
      expect(inTick("log(self.x.y);")).toEqual(["self.x is a number and has no fields"]);
      expect(inTick("log(self.weapons.size);")).toEqual(["self.weapons is a list and has no field 'size'"]);
      expect(inTick("log(self.name.size);")).toEqual(["self.name is a string and has no field 'size'"]);
      expect(inTick("self.weapons.forEach((w) => w);")).toEqual(["self.weapons is a list and has no method 'forEach'"]);
      expect(inTick("log(self.weapons.filter((w) => true)[0].bogus);")).toEqual(["self.weapons[] has no field 'bogus'"]);
    });

    it("allows any key of a Terrain-keyed record", () => {
      expect(inTick("log(self.motorTerrain.sand.speed + self.motorTerrain.sand.grip);")).toEqual([
        "self.motorTerrain.sand has no field 'grip'",
      ]);
    });

    it("does not check fields of values it cannot see statically", () => {
      expect(inTick("const s = self;\nlog(s.foo);\nconst w = self.weapons[0];\nlog(scan()[0].whatever);")).toEqual([]);
    });

    it("reports assignment to built-in values", () => {
      expect(inTick("self = 1;")).toEqual(["'self' is read-only"]);
      expect(inTick("self.x = 1;")).toEqual(["'self' and everything reachable from it are read-only"]);
      expect(inTick("map.obstacles[0].x += 1;")).toEqual(["'map' and everything reachable from it are read-only"]);
      expect(inTick("game.tickRate++;")).toEqual(["'game' and everything reachable from it are read-only"]);
    });

    it("reports mutating built-in values with methods and remove", () => {
      expect(inTick("self.weapons.push(1);")).toEqual(["'.push' cannot change 'self', which is read-only"]);
      expect(inTick("map.obstacles.sort((a, b) => 0);")).toEqual(["'.sort' cannot change 'map', which is read-only"]);
      expect(inTick('remove(self.armor, "front");')).toEqual(["'remove' cannot change 'self', which is read-only"]);
      expect(inTick("self.weapons.slice(0).push(1);")).toEqual(["'.push' cannot change 'self', which is read-only"]);
    });
  });

  describe("built-in calls", () => {
    it("reports wrong arity at the callee", () => {
      expect(errorsOf("function tick() {\n  scan(1);\n}")).toEqual([
        { line: 2, column: 3, message: "'scan' takes no arguments but is given 1" },
      ]);
      expect(inTick("fire(1);")).toEqual(["'fire' takes 2 arguments but is given 1"]);
      expect(inTick("log(atan2(1));")).toEqual(["'atan2' takes 2 arguments but is given 1"]);
      expect(inTick("log(self.weapons.slice());")).toEqual(["'.slice' takes 1 to 2 arguments but is given 0"]);
      expect(inTick("log(self.weapons.reduce((a, b) => a));")).toEqual(["'.reduce' takes 2 arguments but is given 1"]);
      expect(inTick("log(self.name.slice(0, 1, 2));")).toEqual(["'.slice' takes 1 to 2 arguments but is given 3"]);
    });

    it("does not check arity of methods on values it cannot see statically", () => {
      expect(inTick("const r = { map: (a, b) => a };\nlog(r.map(1, 2));")).toEqual([]);
    });

    it("checks literal Slot ids against the Build", () => {
      const slots = { weapons: ["gun", "saw"], rangefinders: [] };
      expect(inTick('fire("gun", 0);\nfireAbs("saw", 90);', { slots })).toEqual([]);
      expect(errorsOf('function tick() {\n  fire("laser", 0);\n}', { slots })).toEqual([
        { line: 2, column: 8, message: "the Build has no weapon in Slot 'laser': its weapons are in 'gun', 'saw'" },
      ]);
      expect(inTick('log(rangefind("eye"));', { slots })).toEqual([
        "the Build has no rangefinder in Slot 'eye': this Build has no rangefinders",
      ]);
      expect(inTick('fire("laser", 0);')).toEqual([]);
      expect(inTick("const id = \"laser\";\nfire(id, 0);", { slots })).toEqual([]);
    });
  });

  describe("init phase", () => {
    it("forbids commands and sensors reachable from init", () => {
      const source = `
function init() {
  plan();
}
function plan() {
  aim();
}
function aim() {
  turn(1);
}
function tick() {
  plan();
}`;
      expect(errorsOf(source)).toEqual([
        { line: 9, column: 3, message: "'turn' cannot be called during the init phase (init → plan → aim → turn)" },
      ]);
    });

    it("forbids them in top-level initializers", () => {
      expect(messages("let first = scan();\nfunction tick() {}")).toEqual([
        "'scan' cannot be called during the init phase (a top-level initializer → scan)",
      ]);
      expect(messages("function init() { log(self.weapons.map((w) => rangefind(w.id))); }\nfunction tick() {}")).toEqual([
        "'rangefind' cannot be called during the init phase (init → rangefind)",
      ]);
    });

    it("allows them where init cannot reach statically", () => {
      expect(messages("let later = () => scan();\nfunction init() { const f = () => fire(\"gun\", 0); }\nfunction tick() { later(); }")).toEqual([]);
      expect(messages("function init() { log(map.width); random(); }\nfunction tick() { scan(); }")).toEqual([]);
    });

    it("handles recursion", () => {
      expect(messages("function init() { a(); }\nfunction a() { a(); incoming(); }\nfunction tick() {}")).toEqual([
        "'incoming' cannot be called during the init phase (init → a → incoming)",
      ]);
    });
  });

  it("reports every semantic error in source order", () => {
    const errors = errorsOf("function tick(x) {\n  log(nope);\n  scan(1);\n  break;\n}\nconst self2 = self.bogus;");
    expect(errors).toEqual([
      { line: 1, column: 10, message: "tick() cannot take parameters" },
      { line: 2, column: 7, message: "'nope' is not declared" },
      { line: 3, column: 3, message: "'scan' takes no arguments but is given 1" },
      { line: 4, column: 3, message: "'break' is only allowed inside a loop" },
      { line: 6, column: 20, message: "self has no field 'bogus'" },
    ]);
  });
});
