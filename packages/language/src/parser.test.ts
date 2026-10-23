import { describe, expect, it } from "vitest";
import type { Expression, FunctionDeclaration, Statement } from "./ast.js";
import { tokenize } from "./lexer.js";
import { MAX_NESTING, parse } from "./parser.js";

function parsed(source: string) {
  const result = parse(source);
  expect(result.errors).toEqual([]);
  return result.program;
}

/** The statements of `function f() { <body> }`. */
function body(source: string): readonly Statement[] {
  const decl = parsed(`function f() { ${source} }`).body[0] as FunctionDeclaration;
  return decl.body.body;
}

/** The expression of the single expression statement `<source>;`. */
function expr(source: string): Expression {
  const statement = body(`${source};`)[0];
  if (statement?.type !== "ExpressionStatement") throw new Error(`not an expression: ${source}`);
  return statement.expression;
}

/** A compact rendering of an expression tree, to check precedence and associativity. */
function show(e: Expression): string {
  switch (e.type) {
    case "Identifier":
      return e.name;
    case "NumberLiteral":
      return String(e.value);
    case "StringLiteral":
      return JSON.stringify(e.value);
    case "BooleanLiteral":
      return String(e.value);
    case "NullLiteral":
      return "null";
    case "ListLiteral":
      return `[${e.elements.map(show).join(" ")}]`;
    case "RecordLiteral":
      return `{${e.fields.map((f) => `${f.key}:${show(f.value)}`).join(" ")}}`;
    case "ArrowFunction":
      return `(=> (${e.params.map((p) => p.name).join(" ")}) ${e.body.type === "Block" ? "{}" : show(e.body)})`;
    case "UnaryExpression":
      return `(${e.operator} ${show(e.operand)})`;
    case "BinaryExpression":
      return `(${e.operator} ${show(e.left)} ${show(e.right)})`;
    case "ConditionalExpression":
      return `(? ${show(e.test)} ${show(e.consequent)} ${show(e.alternate)})`;
    case "MemberExpression":
      return `(. ${show(e.object)} ${e.property.name})`;
    case "IndexExpression":
      return `([] ${show(e.object)} ${show(e.index)})`;
    case "CallExpression":
      return `(call ${[e.callee, ...e.args].map(show).join(" ")})`;
  }
}

function errorsOf(source: string) {
  return parse(source).errors;
}

function messages(source: string): string[] {
  return errorsOf(source).map((e) => e.message);
}

describe("tokenize", () => {
  it("reads numbers, strings, comments and positions", () => {
    const { tokens, errors } = tokenize("let a = .5 + 1e3; // note\n/* x\n y */ 'it\\'s\\n' 2.5E-2");
    expect(errors).toEqual([]);
    expect(tokens.map((t) => [t.kind, t.kind === "number" ? t.number : t.value, t.line, t.column])).toEqual([
      ["keyword", "let", 1, 1],
      ["identifier", "a", 1, 5],
      ["punct", "=", 1, 7],
      ["number", 0.5, 1, 9],
      ["punct", "+", 1, 12],
      ["number", 1000, 1, 14],
      ["punct", ";", 1, 17],
      ["string", "it's\n", 3, 7],
      ["number", 0.025, 3, 17],
      ["eof", "", 3, 23],
    ]);
  });

  it("reports reserved words, === and bad escapes but keeps going", () => {
    const { tokens, errors } = tokenize('var x = a === b; "\\q"');
    expect(errors).toEqual([
      { line: 1, column: 1, message: "'var' is not supported: use let or const" },
      { line: 1, column: 11, message: "'===' is not supported: use '=='" },
      { line: 1, column: 19, message: "invalid escape '\\q' (allowed: \\n \\t \\\\ \\\" \\')" },
    ]);
    expect(tokens.map((t) => t.value)).toEqual(["var", "x", "=", "a", "==", "b", ";", "", ""]);
  });

  it("rejects malformed literals", () => {
    expect(tokenize("1e").errors.map((e) => e.message)).toEqual(["unexpected character after a number"]);
    expect(tokenize("3px").errors.map((e) => e.message)).toEqual(["unexpected character after a number"]);
    expect(tokenize("1.;").errors.map((e) => e.message)).toEqual(["a number's '.' must be followed by digits"]);
    expect(tokenize("1e999").errors.map((e) => e.message)).toEqual(["number is too large"]);
    expect(tokenize('"abc\n"').errors.map((e) => e.message)).toContain("unterminated string");
    expect(tokenize("/* open").errors.map((e) => e.message)).toEqual(["unterminated block comment"]);
    expect(tokenize("`t`").errors.map((e) => e.message)).toEqual(["template literals are not supported: use + and str()"]);
    expect(tokenize("a # b").errors).toEqual([{ line: 1, column: 3, message: "unexpected character '#'" }]);
  });

  it("has no hex literals and no bitwise operators", () => {
    expect(tokenize("0x1F").errors.map((e) => e.message)).toEqual(["unexpected character after a number"]);
    expect(tokenize("a & b").errors.map((e) => e.message)).toEqual(["unexpected character '&'"]);
  });
});

describe("parse: expressions", () => {
  it("follows JavaScript precedence and associativity", () => {
    expect(show(expr("a || b && c == d < e + f * -g"))).toBe("(|| a (&& b (== c (< d (+ e (* f (- g)))))))");
    expect(show(expr("a - b - c"))).toBe("(- (- a b) c)");
    expect(show(expr("a ? b : c ? d : e"))).toBe("(? a b (? c d e))");
    expect(show(expr("!a.b[c](d, e).f"))).toBe("(! (. (call ([] (. a b) c) d e) f))");
    expect(show(expr("(a + b) * c"))).toBe("(* (+ a b) c)");
  });

  it("parses literals", () => {
    expect(show(expr('[1, "two", true, null, [],]'))).toBe('[1 "two" true null []]');
    expect(show(expr('f({ a: 1, "b c": x, })'))).toBe('(call f {a:1 b c:x})');
  });

  it("parses arrow functions", () => {
    expect(show(expr("xs.map((c) => c.x)"))).toBe("(call (. xs map) (=> (c) (. c x)))");
    expect(show(expr("xs.map(c => c.x)"))).toBe("(call (. xs map) (=> (c) (. c x)))");
    expect(show(expr("xs.sort((a, b) => a - b)"))).toBe("(call (. xs sort) (=> (a b) (- a b)))");
    expect(show(expr("f(() => { return 1; })"))).toBe("(call f (=> () {}))");
  });

  it("records operator locations", () => {
    const e = expr("a +\n  b");
    expect(e.loc).toEqual({ line: 1, column: 18 });
  });
});

describe("parse: statements", () => {
  it("parses a whole Program", () => {
    const program = parsed(`
      let target = null;
      const SPEED = 1;
      function init() {}
      function tick() {
        const foes = scan().filter((c) => c.isFoe);
        for (const f of foes) { if (f.distance < 10) { break; } else if (f.isFoe) { continue; } else { log(f); } }
        for (let i = 0; i < 3; i++) { target = i; }
        for (;;) { break; }
        while (true) { x += 1; self.y[0] = 2; break; }
        { let inner = 1; }
        function helper(a, b) { return a + b; }
        return;
      }`);
    expect(program.body.map((d) => d.type)).toEqual(["VarDeclaration", "VarDeclaration", "FunctionDeclaration", "FunctionDeclaration"]);
    const tick = program.body[3] as FunctionDeclaration;
    expect(tick.body.body.map((s) => s.type)).toEqual([
      "VarDeclaration",
      "ForOfStatement",
      "ForStatement",
      "ForStatement",
      "WhileStatement",
      "Block",
      "FunctionDeclaration",
      "ReturnStatement",
    ]);
  });

  it("parses assignments and updates as statements", () => {
    expect(body("a = 1; a.b += 2; a[0] -= 3; a *= 4; a /= 5; a++; a.b--;").map((s) => s.type)).toEqual([
      "AssignmentStatement",
      "AssignmentStatement",
      "AssignmentStatement",
      "AssignmentStatement",
      "AssignmentStatement",
      "UpdateStatement",
      "UpdateStatement",
    ]);
  });

  it("rejects assignments and updates inside expressions", () => {
    const why = "is a statement, not an expression: assignments and ++/-- cannot appear inside expressions";
    expect(messages("function f() { x = y = 0; }")).toEqual([`'=' ${why}`]);
    expect(messages("function f() { g(i++); }")).toEqual([`'++' ${why}`]);
    expect(messages("function f() { if (a = 1) {} }")).toEqual([`'=' ${why}`]);
  });

  it("requires braces around bodies", () => {
    expect(messages("function f() { if (a) return; }")).toEqual(["the body of if must be a block in braces"]);
    expect(messages("function f() { while (a) x(); }")).toEqual(["the body of while must be a block in braces"]);
    expect(messages("function f() { if (a) {} else x(); }")).toEqual(["the body of else must be a block in braces"]);
  });

  it("allows only declarations at the top level", () => {
    expect(errorsOf("let a = 1;\nlog(a);\nfunction tick() {}")).toEqual([
      { line: 2, column: 1, message: "only let, const and function declarations are allowed at the top level" },
    ]);
  });

  it("requires const initializers and let in for counters", () => {
    expect(messages("const a;")).toEqual(["const 'a' requires an initializer"]);
    expect(messages("function f() { for (const i = 0; i < 1; i++) {} }")).toEqual([
      "use let for a for loop's counter: const can only be used with for...of",
    ]);
  });

  it("rejects invalid assignment targets", () => {
    expect(messages("function f() { f() = 1; }")).toEqual([
      "cannot assign to this expression: '=' needs a variable, field or element on its left",
    ]);
  });

  it("recovers and reports independent syntax errors", () => {
    const errors = errorsOf("function tick() {\n  let a = ;\n  let b = 1;\n  b(;\n}\nlet c = 2\nfunction init() {}");
    expect(errors).toEqual([
      { line: 2, column: 11, message: "expected an expression but found ';'" },
      { line: 4, column: 5, message: "expected an expression but found ';'" },
      { line: 7, column: 1, message: "expected ';' but found 'function'" },
    ]);
  });

  it("reports an unclosed block", () => {
    expect(errorsOf("function tick() {\n  let a = 1;")).toEqual([{ line: 1, column: 17, message: "this '{' is never closed" }]);
  });

  it("reports reserved-word programs without looping", () => {
    expect(messages("class A {}").length).toBeGreaterThan(0);
    expect(messages("}}}").length).toBe(3);
  });

  it("caps nesting depth", () => {
    const deep = `let a = ${"(".repeat(MAX_NESTING + 10)}1${")".repeat(MAX_NESTING + 10)};`;
    expect(messages(deep)).toEqual([`code is nested more than ${String(MAX_NESTING)} levels deep`]);
    const unary = `let a = ${"- ".repeat(100_000)}1;`;
    expect(messages(unary)).toEqual([`code is nested more than ${String(MAX_NESTING)} levels deep`]);
    const ok = `let a = ${"(".repeat(50)}1${")".repeat(50)};`;
    expect(messages(ok)).toEqual([]);
  });
});
