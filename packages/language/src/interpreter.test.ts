import { describe, expect, it } from "vitest";
import { check } from "./checker.js";
import { R1_LANGUAGE } from "./definition.js";
import { Interpreter, MAX_EVALUATION_DEPTH, type HostFunction, type InterpreterLimits, type RunInput, type RunResult } from "./interpreter.js";
import { MAX_NESTING } from "./parser.js";
import { ProgramError, fromHost, str, type Value } from "./values.js";

const limits: InterpreterLimits = {
  memoryCells: 10000,
  maxCallDepth: 64,
  maxCollectionLength: 10000,
  logLinesPerTick: 50,
  logLineLength: 200,
};

const values = {
  self: fromHost({ name: "Ada", tick: 0, x: 5, y: 7, heading: 90, weapons: [{ id: "gun", range: 50 }] }),
  game: fromHost({ tickRate: 10, timeLimitTicks: 600, playerCount: 2 }),
  map: fromHost({ width: 100, height: 100, baseTerrain: "grass", terrainRegions: [], obstacles: [], spawnZones: [] }),
};

function input(budget = 1000): RunInput {
  return { budget, values };
}

/** A checked Program with stub host functions that record the commands they are given. */
function setup(source: string, extraLimits: Partial<InterpreterLimits> = {}) {
  const checked = check(source, { language: R1_LANGUAGE, maxSourceBytes: 65536 });
  if (!checked.ok) throw new Error(`check failed: ${JSON.stringify(checked.errors)}`);
  const commands: string[] = [];
  const host: Record<string, HostFunction> = {};
  for (const name of Object.keys(R1_LANGUAGE.functions)) {
    host[name] = () => {
      throw new ProgramError(`'${name}' is not available in this test`);
    };
  }
  const command =
    (name: string): HostFunction =>
    (args) => {
      commands.push(`${name} ${args.map((a) => str(a, 100)).join(" ")}`);
      return null;
    };
  host.throttle = command("throttle");
  host.turn = command("turn");
  host.fire = (args) => {
    if (args[0] !== "gun") throw new ProgramError(`no weapon in Slot '${str(args[0] ?? null, 100)}'`);
    command("fire")(args);
    return true;
  };
  host.scan = () => fromHost([{ id: 1, x: 10, y: 20, isFoe: true }]);
  host.sin = (args) => Math.sin(((args[0] as number) * Math.PI) / 180);
  let seed = 1;
  host.random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const interpreter = new Interpreter(checked.program, { language: R1_LANGUAGE, limits: { ...limits, ...extraLimits }, host });
  return { interpreter, commands };
}

/** Runs init, then `ticks` Ticks, returning every result. */
function play(source: string, ticks = 1, budget = 1000, extraLimits: Partial<InterpreterLimits> = {}) {
  const { interpreter, commands } = setup(source, extraLimits);
  const init = interpreter.init(input(budget * 20));
  const results: RunResult[] = [];
  for (let i = 0; i < ticks && !interpreter.halted; i++) results.push(interpreter.tick(input(budget)));
  return { interpreter, commands, init, results };
}

function firstTick(source: string, budget = 1000): RunResult {
  const result = play(source, 1, budget).results[0];
  if (result === undefined) throw new Error("no Tick ran");
  return result;
}

/** The operations used by one Tick whose tick() body is `body`, after `prelude` at the top level. */
function cost(body: string, prelude = ""): number {
  const result = firstTick(`${prelude}\nfunction tick() {\n${body}\n}`);
  expect(result.error).toBeNull();
  return result.operations;
}

/** The log output of one Tick whose tick() body is `body`. */
function logOf(body: string, prelude = ""): readonly string[] {
  const result = firstTick(`${prelude}\nfunction tick() {\n${body}\n}`);
  expect(result.error).toBeNull();
  return result.log;
}

describe("operation counting", () => {
  it.each([
    ["an empty tick", "", 0],
    ["literals and operators", "let x = 1 + 2;", 3],
    ["a list literal: 1 + 1 per element, plus the elements", "[1, 2, 3];", 7],
    ["a record literal: 1 + 1 per field, plus the values", "({ a: 1, b: 2 });", 5],
    ["compound assignment: target read + right side + arithmetic", "let x = 0; x += 2;", 4],
    ["an update", "let x = 0; x++;", 3],
    ["a plain assignment does not charge its target", "let x = 0; x = 5;", 2],
    ["a built-in's fixed cost", "abs(-1);", 3],
    ["a sensor's fixed cost", "scan();", 15],
    ["member access on built-in values", "self.x;", 2],
    ["indexing", "[7][0];", 5],
    ["'.length' in place of the member access", "[1].length;", 4],
    ["a skipped short-circuit operand costs nothing", "false && abs(1) == 1;", 2],
    ["'?:' evaluates only the chosen branch", "true ? 1 : abs(2);", 3],
    ["while: condition each time, 1 per iteration, body", "let i = 0; while (i < 3) { i++; }", 22],
    ["for: init, conditions, iterations, updates", "for (let i = 0; i < 2; i++) {}", 16],
    ["for…of: 1 per iteration", "for (const x of [1, 2]) {}", 7],
    ["a method costs its fixed cost, callbacks cost their code", "[1, 2].map((x) => x);", 11],
  ])("%s", (_name, body, expected) => {
    expect(cost(body)).toBe(expected);
  });

  it("charges 1 for a user function call, plus its body", () => {
    expect(cost("f(1);", "function f(a) { return a; }")).toBe(3);
  });

  it("ignores extra arguments to a user function", () => {
    expect(logOf("const f = (a) => a; log(f(1, 2));")).toEqual(["1"]);
  });

  it("reports the budget left after budgetRemaining's own cost", () => {
    expect(firstTick("function tick() { log(budgetRemaining()); }", 100).log).toEqual(["99"]);
  });

  it("counts identically across runs and interpreters", () => {
    const source = `
      let history = [];
      function tick() {
        const r = random();
        history.push(r);
        if (history.length > 5) { history = history.slice(1); }
        const sorted = history.slice(0).sort((a, b) => a - b);
        let total = 0;
        for (const x of sorted) { if (x > 0.5) { total += x; } }
        log(str(total));
      }`;
    const runs = [play(source, 20), play(source, 20)].map(({ results }) => results.map((r) => [r.operations, ...r.log]));
    expect(runs[0]).toEqual(runs[1]);
    expect(new Set(runs[0]?.map((r) => r[0])).size).toBeGreaterThan(1);
  });
});

describe("the Operation Budget", () => {
  it("stops when a charge would exceed the budget, keeping commands already issued", () => {
    const { results, commands } = play("function tick() { throttle(1); turn(1); }", 1, 5);
    expect(commands).toEqual(["throttle 1"]);
    expect(results[0]).toMatchObject({
      outcome: "outOfBudget",
      operations: 4,
      error: { line: 1, message: "the Operation Budget is exhausted" },
      halt: null,
    });
  });

  it("does not carry over between Ticks", () => {
    const { results, commands } = play("function tick() { throttle(1); while (true) {} }", 3, 50);
    expect(results.map((r) => r.outcome)).toEqual(["outOfBudget", "outOfBudget", "outOfBudget"]);
    expect(results.map((r) => r.operations)).toEqual([50, 50, 50]);
    expect(commands).toEqual(["throttle 1", "throttle 1", "throttle 1"]);
  });

  it("halts the Program when the init budget runs out", () => {
    const { init, interpreter, results } = play("let n = 0; function init() { while (true) { n++; } } function tick() {}", 1, 10);
    expect(init.outcome).toBe("outOfBudget");
    expect(init.operations).toBeLessThanOrEqual(200);
    expect(init.halt).toMatch(/init phase failed/);
    expect(interpreter.halted).toBe(true);
    expect(results).toEqual([]);
    expect(() => interpreter.tick(input())).toThrow(/halted/);
  });
});

describe("runtime errors", () => {
  it("end the Tick with a located error, keep issued commands, and let the next Tick run", () => {
    const source = `function tick() {\n  throttle(1);\n  let x = "hp: " + 5;\n  turn(1);\n}`;
    const { results, commands, interpreter } = play(source, 2);
    expect(results[0]?.outcome).toBe("error");
    expect(results[0]?.error).toEqual({ line: 3, column: 18, message: "'+' needs two numbers or two strings, got string and number" });
    expect(commands).toEqual(["throttle 1", "throttle 1"]);
    expect(interpreter.halted).toBe(false);
  });

  it.each([
    ["division by zero", "1 / 0;", /not a finite number/],
    ["x % 0", "5 % 0;", /not a finite number/],
    ["sqrt of a negative", "sqrt(-1);", /not a finite number/],
    ["a non-boolean condition", "if (1) {}", /condition must be a boolean/],
    ["a missing field", "const r = { a: 1 }; r.b;", /no field 'b'/],
    ["an index out of range", "[1][1];", /out of range/],
    ["a non-integer index", "[1][0.5];", /must be integers/],
    ["assigning past the end", "const xs = [1]; xs[1] = 2;", /out of range/],
    ["indexing a string", '"ab"[0];', /use \.slice/],
    ["popping an empty list", "[].pop();", /empty list/],
    ["a filter callback returning a non-boolean", "[1].filter((x) => x);", /must return a boolean/],
    ["calling a non-function", "const f = 1; f();", /cannot call a number/],
    ["too few arguments to a user function", "const f = (a, b) => a; f(1);", /takes 2 arguments but is given 1/],
    ["mutating a built-in value through a variable", "const w = self.weapons; w.push(1);", /read-only/],
    ["removing from a built-in value", "const s = self; remove(s, \"x\");", /read-only/],
    ["an unknown weapon reported by the host", 'fire("laser", 0);', /no weapon in Slot 'laser'/],
    ["a let read before its declaration", "const f = () => x; f(); let x = 1;", /used before its declaration/],
    ["exceeding maxCollectionLength", "const xs = []; while (true) { xs.push(1); }", /over the limit of 10000/],
  ])("%s", (_name, body, message) => {
    const result = firstTick(`function tick() { ${body} }`, 1_000_000);
    expect(result.outcome).toBe("error");
    expect(result.error?.message).toMatch(message);
  });

  it("gives host errors the location of the call", () => {
    const result = firstTick('function tick() {\n  fire("laser", 0);\n}');
    expect(result.error).toMatchObject({ line: 2, column: 7 });
  });

  it("limits nested calls to maxCallDepth, counting tick() as 1", () => {
    const deepest = (maxCallDepth: number) =>
      play("let d = 0; function r(n) { d = n; r(n + 1); } function tick() { r(2); }", 1, 1_000_000, { maxCallDepth }).results[0];
    const result = deepest(64);
    expect(result?.error?.message).toBe("more than 64 nested calls");
  });

  describe("hostile nesting at the maximum call depth", () => {
    const tooDeep = `the Program is nested too deeply: more than ${String(MAX_EVALUATION_DEPTH)} levels of evaluation`;
    const nest = (open: string, k: number, close = "") => (inner: string) => open.repeat(k) + inner + close.repeat(k);
    /** Recursive functions r(n) whose every call wraps the next in `k` levels of one nesting shape. */
    const shapes: readonly [string, (k: number) => string][] = [
      ["list literals", (k) => `function r(n) { if (n > 0) { return ${nest("[", k, "]")("r(n - 1)")}; } return 0; }`],
      ["record literals", (k) => `function r(n) { if (n > 0) { return ${nest("{ a: ", k, " }")("r(n - 1)")}; } return 0; }`],
      ["built-in call arguments", (k) => `function r(n) { if (n > 0) { return ${nest("abs(", k, ")")("r(n - 1)")}; } return 0; }`],
      ["user call arguments", (k) => `function id(x) { return x; } function r(n) { if (n > 0) { return ${nest("id(", k, ")")("r(n - 1)")}; } return 0; }`],
      ["unary chains", (k) => `function r(n) { if (n > 0) { return ${nest("- ", k)("r(n - 1)")}; } return 0; }`],
      ["indexing", (k) => `const z = [0]; function r(n) { if (n > 0) { return ${nest("z[", k, "]")("r(n - 1)")}; } return 0; }`],
      ["?: branches", (k) => `function r(n) { if (n > 0) { return ${nest("false ? 0 : ", k)("r(n - 1)")}; } return 0; }`],
      ["nested if", (k) => `function r(n) { ${nest("if (n > 0) { ", k, " }")("return r(n - 1);")} return 0; }`],
      ["else if chains", (k) => `function r(n) { if (n <= 0) { return 0; } ${"else if (false) {} ".repeat(k)}else { return r(n - 1); } }`],
      ["blocks", (k) => `function r(n) { if (n > 0) { ${nest("{ ", k, " }")("return r(n - 1);")} } return 0; }`],
      ["while", (k) => `function r(n) { if (n > 0) { ${nest("while (true) { ", k, " }")("return r(n - 1);")} } return 0; }`],
      ["for", (k) => `function r(n) { if (n > 0) { ${nest("for (let i = 0; true; i++) { ", k, " }")("return r(n - 1);")} } return 0; }`],
      ["for…of", (k) => `function r(n) { if (n > 0) { ${nest("for (const x of [1]) { ", k, " }")("return r(n - 1);")} } return 0; }`],
      [
        ".reduce callbacks with nested if",
        (k) => `function r(n) { if (n > 0) { return [1].reduce((a, x) => { ${nest("if (true) { ", k, " }")("return r(n - 1);")} return 0; }, 0); } return 0; }`,
      ],
      [".reduce callbacks with built-in calls", (k) => `function r(n) { if (n > 0) { return [1].reduce((a, x) => ${nest("abs(", k, ")")("r(n - 1)")}, 0); } return 0; }`],
      [
        ".sort comparators with built-in calls",
        (k) =>
          `let big = []; function init() { for (let i = 0; i < 1024; i++) { big.push(i); } } ` +
          `function r(n) { if (n > 0) { return big.slice(0).sort((a, b) => ${nest("abs(", k, ")")("r(n - 1)")}); } return 0; }`,
      ],
    ];

    /** The shape's Program at the deepest nesting the checker accepts, recursing past maxCallDepth. */
    const deepest = (shape: (k: number) => string): string => {
      const source = (k: number) => `${shape(k)} function tick() { log(str(r(70))); }`;
      for (let k = MAX_NESTING; k > 0; k--) {
        if (check(source(k), { language: R1_LANGUAGE, maxSourceBytes: 65536 }).ok) return source(k);
      }
      throw new Error("no nesting depth passes the checker");
    };

    /** How many frames of a small function fit on what is left of the JS stack. */
    const framesLeft = (): number => {
      let frames = 0;
      const probe = (): void => {
        frames++;
        probe();
      };
      try {
        probe();
      } catch {
        // The stack overflowed, as intended.
      }
      return frames;
    };

    /** Runs `body` with about `share` of the remaining JS stack already in use. */
    const withStackUsed = <T>(share: number, body: () => T): T => {
      const descend = (n: number): T => (n === 0 ? body() : descend(n - 1));
      return descend(Math.floor(framesLeft() * share));
    };

    it.each(shapes)("stops %s with the nesting error, not a stack overflow", (_name, shape) => {
      const result = firstTick(deepest(shape), 1_000_000);
      expect(result.outcome).toBe("error");
      expect(result.error?.message).toBe(tooDeep);
    });

    it.each(shapes)("stops %s with the nesting error even with half the stack already used", (_name, shape) => {
      const source = deepest(shape);
      const result = withStackUsed(0.5, () => firstTick(source, 1_000_000));
      expect(result.error?.message).toBe(tooDeep);
    });

    it("still stops plain recursion at maxCallDepth first", () => {
      const result = firstTick("function r(n) { if (n > 0) { return r(n - 1); } return 0; } function tick() { log(str(r(70))); }", 1_000_000);
      expect(result.error?.message).toBe("more than 64 nested calls");
    });
  });

  it("halts the Program when the init phase calls a forbidden built-in through a function value", () => {
    const { init, interpreter } = play("function init() { const f = scan; f(); } function tick() {}");
    expect(init.error?.message).toBe("'scan' cannot be called during the init phase");
    expect(init.halt).toMatch(/init phase failed/);
    expect(interpreter.halted).toBe(true);
  });

  it("halts the Program when a top-level initializer fails", () => {
    const { init, interpreter } = play("let x = 1 / 0; function tick() {}");
    expect(init.outcome).toBe("error");
    expect(interpreter.halted).toBe(true);
  });
});

describe("Program lifecycle", () => {
  it("runs top-level initializers, then init(), with self, game and map", () => {
    const { init } = play(`
      let a = game.tickRate;
      let b = a * 2;
      function init() { log(str(b) + " " + self.name + " " + str(map.width)); }
      function tick() {}`);
    expect(init.outcome).toBe("completed");
    expect(init.log).toEqual(["20 Ada 100"]);
  });

  it("keeps top-level state between Ticks and discards locals", () => {
    const { results } = play("let n = 0; function tick() { let local = 0; local++; n++; log(n + local); }", 3);
    expect(results.map((r) => r.log)).toEqual([["2"], ["3"], ["4"]]);
  });

  it("hoists function declarations so mutual recursion works", () => {
    expect(logOf("log(even(10));", "function even(n) { return n == 0 ? true : odd(n - 1); } function odd(n) { return n == 0 ? false : even(n - 1); }")).toEqual([
      "true",
    ]);
  });

  it("gives closures in a for loop a fresh variable per iteration", () => {
    expect(logOf('const fs = []; for (let i = 0; i < 3; i++) { fs.push(() => i); } log(fs.map((f) => f()).join(","));')).toEqual(["0,1,2"]);
  });

  it("supports break, continue and return from inside loops", () => {
    const body = `
      let out = [];
      for (let i = 0; i < 10; i++) {
        if (i == 1) { continue; }
        if (i == 4) { break; }
        out.push(i);
      }
      log(out);
      log(first([5, 6, 7]));`;
    expect(logOf(body, "function first(xs) { for (const x of xs) { if (x > 5) { return x; } } return null; }")).toEqual(["[0,2,3]", "6"]);
  });

  it("iterates for…of and callback methods over a snapshot of the list", () => {
    const body = `
      const xs = [1, 2];
      for (const x of xs) { xs.push(x * 10); }
      log(xs);
      const ys = [1, 2, 3];
      let seen = [];
      for (const y of ys) { seen.push(y); if (ys.length > 1) { ys.pop(); } }
      log([seen, ys]);
      const zs = [1, 2];
      log(zs.map((z) => zs.push(z)));`;
    expect(logOf(body)).toEqual(["[1,2,10,20]", "[[1,2,3],[1]]", "[3,4]"]);
  });

  it("rejects host misuse with ordinary exceptions", () => {
    const { interpreter } = setup("function tick() {}");
    expect(() => interpreter.tick(input())).toThrow(/before init/);
    interpreter.init(input());
    expect(() => interpreter.init(input())).toThrow(/already run/);
    expect(() => interpreter.tick({ budget: 10, values: {} })).toThrow(/no value given for built-in 'self'/);
    const checked = check("function tick() {}", { language: R1_LANGUAGE, maxSourceBytes: 65536 });
    if (!checked.ok) throw new Error("check failed");
    expect(() => new Interpreter(checked.program, { language: R1_LANGUAGE, limits, host: {} })).toThrow(/no host implementation/);
  });
});

describe("values and built-ins", () => {
  it("formats values with str()", () => {
    expect(logOf('log([1, -0, 1e21, "a", { b: null, c: true }, () => 1, str]); log("plain"); log(0.1 + 0.2);')).toEqual([
      '[1,0,1e+21,"a",{"b":null,"c":true},<function>,<function>]',
      "plain",
      "0.30000000000000004",
    ]);
  });

  it("keeps record fields in insertion order, including integer-like keys", () => {
    expect(logOf('const r = { b: 1 }; r["2"] = 2; r.a = 3; remove(r, "b"); log(keys(r)); log(has(r, "a"));')).toEqual(['["2","a"]', "true"]);
  });

  it("compares by value for primitives and by identity otherwise", () => {
    expect(logOf("const a = [1]; log([a == a, a == [1], -0 == 0, null == false, sin == sin, \"x\" < \"y\"]);")).toEqual([
      "[true,false,true,false,true,true]",
    ]);
  });

  it("implements list and string methods", () => {
    const body = `
      const xs = [3, 1, 2];
      log([xs.indexOf(2), xs.includes(4), xs.slice(-2), xs.join("-"), xs.find((x) => x < 3), xs.some((x) => x > 2), xs.every((x) => x > 2)]);
      log([xs.reduce((acc, x) => acc + x, 0), xs.push(9), xs.pop(), xs.map(str), "hello".slice(1, 3), "hello".indexOf("l"), "hello".includes("z")]);
      log([round(2.5), round(-2.5), clamp(5, 0, 3), min(1, 2), max(1, 2), floor(-1.5), ceil(1.2), abs(-3)]);`;
    expect(logOf(body)).toEqual(['[2,false,[1,2],"3-1-2",1,true,false]', '[6,4,9,["3","1","2"],"el",2,false]', "[3,-2,3,1,2,-2,2,3]"]);
  });

  it("sorts stably with a pinned sequence of comparator calls", () => {
    const body = `
      let calls = 0;
      const xs = [{ k: 1, id: "a" }, { k: 0, id: "b" }, { k: 1, id: "c" }, { k: 0, id: "d" }, { k: 2, id: "e" }];
      xs.sort((p, q) => { calls++; return p.k - q.k; });
      log(xs.map((x) => x.id).join(""));
      log(calls);`;
    expect(logOf(body)).toEqual(["bdace", "7"]);
  });

  it("errors instead of looping on a list that contains itself", () => {
    const result = firstTick("function tick() { const a = []; a.push(a); log(a); }");
    expect(result.error?.message).toMatch(/longer than 10000 characters/);
  });

  it("caps log output per Tick without changing its cost", () => {
    const source = 'function tick() { log("abcdef"); log("abcdef"); log("abcdef"); }';
    const result = play(source, 1, 1000, { logLinesPerTick: 2, logLineLength: 3 }).results[0];
    expect(result).toMatchObject({ log: ["abc", "abc"], logTruncated: true, operations: 9 });
  });
});

describe("the memory cap", () => {
  function memoryOf(prelude: string): number {
    return play(`${prelude}\nfunction tick() {}`).init.memoryCells;
  }

  it.each([
    ["numbers, booleans and null", "let a = 1; let b = true; let c = null;", 3],
    ["a string: 1 + ⌈length / 8⌉", 'let s = "abcdefghi";', 3],
    ["a list: 1 + its elements", "let xs = [1, 2];", 3],
    ["a record: 1 + per field the key and the value", "let r = { a: 1, b: [] };", 5],
    ["a value reachable twice is counted once", "let xs = [1]; let ys = [xs, xs];", 3],
    ["a top-level function is free", "let f = tick;", 0],
    ["a closure: 1 + captured variables + what they reach", "let f = null; function init() { let n = [1]; f = () => n; }", 4],
    ["a list containing itself", "let a = []; function init() { a.push(a); }", 1],
  ])("%s", (_name, prelude, expected) => {
    expect(memoryOf(prelude)).toBe(expected);
  });

  it("halts the Program when persistent state exceeds the cap at the end of a Tick", () => {
    const { results, interpreter } = play("let xs = []; function tick() { xs.push(1); }", 10, 1000, { memoryCells: 4 });
    expect(results.map((r) => r.memoryCells)).toEqual([2, 3, 4, 5]);
    expect(results.at(-1)?.halt).toBe("persistent state uses 5 cells, over the 4-cell memory cap");
    expect(interpreter.halted).toBe(true);
  });

  it("measures persistent state even when the Tick stops early", () => {
    const { results } = play("let xs = []; function tick() { xs.push(1); xs.push(1); 1 / 0; }", 1);
    expect(results[0]).toMatchObject({ outcome: "error", memoryCells: 3 });
  });

  it("does not count temporary values", () => {
    const { results } = play("let n = 0; function tick() { const big = []; for (let i = 0; i < 100; i++) { big.push(i); } }", 1, 100_000, {
      memoryCells: 1,
    });
    expect(results[0]).toMatchObject({ outcome: "completed", memoryCells: 1, halt: null });
  });
});

describe("host values", () => {
  it("are read-only and keep their key order", () => {
    const value: Value = fromHost({ b: 1, a: [1, { c: "x" }] });
    expect(str(value, 100)).toBe('{"b":1,"a":[1,{"c":"x"}]}');
    expect(() => fromHost(Number.NaN)).toThrow(/not a finite number/);
  });
});
