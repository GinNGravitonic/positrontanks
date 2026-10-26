/**
 * The tree-walking interpreter for checked Programs (language-r1 sections 5,
 * 8, 9 and 10).
 *
 * An `Interpreter` holds one Bot's Program and its persistent top-level
 * state. The host calls `init` once at Game start and then `tick` once per
 * Tick, each with that run's Operation Budget and built-in values (`self`,
 * `game`, `map`). Every run reports how it ended, the operations it used, the
 * persistent state's size and its log output. Runtime errors and budget
 * exhaustion stop the run but are returned, never thrown, so a Program can
 * never crash its host; whatever host functions did before the stop (such as
 * recording commands) stands.
 *
 * Built-ins that belong to the language itself (records, `str`, `log`,
 * `budgetRemaining`, the exactly rounded math functions, and list and string
 * methods) are implemented here. The host supplies every other built-in of
 * its Ruleset: commands, sensors, Terrain, trigonometry and `random`.
 *
 * Cost accounting (section 8.1) is applied as follows:
 * - An operation is charged after its operands are evaluated and immediately
 *   before it is performed, so an operation the budget cannot cover never
 *   happens.
 * - A call by name (`f(x)`, `scan()`) charges 1 for a user function or the
 *   built-in's cost; the callee name itself is not charged separately. A list
 *   or string method call charges the method's cost in place of both the
 *   member access and the call. Any other callee is evaluated normally.
 * - Built-ins calling a callback, and the host calling `init()` and `tick()`,
 *   charge no call node: only the code that runs inside is charged.
 * - A loop iteration is charged after its condition passes, before the body.
 * - A plain assignment does not charge its target name; a compound
 *   assignment or update charges reading it, as an ordinary read.
 *
 * `.sort` is a top-down merge sort that splits at ⌊n/2⌋ and takes the left
 * element when `cmp(left, right) <= 0`; this pins its comparator calls.
 * Callback-taking methods iterate over a snapshot of the list taken when
 * they are called, and `for…of` over one taken when the loop starts.
 */

import type {
  ArrowFunction,
  AssignmentTarget,
  BinaryOperator,
  Block,
  CallExpression,
  Expression,
  ForStatement,
  FunctionDeclaration,
  Location,
  MemberExpression,
  Program,
  Statement,
} from "./ast.js";
import { lookup, type LanguageDefinition } from "./definition.js";
import type { Diagnostic } from "./lexer.js";
import {
  BuiltinRef,
  Closure,
  ListValue,
  ProgramError,
  RecordValue,
  Scope,
  equals,
  str,
  typeName,
  type Binding,
  type Value,
} from "./values.js";

/** The Ruleset limits the interpreter enforces (section 11). */
export interface InterpreterLimits {
  readonly memoryCells: number;
  readonly maxCallDepth: number;
  readonly maxCollectionLength: number;
  readonly logLinesPerTick: number;
  readonly logLineLength: number;
}

/**
 * A built-in implemented by the host. Arity, the init-phase restriction and
 * the cost are handled by the interpreter; argument types are the host's to
 * check, by throwing a `ProgramError`.
 */
export type HostFunction = (args: readonly Value[]) => Value;

export interface InterpreterOptions {
  readonly language: LanguageDefinition;
  readonly limits: InterpreterLimits;
  /** Implementations of the language's built-ins that the interpreter does not provide. */
  readonly host: Readonly<Record<string, HostFunction>>;
}

export interface RunInput {
  /** The Operation Budget for this run: the init budget, or the per-Tick budget. */
  readonly budget: number;
  /** The language's built-in values for this run, normally made with `fromHost`. */
  readonly values: Readonly<Record<string, Value>>;
}

export interface RunResult {
  /** Whether the run finished, ran out of budget, or stopped at a runtime error. */
  readonly outcome: "completed" | "outOfBudget" | "error";
  /** Where and why the run stopped early, or null if it completed. */
  readonly error: Diagnostic | null;
  /** Operations charged during the run. */
  readonly operations: number;
  /** The size of persistent state at the end of the run, in cells. */
  readonly memoryCells: number;
  /** Why the Program halted at the end of this run, or null if it will keep running. */
  readonly halt: string | null;
  /** `log()` output, already capped to `logLinesPerTick` lines of `logLineLength` characters. */
  readonly log: readonly string[];
  /** True if `log()` was called more than `logLinesPerTick` times. */
  readonly logTruncated: boolean;
}

/** Built-in functions implemented by the interpreter rather than the host. */
const INTRINSICS = new Set([
  "abs",
  "min",
  "max",
  "clamp",
  "floor",
  "ceil",
  "round",
  "sqrt",
  "keys",
  "has",
  "remove",
  "str",
  "log",
  "budgetRemaining",
]);

const LIST_METHODS = new Set(["push", "pop", "slice", "indexOf", "includes", "join", "map", "filter", "find", "some", "every", "reduce", "sort"]);
const STRING_METHODS = new Set(["slice", "indexOf", "includes"]);

class OutOfBudget extends Error {
  constructor(readonly loc: Location) {
    super("the Operation Budget is exhausted");
  }
}

type Completion = undefined | "break" | "continue" | { readonly value: Value };

const ARITHMETIC: Readonly<Record<string, BinaryOperator>> = { "+=": "+", "-=": "-", "*=": "*", "/=": "/", "++": "+", "--": "-" };

/** The names a function reads or writes from enclosing scopes, cached per function node. */
const freeNameCache = new WeakMap<FunctionDeclaration | ArrowFunction, readonly string[]>();

function freeNames(fn: FunctionDeclaration | ArrowFunction): readonly string[] {
  const cached = freeNameCache.get(fn);
  if (cached !== undefined) return cached;
  const free = new Set<string>();
  const scopes: Set<string>[] = [];
  const declared = (name: string): boolean => scopes.some((s) => s.has(name));
  const ref = (name: string): void => {
    if (!declared(name)) free.add(name);
  };
  const withScope = (names: readonly string[], body: () => void): void => {
    scopes.push(new Set(names));
    body();
    scopes.pop();
  };
  const hoisted = (body: readonly Statement[]): string[] =>
    body.flatMap((s) => (s.type === "FunctionDeclaration" || s.type === "VarDeclaration" ? [s.id.name] : []));
  const func = (params: readonly { readonly name: string }[], body: Block | Expression): void => {
    withScope(params.map((p) => p.name), () => {
      if (body.type === "Block") statements(body.body);
      else expression(body);
    });
  };
  const statements = (body: readonly Statement[]): void => {
    for (const name of hoisted(body)) scopes.at(-1)?.add(name);
    for (const s of body) statement(s);
  };
  const block = (b: Block): void => {
    withScope([], () => {
      statements(b.body);
    });
  };
  const target = (t: AssignmentTarget): void => {
    if (t.type === "Identifier") ref(t.name);
    else expression(t);
  };
  const statement = (s: Statement): void => {
    switch (s.type) {
      case "VarDeclaration":
        if (s.init !== null) expression(s.init);
        return;
      case "FunctionDeclaration":
        func(s.params, s.body);
        return;
      case "IfStatement":
        expression(s.test);
        block(s.consequent);
        if (s.alternate !== null) statement(s.alternate);
        return;
      case "WhileStatement":
        expression(s.test);
        block(s.body);
        return;
      case "ForStatement":
        withScope(s.init?.type === "VarDeclaration" ? [s.init.id.name] : [], () => {
          if (s.init !== null) statement(s.init);
          if (s.test !== null) expression(s.test);
          if (s.update !== null) statement(s.update);
          block(s.body);
        });
        return;
      case "ForOfStatement":
        expression(s.iterable);
        withScope([s.id.name], () => {
          block(s.body);
        });
        return;
      case "ReturnStatement":
        if (s.argument !== null) expression(s.argument);
        return;
      case "Block":
        block(s);
        return;
      case "AssignmentStatement":
        target(s.target);
        expression(s.value);
        return;
      case "UpdateStatement":
        target(s.target);
        return;
      case "ExpressionStatement":
        expression(s.expression);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
    }
  };
  const expression = (e: Expression): void => {
    switch (e.type) {
      case "Identifier":
        ref(e.name);
        return;
      case "ListLiteral":
        e.elements.forEach(expression);
        return;
      case "RecordLiteral":
        for (const field of e.fields) expression(field.value);
        return;
      case "ArrowFunction":
        func(e.params, e.body);
        return;
      case "UnaryExpression":
        expression(e.operand);
        return;
      case "BinaryExpression":
        expression(e.left);
        expression(e.right);
        return;
      case "ConditionalExpression":
        expression(e.test);
        expression(e.consequent);
        expression(e.alternate);
        return;
      case "MemberExpression":
        expression(e.object);
        return;
      case "IndexExpression":
        expression(e.object);
        expression(e.index);
        return;
      case "CallExpression":
        expression(e.callee);
        e.args.forEach(expression);
        return;
      case "NumberLiteral":
      case "StringLiteral":
      case "BooleanLiteral":
      case "NullLiteral":
        return;
    }
  };
  func(fn.params, fn.body);
  const result = [...free];
  freeNameCache.set(fn, result);
  return result;
}

/**
 * How many statements and expressions may be under evaluation at once, across
 * all active calls (language-r1 section 10.2). A fixed rule of the language,
 * not Ruleset data. On Node 24's default stack the costliest nesting shape
 * (built-in call arguments, `abs(abs(…))`) overflows at about 1,050 levels, so
 * this limit leaves a fourfold margin: a Program stops with this ordinary
 * runtime error, never at a host-dependent stack overflow.
 */
export const MAX_EVALUATION_DEPTH = 256;

function isStackOverflow(e: unknown): boolean {
  return e instanceof RangeError && /call stack/i.test(e.message);
}

export class Interpreter {
  private readonly global = new Scope(null);
  private readonly builtinRefs = new Map<string, BuiltinRef>();
  private readonly tickDecl: FunctionDeclaration;
  private readonly initDecl: FunctionDeclaration | undefined;
  private state: "new" | "running" | "halted" = "new";

  // Per-run state.
  private phase: "init" | "tick" = "init";
  private remaining = 0;
  private values: Readonly<Record<string, Value>> = {};
  private depth = 0;
  private evaluationDepth = 0;
  private lastCall: Location = { line: 1, column: 1 };
  private logLines: string[] = [];
  private logTruncated = false;

  /** Prepares a Program that has passed `check` against the same language. */
  constructor(
    private readonly program: Program,
    private readonly options: InterpreterOptions,
  ) {
    for (const name of Object.keys(options.language.functions)) {
      if (!INTRINSICS.has(name) && lookup(options.host, name) === undefined) {
        throw new Error(`no host implementation for built-in '${name}'`);
      }
    }
    for (const name of [...Object.keys(options.language.listMethods), ...Object.keys(options.language.stringMethods)]) {
      if (!LIST_METHODS.has(name) && !STRING_METHODS.has(name)) throw new Error(`no implementation for method '.${name}'`);
    }
    const entry = (name: string): FunctionDeclaration | undefined =>
      program.body.find((d): d is FunctionDeclaration => d.type === "FunctionDeclaration" && d.id.name === name);
    const tick = entry("tick");
    if (tick === undefined) throw new Error("the Program has no tick() function; check it first");
    this.tickDecl = tick;
    this.initDecl = entry("init");
  }

  /** True once the Program has halted (section 10.3); it must not be run again. */
  get halted(): boolean {
    return this.state === "halted";
  }

  /** Runs the top-level initializers and `init()` with the init budget. */
  init(input: RunInput): RunResult {
    if (this.state !== "new") throw new Error("init() has already run");
    this.state = "running";
    return this.run(input, "init", () => {
      this.hoist(this.program.body, this.global, true);
      for (const decl of this.program.body) {
        if (decl.type === "VarDeclaration") this.statement(decl, this.global);
      }
      if (this.initDecl !== undefined) this.callEntry(this.initDecl);
    });
  }

  /** Runs `tick()` with the per-Tick budget. */
  tick(input: RunInput): RunResult {
    if (this.state === "new") throw new Error("tick() called before init()");
    if (this.state === "halted") throw new Error("the Program has halted");
    return this.run(input, "tick", () => {
      this.callEntry(this.tickDecl);
    });
  }

  private callEntry(decl: FunctionDeclaration): void {
    const value = this.global.bindings.get(decl.id.name)?.value ?? null;
    this.callValue(value, [], decl.id.loc, false);
  }

  private run(input: RunInput, phase: "init" | "tick", body: () => void): RunResult {
    for (const name of Object.keys(this.options.language.values)) {
      if (lookup(input.values, name) === undefined) throw new Error(`no value given for built-in '${name}'`);
    }
    this.phase = phase;
    this.remaining = input.budget;
    this.values = input.values;
    this.depth = 0;
    this.evaluationDepth = 0;
    this.lastCall = { line: 1, column: 1 };
    this.logLines = [];
    this.logTruncated = false;
    let outcome: RunResult["outcome"] = "completed";
    let error: Diagnostic | null = null;
    try {
      body();
    } catch (e) {
      if (e instanceof OutOfBudget) {
        outcome = "outOfBudget";
        error = { line: e.loc.line, column: e.loc.column, message: e.message };
      } else if (e instanceof ProgramError) {
        outcome = "error";
        const loc = e.loc ?? this.lastCall;
        error = { line: loc.line, column: loc.column, message: e.message };
      } else if (isStackOverflow(e)) {
        // A last-resort safety net: MAX_EVALUATION_DEPTH should always stop the Program first.
        outcome = "error";
        error = { line: this.lastCall.line, column: this.lastCall.column, message: "the Program is nested too deeply to run" };
      } else {
        throw e;
      }
    }
    const memoryCells = this.measureMemory();
    const { limits } = this.options;
    let halt: string | null = null;
    if (phase === "init" && error !== null) {
      halt = `the init phase failed: ${error.message}`;
    } else if (memoryCells > limits.memoryCells) {
      halt = `persistent state uses ${String(memoryCells)} cells, over the ${String(limits.memoryCells)}-cell memory cap`;
    }
    if (halt !== null) this.state = "halted";
    return {
      outcome,
      error,
      operations: input.budget - this.remaining,
      memoryCells,
      halt,
      log: this.logLines,
      logTruncated: this.logTruncated,
    };
  }

  // ---------------------------------------------------------------- budget

  private charge(cost: number, loc: Location): void {
    if (cost > this.remaining) throw new OutOfBudget(loc);
    this.remaining -= cost;
  }

  /** Counts one more statement or expression under evaluation; the caller decrements when it finishes. */
  private enter(loc: Location): void {
    if (this.evaluationDepth >= MAX_EVALUATION_DEPTH) {
      throw new ProgramError(`the Program is nested too deeply: more than ${String(MAX_EVALUATION_DEPTH)} levels of evaluation`, loc);
    }
    this.evaluationDepth++;
  }

  // ------------------------------------------------------------ statements

  /** Declares a block's names: functions are created at once, let/const start uninitialized. */
  private hoist(body: readonly Statement[], scope: Scope, topLevel = false): void {
    for (const s of body) {
      if (s.type === "FunctionDeclaration") {
        scope.bindings.set(s.id.name, { value: new Closure(s, s.params, s.body, scope, topLevel), initialized: true, constant: false });
      } else if (s.type === "VarDeclaration") {
        scope.bindings.set(s.id.name, { value: null, initialized: false, constant: s.kind === "const" });
      }
    }
  }

  private statements(body: readonly Statement[], scope: Scope): Completion {
    this.hoist(body, scope);
    for (const s of body) {
      const completion = this.statement(s, scope);
      if (completion !== undefined) return completion;
    }
    return undefined;
  }

  private block(block: Block, parent: Scope): Completion {
    return this.statements(block.body, new Scope(parent));
  }

  private statement(s: Statement, scope: Scope): Completion {
    this.enter(s.loc);
    try {
      switch (s.type) {
        case "VarDeclaration": {
          const value = s.init === null ? null : this.expression(s.init, scope);
          const binding = scope.bindings.get(s.id.name);
          if (binding === undefined) scope.bindings.set(s.id.name, { value, initialized: true, constant: s.kind === "const" });
          else {
            binding.value = value;
            binding.initialized = true;
          }
          return undefined;
        }
        case "FunctionDeclaration":
          return undefined;
        case "IfStatement":
          if (this.condition(s.test, scope)) return this.block(s.consequent, scope);
          if (s.alternate === null) return undefined;
          return this.statement(s.alternate, scope);
        case "WhileStatement":
          while (this.condition(s.test, scope)) {
            this.charge(1, s.loc);
            const completion = this.block(s.body, scope);
            if (completion === "break") break;
            if (typeof completion === "object") return completion;
          }
          return undefined;
        case "ForStatement":
          return this.forStatement(s, scope);
        case "ForOfStatement": {
          const iterable = this.expression(s.iterable, scope);
          if (!(iterable instanceof ListValue)) throw new ProgramError(`for…of needs a list, got ${typeName(iterable)}`, s.iterable.loc);
          for (const item of [...iterable.items]) {
            this.charge(1, s.loc);
            const iteration = new Scope(scope);
            iteration.bindings.set(s.id.name, { value: item, initialized: true, constant: s.kind === "const" });
            const completion = this.block(s.body, iteration);
            if (completion === "break") break;
            if (typeof completion === "object") return completion;
          }
          return undefined;
        }
        case "BreakStatement":
          return "break";
        case "ContinueStatement":
          return "continue";
        case "ReturnStatement":
          return { value: s.argument === null ? null : this.expression(s.argument, scope) };
        case "Block":
          return this.block(s, scope);
        case "AssignmentStatement":
          this.assign(s.target, s.operator === "=" ? null : s.operator, s.value, scope, s.loc);
          return undefined;
        case "UpdateStatement":
          this.assign(s.target, s.operator, null, scope, s.loc);
          return undefined;
        case "ExpressionStatement":
          this.expression(s.expression, scope);
          return undefined;
      }
    } finally {
      this.evaluationDepth--;
    }
  }

  /** A `for` loop, with a fresh copy of a `let` loop variable for each iteration, as in JavaScript. */
  private forStatement(s: ForStatement, outer: Scope): Completion {
    let scope = new Scope(outer);
    const loopVar = s.init?.type === "VarDeclaration" ? s.init.id.name : undefined;
    if (s.init !== null) this.statement(s.init, scope);
    const next = (): Scope => {
      const fresh = new Scope(outer);
      const binding = loopVar === undefined ? undefined : scope.bindings.get(loopVar);
      if (loopVar !== undefined && binding !== undefined) fresh.bindings.set(loopVar, { ...binding });
      return fresh;
    };
    scope = next();
    for (;;) {
      if (s.test !== null && !this.condition(s.test, scope)) return undefined;
      this.charge(1, s.loc);
      const completion = this.block(s.body, scope);
      if (completion === "break") return undefined;
      if (typeof completion === "object") return completion;
      scope = next();
      if (s.update !== null) this.statement(s.update, scope);
    }
  }

  private condition(test: Expression, scope: Scope): boolean {
    const value = this.expression(test, scope);
    if (typeof value !== "boolean") throw new ProgramError(`a condition must be a boolean, got ${typeName(value)}`, test.loc);
    return value;
  }

  /** Assignment, compound assignment (`op` set, `value` given) and update (`op` set, no `value`). */
  private assign(target: AssignmentTarget, op: string | null, valueExpr: Expression | null, scope: Scope, loc: Location): void {
    const compute = (read: () => Value): Value => {
      if (op === null) return valueExpr === null ? null : this.expression(valueExpr, scope);
      const old = read();
      const rhs = valueExpr === null ? 1 : this.expression(valueExpr, scope);
      this.charge(1, loc);
      const operator = ARITHMETIC[op] ?? "+";
      if (valueExpr === null && typeof old !== "number") throw new ProgramError(`'${op}' needs a number, got ${typeName(old)}`, loc);
      return this.binary(operator, old, rhs, loc, op);
    };
    if (target.type === "Identifier") {
      const binding = scope.lookup(target.name);
      if (binding === undefined) {
        const builtin = lookup(this.options.language.values, target.name) ?? lookup(this.options.language.functions, target.name);
        throw new ProgramError(builtin === undefined ? `'${target.name}' is not declared` : `'${target.name}' is read-only`, target.loc);
      }
      const value = compute(() => this.expression(target, scope));
      if (binding.constant) throw new ProgramError(`'${target.name}' is a const and cannot be assigned`, target.loc);
      if (!binding.initialized) throw new ProgramError(`'${target.name}' is used before its declaration`, target.loc);
      binding.value = value;
      return;
    }
    const object = this.expression(target.object, scope);
    if (target.type === "MemberExpression") {
      const value = compute(() => this.member(object, target));
      if (!(object instanceof RecordValue)) throw new ProgramError(`cannot assign a field of a ${typeName(object)}`, target.loc);
      this.writable(object, target.loc);
      object.fields.set(target.property.name, value);
      return;
    }
    const index = this.expression(target.index, scope);
    const value = compute(() => this.index(object, index, target.loc));
    if (object instanceof ListValue) {
      const i = this.listIndex(object, index, target.loc);
      this.writable(object, target.loc);
      object.items[i] = value;
    } else if (object instanceof RecordValue) {
      if (typeof index !== "string") throw new ProgramError(`record keys must be strings, got ${typeName(index)}`, target.index.loc);
      this.writable(object, target.loc);
      object.fields.set(index, value);
    } else {
      throw new ProgramError(`cannot assign an element of a ${typeName(object)}`, target.loc);
    }
  }

  private writable(value: ListValue | RecordValue, loc: Location): void {
    if (value.readOnly) throw new ProgramError("this value is read-only: it belongs to self, game or map", loc);
  }

  // ----------------------------------------------------------- expressions

  private expression(e: Expression, scope: Scope): Value {
    this.enter(e.loc);
    try {
      switch (e.type) {
        case "NumberLiteral":
        case "StringLiteral":
        case "BooleanLiteral":
          this.charge(1, e.loc);
          return e.value;
        case "NullLiteral":
          this.charge(1, e.loc);
          return null;
        case "Identifier":
          this.charge(1, e.loc);
          return this.readIdentifier(e.name, e.loc, scope);
        case "ListLiteral": {
          const items = e.elements.map((element) => this.expression(element, scope));
          this.charge(1 + items.length, e.loc);
          this.checkLength(items.length, e.loc);
          return new ListValue(items);
        }
        case "RecordLiteral": {
          const fields = new Map<string, Value>();
          for (const field of e.fields) fields.set(field.key, this.expression(field.value, scope));
          this.charge(1 + e.fields.length, e.loc);
          return new RecordValue(fields);
        }
        case "ArrowFunction":
          this.charge(1, e.loc);
          return new Closure(e, e.params, e.body, scope, false);
        case "UnaryExpression": {
          const operand = this.expression(e.operand, scope);
          this.charge(1, e.loc);
          if (e.operator === "!") {
            if (typeof operand !== "boolean") throw new ProgramError(`'!' needs a boolean, got ${typeName(operand)}`, e.loc);
            return !operand;
          }
          if (typeof operand !== "number") throw new ProgramError(`'-' needs a number, got ${typeName(operand)}`, e.loc);
          return -operand;
        }
        case "BinaryExpression": {
          const left = this.expression(e.left, scope);
          if (e.operator === "&&" || e.operator === "||") {
            this.charge(1, e.loc);
            if (typeof left !== "boolean") throw new ProgramError(`'${e.operator}' needs booleans, got ${typeName(left)}`, e.loc);
            if (left === (e.operator === "||")) return left;
            const right = this.expression(e.right, scope);
            if (typeof right !== "boolean") throw new ProgramError(`'${e.operator}' needs booleans, got ${typeName(right)}`, e.loc);
            return right;
          }
          const right = this.expression(e.right, scope);
          this.charge(1, e.loc);
          return this.binary(e.operator, left, right, e.loc);
        }
        case "ConditionalExpression": {
          const test = this.expression(e.test, scope);
          this.charge(1, e.loc);
          if (typeof test !== "boolean") throw new ProgramError(`'?:' needs a boolean condition, got ${typeName(test)}`, e.loc);
          return this.expression(test ? e.consequent : e.alternate, scope);
        }
        case "MemberExpression":
          return this.member(this.expression(e.object, scope), e);
        case "IndexExpression": {
          const object = this.expression(e.object, scope);
          const index = this.expression(e.index, scope);
          return this.index(object, index, e.loc);
        }
        case "CallExpression":
          return this.call(e, scope);
      }
    } finally {
      this.evaluationDepth--;
    }
  }

  private readIdentifier(name: string, loc: Location, scope: Scope): Value {
    const binding = scope.lookup(name);
    if (binding !== undefined) {
      if (!binding.initialized) throw new ProgramError(`'${name}' is used before its declaration`, loc);
      return binding.value;
    }
    const { language } = this.options;
    if (lookup(language.values, name) !== undefined) return lookup(this.values, name) ?? null;
    if (lookup(language.functions, name) !== undefined) {
      let ref = this.builtinRefs.get(name);
      if (ref === undefined) {
        ref = new BuiltinRef(name);
        this.builtinRefs.set(name, ref);
      }
      return ref;
    }
    throw new ProgramError(`'${name}' is not declared`, loc);
  }

  /** The result of a binary operator, after its node has been charged. */
  private binary(op: BinaryOperator, left: Value, right: Value, loc: Location, shown: string = op): Value {
    switch (op) {
      case "==":
        return equals(left, right);
      case "!=":
        return !equals(left, right);
      case "+":
        if (typeof left === "string" && typeof right === "string") {
          this.checkLength(left.length + right.length, loc);
          return left + right;
        }
        return this.arithmetic(shown, left, right, loc, (a, b) => a + b, "two numbers or two strings");
      case "-":
        return this.arithmetic(shown, left, right, loc, (a, b) => a - b);
      case "*":
        return this.arithmetic(shown, left, right, loc, (a, b) => a * b);
      case "/":
        return this.arithmetic(shown, left, right, loc, (a, b) => a / b);
      case "%":
        return this.arithmetic(shown, left, right, loc, (a, b) => a % b);
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const comparable =
          (typeof left === "number" && typeof right === "number") || (typeof left === "string" && typeof right === "string");
        if (!comparable) {
          throw new ProgramError(`'${op}' needs two numbers or two strings, got ${typeName(left)} and ${typeName(right)}`, loc);
        }
        if (op === "<") return left < right;
        if (op === "<=") return left <= right;
        if (op === ">") return left > right;
        return left >= right;
      }
      case "&&":
      case "||":
        throw new Error("short-circuit operators are evaluated by expression()");
    }
  }

  private arithmetic(
    op: string,
    left: Value,
    right: Value,
    loc: Location,
    f: (a: number, b: number) => number,
    needs = "two numbers",
  ): number {
    if (typeof left !== "number" || typeof right !== "number") {
      throw new ProgramError(`'${op}' needs ${needs}, got ${typeName(left)} and ${typeName(right)}`, loc);
    }
    return this.finite(f(left, right), `'${op}'`, loc);
  }

  private finite(result: number, what: string, loc?: Location): number {
    if (!Number.isFinite(result)) throw new ProgramError(`the result of ${what} is not a finite number`, loc);
    return result;
  }

  private checkLength(length: number, loc?: Location): void {
    const limit = this.options.limits.maxCollectionLength;
    if (length > limit) throw new ProgramError(`the result would have ${String(length)} elements, over the limit of ${String(limit)}`, loc);
  }

  private member(object: Value, e: MemberExpression): Value {
    const name = e.property.name;
    if (object instanceof RecordValue) {
      this.charge(1, e.loc);
      return this.field(object, name, e.property.loc);
    }
    if (object instanceof ListValue || typeof object === "string") {
      if (name === "length") {
        this.charge(this.options.language.lengthCost, e.loc);
        return object instanceof ListValue ? object.items.length : object.length;
      }
      const methods = object instanceof ListValue ? this.options.language.listMethods : this.options.language.stringMethods;
      if (lookup(methods, name) !== undefined) throw new ProgramError(`'.${name}' must be called directly`, e.property.loc);
      throw new ProgramError(`a ${typeName(object)} has no field '${name}'`, e.property.loc);
    }
    throw new ProgramError(`cannot read field '${name}' of ${typeName(object)}`, e.property.loc);
  }

  private field(record: RecordValue, name: string, loc: Location): Value {
    const value = record.fields.get(name);
    if (value === undefined) throw new ProgramError(`the record has no field '${name}'`, loc);
    return value;
  }

  private index(object: Value, index: Value, loc: Location): Value {
    this.charge(1, loc);
    if (object instanceof ListValue) return object.items[this.listIndex(object, index, loc)] ?? null;
    if (object instanceof RecordValue) {
      if (typeof index !== "string") throw new ProgramError(`record keys must be strings, got ${typeName(index)}`, loc);
      return this.field(object, index, loc);
    }
    if (typeof object === "string") throw new ProgramError("strings cannot be indexed: use .slice(i, i + 1)", loc);
    throw new ProgramError(`cannot index a ${typeName(object)}`, loc);
  }

  private listIndex(list: ListValue, index: Value, loc: Location): number {
    if (typeof index !== "number" || !Number.isInteger(index)) {
      throw new ProgramError(`list indices must be integers, got ${typeof index === "number" ? String(index) : typeName(index)}`, loc);
    }
    if (index < 0 || index >= list.items.length) {
      throw new ProgramError(`index ${String(index)} is out of range for a list of length ${String(list.items.length)}`, loc);
    }
    return index;
  }

  // ----------------------------------------------------------------- calls

  private call(e: CallExpression, scope: Scope): Value {
    const { callee } = e;
    if (callee.type === "Identifier") {
      const fn = this.readIdentifier(callee.name, callee.loc, scope);
      return this.callValue(fn, this.args(e, scope), e.loc, true);
    }
    if (callee.type === "MemberExpression") {
      const object = this.expression(callee.object, scope);
      const name = callee.property.name;
      const { language } = this.options;
      if (object instanceof ListValue && lookup(language.listMethods, name) !== undefined) {
        return this.listMethod(object, name, this.args(e, scope), e.loc);
      }
      if (typeof object === "string" && lookup(language.stringMethods, name) !== undefined) {
        return this.stringMethod(object, name, this.args(e, scope), e.loc);
      }
      const fn = this.member(object, callee);
      return this.callValue(fn, this.args(e, scope), e.loc, true);
    }
    const fn = this.expression(callee, scope);
    return this.callValue(fn, this.args(e, scope), e.loc, true);
  }

  private args(e: CallExpression, scope: Scope): Value[] {
    return e.args.map((arg) => this.expression(arg, scope));
  }

  /** Calls a function value; `callNode` charges a user function's call, as when written in source. */
  private callValue(fn: Value, args: readonly Value[], loc: Location, callNode: boolean): Value {
    if (fn instanceof BuiltinRef) return this.builtin(fn.name, args, loc);
    if (!(fn instanceof Closure)) throw new ProgramError(`cannot call a ${typeName(fn)}`, loc);
    if (callNode) this.charge(1, loc);
    const { maxCallDepth } = this.options.limits;
    if (this.depth >= maxCallDepth) throw new ProgramError(`more than ${String(maxCallDepth)} nested calls`, loc);
    if (args.length < fn.params.length) {
      throw new ProgramError(`the function takes ${String(fn.params.length)} arguments but is given ${String(args.length)}`, loc);
    }
    const scope = new Scope(fn.scope);
    fn.params.forEach((param, i) => {
      scope.bindings.set(param.name, { value: args[i] ?? null, initialized: true, constant: false });
    });
    this.depth++;
    this.lastCall = loc;
    try {
      if (fn.body.type !== "Block") return this.expression(fn.body, scope);
      const completion = this.statements(fn.body.body, scope);
      return typeof completion === "object" ? completion.value : null;
    } finally {
      this.depth--;
    }
  }

  /** Calls a callback from a built-in, requiring a boolean result if `predicate` is set. */
  private callback(fn: Value, args: readonly Value[], loc: Location, method: string, predicate = false): Value {
    if (!(fn instanceof Closure) && !(fn instanceof BuiltinRef)) {
      throw new ProgramError(`'.${method}' needs a function, got ${typeName(fn)}`, loc);
    }
    // Like JavaScript, a callback may ignore trailing arguments; a built-in is given only as many as it takes.
    const maxArgs = fn instanceof BuiltinRef ? lookup(this.options.language.functions, fn.name)?.maxArgs : undefined;
    const result = this.callValue(fn, maxArgs === undefined ? args : args.slice(0, maxArgs), loc, false);
    if (predicate && typeof result !== "boolean") {
      throw new ProgramError(`the function given to '.${method}' must return a boolean, got ${typeName(result)}`, loc);
    }
    return result;
  }

  /** Runs `body`, giving any located-less ProgramError it throws the call's location. */
  private at<T>(loc: Location, body: () => T): T {
    try {
      return body();
    } catch (e) {
      if (e instanceof ProgramError && e.loc === undefined) throw new ProgramError(e.message, loc);
      throw e;
    }
  }

  private arity(name: string, min: number, max: number, given: number, loc: Location): void {
    if (given < min || given > max) {
      const expected = min === max ? String(min) : `${String(min)} to ${String(max)}`;
      throw new ProgramError(`'${name}' takes ${expected} arguments but is given ${String(given)}`, loc);
    }
  }

  private builtin(name: string, args: readonly Value[], loc: Location): Value {
    const definition = lookup(this.options.language.functions, name);
    if (definition === undefined) throw new ProgramError(`'${name}' is not a built-in`, loc);
    this.arity(name, definition.minArgs, definition.maxArgs, args.length, loc);
    if (this.phase === "init" && !definition.initPhase) throw new ProgramError(`'${name}' cannot be called during the init phase`, loc);
    this.charge(definition.cost, loc);
    return this.at(loc, () => {
      if (INTRINSICS.has(name)) return this.intrinsic(name, args);
      const host = lookup(this.options.host, name);
      if (host === undefined) throw new Error(`no host implementation for built-in '${name}'`);
      return host(args);
    });
  }

  private intrinsic(name: string, args: readonly Value[]): Value {
    const num = (i: number): number => {
      const value = args[i] ?? null;
      if (typeof value !== "number") throw new ProgramError(`'${name}' needs a number as argument ${String(i + 1)}, got ${typeName(value)}`);
      return value;
    };
    const record = (): RecordValue => {
      const value = args[0] ?? null;
      if (!(value instanceof RecordValue)) throw new ProgramError(`'${name}' needs a record, got ${typeName(value)}`);
      return value;
    };
    const key = (): string => {
      const value = args[1] ?? null;
      if (typeof value !== "string") throw new ProgramError(`'${name}' needs a string key, got ${typeName(value)}`);
      return value;
    };
    const { limits } = this.options;
    switch (name) {
      case "abs":
        return Math.abs(num(0));
      case "min":
        return Math.min(num(0), num(1));
      case "max":
        return Math.max(num(0), num(1));
      case "clamp":
        return Math.min(Math.max(num(0), num(1)), num(2));
      case "floor":
        return Math.floor(num(0));
      case "ceil":
        return Math.ceil(num(0));
      case "round":
        return Math.round(num(0));
      case "sqrt":
        return this.finite(Math.sqrt(num(0)), "sqrt");
      case "keys": {
        const fields = [...record().fields.keys()];
        this.checkLength(fields.length);
        return new ListValue(fields);
      }
      case "has":
        return record().fields.has(key());
      case "remove": {
        const r = record();
        const k = key();
        if (r.readOnly) throw new ProgramError("this value is read-only: it belongs to self, game or map");
        return r.fields.delete(k);
      }
      case "str":
        return str(args[0] ?? null, limits.maxCollectionLength);
      case "log": {
        const text = str(args[0] ?? null, limits.maxCollectionLength);
        if (this.logLines.length < limits.logLinesPerTick) this.logLines.push(text.slice(0, limits.logLineLength));
        else this.logTruncated = true;
        return null;
      }
      case "budgetRemaining":
        return this.remaining;
      default:
        throw new Error(`'${name}' is not an intrinsic`);
    }
  }

  private listMethod(list: ListValue, name: string, args: readonly Value[], loc: Location): Value {
    const definition = lookup(this.options.language.listMethods, name);
    if (definition === undefined) throw new ProgramError(`a list has no method '${name}'`, loc);
    this.arity(`.${name}`, definition.minArgs, definition.maxArgs, args.length, loc);
    if (definition.mutates === true) this.writable(list, loc);
    this.charge(definition.cost, loc);
    const { limits } = this.options;
    const items = list.items;
    const arg = (i: number): Value => args[i] ?? null;
    const num = (i: number): number => {
      const value = arg(i);
      if (typeof value !== "number") throw new ProgramError(`'.${name}' needs a number, got ${typeName(value)}`, loc);
      return value;
    };
    const each = (predicate: boolean, visit: (result: Value, item: Value) => boolean): void => {
      const snapshot = [...items];
      for (let i = 0; i < snapshot.length; i++) {
        const item = snapshot[i] ?? null;
        if (!visit(this.callback(arg(0), [item, i], loc, name, predicate), item)) return;
      }
    };
    switch (name) {
      case "push":
        this.checkLength(items.length + 1, loc);
        items.push(arg(0));
        return items.length;
      case "pop": {
        if (items.length === 0) throw new ProgramError("cannot .pop() an empty list", loc);
        return items.pop() ?? null;
      }
      case "slice":
        return new ListValue(items.slice(num(0), args.length > 1 ? num(1) : undefined));
      case "indexOf":
        return items.findIndex((x) => equals(x, arg(0)));
      case "includes":
        return items.some((x) => equals(x, arg(0)));
      case "join": {
        const sep = arg(0);
        if (typeof sep !== "string") throw new ProgramError(`'.join' needs a string separator, got ${typeName(sep)}`, loc);
        let out = "";
        items.forEach((x, i) => {
          out += (i > 0 ? sep : "") + this.at(loc, () => str(x, limits.maxCollectionLength));
          this.checkLength(out.length, loc);
        });
        return out;
      }
      case "map": {
        const results: Value[] = [];
        each(false, (result) => {
          results.push(result);
          return true;
        });
        return new ListValue(results);
      }
      case "filter": {
        const results: Value[] = [];
        each(true, (result, item) => {
          if (result === true) results.push(item);
          return true;
        });
        return new ListValue(results);
      }
      case "find": {
        let found: Value = null;
        each(true, (result, item) => {
          if (result === true) found = item;
          return result !== true;
        });
        return found;
      }
      case "some": {
        let any = false;
        each(true, (result) => {
          any = result === true;
          return !any;
        });
        return any;
      }
      case "every": {
        let all = true;
        each(true, (result) => {
          all = result === true;
          return all;
        });
        return all;
      }
      case "reduce": {
        let acc = arg(1);
        [...items].forEach((item, i) => {
          acc = this.callback(arg(0), [acc, item, i], loc, name);
        });
        return acc;
      }
      case "sort": {
        const cmp = arg(0);
        const compare = (a: Value, b: Value): number => {
          const result = this.callback(cmp, [a, b], loc, name);
          if (typeof result !== "number") throw new ProgramError(`the function given to '.sort' must return a number, got ${typeName(result)}`, loc);
          return result;
        };
        const sorted = mergeSort([...items], compare);
        items.splice(0, items.length, ...sorted);
        return list;
      }
      default:
        throw new Error(`'.${name}' is not a list method`);
    }
  }

  private stringMethod(s: string, name: string, args: readonly Value[], loc: Location): Value {
    const definition = lookup(this.options.language.stringMethods, name);
    if (definition === undefined) throw new ProgramError(`a string has no method '${name}'`, loc);
    this.arity(`.${name}`, definition.minArgs, definition.maxArgs, args.length, loc);
    this.charge(definition.cost, loc);
    const arg = (i: number, type: "number" | "string"): Value => {
      const value = args[i] ?? null;
      if (typeof value !== type) throw new ProgramError(`'.${name}' needs a ${type}, got ${typeName(value)}`, loc);
      return value;
    };
    switch (name) {
      case "slice":
        return s.slice(arg(0, "number") as number, args.length > 1 ? (arg(1, "number") as number) : undefined);
      case "indexOf":
        return s.indexOf(arg(0, "string") as string);
      case "includes":
        return s.includes(arg(0, "string") as string);
      default:
        throw new Error(`'.${name}' is not a string method`);
    }
  }

  // ---------------------------------------------------------------- memory

  /** The cells used by everything reachable from top-level variables (section 9). */
  private measureMemory(): number {
    let cells = 0;
    const seen = new Set<object>();
    const seenBindings = new Set<Binding>();
    const stack: Value[] = [];
    for (const binding of this.global.bindings.values()) {
      if (binding.initialized) stack.push(binding.value);
    }
    while (stack.length > 0) {
      const value = stack.pop() ?? null;
      if (typeof value === "string") {
        cells += 1 + Math.ceil(value.length / 8);
        continue;
      }
      if (value === null || typeof value !== "object") {
        cells += 1;
        continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      if (value instanceof ListValue) {
        cells += 1;
        stack.push(...value.items);
      } else if (value instanceof RecordValue) {
        cells += 1 + value.fields.size;
        stack.push(...value.fields.values());
      } else if (value instanceof Closure) {
        if (value.topLevel) continue;
        const captured = this.captured(value);
        cells += 1 + captured.length;
        for (const binding of captured) {
          if (seenBindings.has(binding)) continue;
          seenBindings.add(binding);
          if (binding.initialized) stack.push(binding.value);
        }
      } else {
        cells += 1;
      }
    }
    return cells;
  }

  /** The non-global variables a closure captures. */
  private captured(closure: Closure): Binding[] {
    const bindings: Binding[] = [];
    for (const name of freeNames(closure.node)) {
      for (let s: Scope | null = closure.scope; s !== null && s !== this.global; s = s.parent) {
        const binding = s.bindings.get(name);
        if (binding !== undefined) {
          bindings.push(binding);
          break;
        }
      }
    }
    return bindings;
  }
}

/** The pinned `.sort` algorithm: top-down merge sort, split at ⌊n/2⌋, left wins ties. */
function mergeSort(items: Value[], compare: (a: Value, b: Value) => number): Value[] {
  if (items.length <= 1) return items;
  const middle = Math.floor(items.length / 2);
  const left = mergeSort(items.slice(0, middle), compare);
  const right = mergeSort(items.slice(middle), compare);
  const out: Value[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i] ?? null;
    const b = right[j] ?? null;
    if (compare(a, b) <= 0) {
      out.push(a);
      i++;
    } else {
      out.push(b);
      j++;
    }
  }
  return out.concat(left.slice(i), right.slice(j));
}
