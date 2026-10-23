/**
 * Save-time checks for a Program (language-r1 section 10.1).
 *
 * `check` parses the source and, if it is syntactically valid, resolves every
 * name against the Program's scopes and its Ruleset's language definition. It
 * reports every error it finds, in source order. Semantic checks run only on
 * a Program without syntax errors, since a statement dropped by the parser
 * would otherwise cause spurious "not declared" errors.
 */

import type {
  ArrowFunction,
  AssignmentTarget,
  Block,
  CallExpression,
  Expression,
  FunctionDeclaration,
  Identifier,
  Location,
  MemberExpression,
  Program,
  Statement,
} from "./ast.js";
import { lookup, type BuiltinFunction, type LanguageDefinition, type ValueType } from "./definition.js";
import type { Diagnostic } from "./lexer.js";
import { compareLocations, parse } from "./parser.js";

/** The Slot ids of a Build, by what is installed in them. */
export interface ProgramSlots {
  readonly weapons: readonly string[];
  readonly rangefinders: readonly string[];
}

export interface CheckOptions {
  readonly language: LanguageDefinition;
  /** The Ruleset's `maxSourceBytes` limit. */
  readonly maxSourceBytes: number;
  /**
   * The Build the Program is saved with. When given, Slot ids written as
   * string literals in `fire`, `fireAbs` and `rangefind` must name a weapon
   * or rangefinder that the Build has installed.
   */
  readonly slots?: ProgramSlots;
}

export type CheckResult =
  | { readonly ok: true; readonly program: Program }
  | { readonly ok: false; readonly errors: readonly Diagnostic[] };

interface VariableBinding {
  readonly kind: "let" | "const" | "param";
  readonly scope: Scope;
  initialized: boolean;
}

type Binding = VariableBinding | { readonly kind: "function"; readonly scope: Scope; readonly decl: FunctionDeclaration };

interface Scope {
  readonly parent: Scope | null;
  readonly names: Map<string, Binding>;
  /** How many functions enclose this scope; 0 at the top level. */
  readonly functionDepth: number;
}

type Resolved =
  | Binding
  | { readonly kind: "builtinFunction"; readonly name: string; readonly builtin: BuiltinFunction }
  | { readonly kind: "builtinValue"; readonly name: string; readonly valueType: ValueType };

/** A statically known built-in value: its type and how the Program reached it. */
interface Known {
  readonly type: ValueType;
  readonly path: string;
}

/** The calls made by one function body, or by the top-level initializers. */
interface CallSite {
  readonly name: string;
  readonly functions: FunctionDeclaration[];
  readonly builtins: { readonly name: string; readonly builtin: BuiltinFunction; readonly loc: Location }[];
}

function arityText(min: number, max: number): string {
  const count = (n: number): string => `${String(n)} argument${n === 1 ? "" : "s"}`;
  if (max === 0) return "no arguments";
  return min === max ? count(min) : `${String(min)} to ${count(max)}`;
}

function describeType(type: ValueType): string {
  if (typeof type === "string") return `a ${type}`;
  if ("list" in type) return "a list";
  return "a record";
}

class Checker {
  readonly errors: Diagnostic[] = [];
  private scope: Scope;
  private loopDepth = 0;
  private site: CallSite;
  readonly initializers: CallSite = { name: "a top-level initializer", functions: [], builtins: [] };
  readonly sites = new Map<FunctionDeclaration, CallSite>();

  constructor(private readonly options: CheckOptions) {
    this.scope = { parent: null, names: new Map(), functionDepth: 0 };
    this.site = this.initializers;
  }

  private error(loc: Location, message: string): void {
    this.errors.push({ line: loc.line, column: loc.column, message });
  }

  private builtinKind(name: string): "function" | "value" | undefined {
    const { language } = this.options;
    if (lookup(language.functions, name) !== undefined) return "function";
    if (lookup(language.values, name) !== undefined) return "value";
    return undefined;
  }

  private declare(id: Identifier, binding: Binding): void {
    const builtin = this.builtinKind(id.name);
    if (builtin !== undefined) {
      this.error(id.loc, `'${id.name}' is a built-in ${builtin} and cannot be declared again`);
    } else if (binding.scope.names.has(id.name)) {
      this.error(id.loc, `'${id.name}' is already declared in this scope`);
      return;
    }
    binding.scope.names.set(id.name, binding);
  }

  private resolve(name: string): Resolved | undefined {
    for (let s: Scope | null = this.scope; s !== null; s = s.parent) {
      const binding = s.names.get(name);
      if (binding !== undefined) return binding;
    }
    const { language } = this.options;
    const builtin = lookup(language.functions, name);
    if (builtin !== undefined) return { kind: "builtinFunction", name, builtin };
    const valueType = lookup(language.values, name);
    if (valueType !== undefined) return { kind: "builtinValue", name, valueType };
    return undefined;
  }

  /** Resolves a name being read or written, reporting what is statically wrong with it. */
  private reference(id: Identifier): Resolved | undefined {
    const resolved = this.resolve(id.name);
    if (resolved === undefined) {
      this.error(id.loc, `'${id.name}' is not declared`);
      return undefined;
    }
    if (
      (resolved.kind === "let" || resolved.kind === "const") &&
      !resolved.initialized &&
      resolved.scope.functionDepth === this.scope.functionDepth
    ) {
      this.error(id.loc, `'${id.name}' is used before its declaration`);
    }
    return resolved;
  }

  private withScope(functionDepth: number, body: () => void): void {
    const outer = this.scope;
    this.scope = { parent: outer, names: new Map(), functionDepth };
    try {
      body();
    } finally {
      this.scope = outer;
    }
  }

  checkProgram(program: Program): void {
    this.statements(program.body);
    this.entryPoints(program);
    this.initPhase();
  }

  /** Declares a block's names (functions hoisted, let/const not yet initialized), then checks its statements. */
  private statements(body: readonly Statement[]): void {
    for (const statement of body) {
      if (statement.type === "FunctionDeclaration") {
        this.declare(statement.id, { kind: "function", scope: this.scope, decl: statement });
        this.sites.set(statement, { name: statement.id.name, functions: [], builtins: [] });
      } else if (statement.type === "VarDeclaration") {
        this.declare(statement.id, { kind: statement.kind, scope: this.scope, initialized: false });
      }
    }
    for (const statement of body) this.statement(statement);
  }

  private block(block: Block): void {
    this.withScope(this.scope.functionDepth, () => {
      this.statements(block.body);
    });
  }

  private loopBody(block: Block): void {
    this.loopDepth++;
    this.block(block);
    this.loopDepth--;
  }

  private statement(statement: Statement): void {
    switch (statement.type) {
      case "VarDeclaration": {
        if (statement.init !== null) this.expression(statement.init);
        const binding = this.scope.names.get(statement.id.name);
        if (binding !== undefined && binding.kind !== "function") binding.initialized = true;
        return;
      }
      case "FunctionDeclaration": {
        const site = this.sites.get(statement);
        if (site !== undefined) this.func(statement.params, statement.body, site);
        return;
      }
      case "IfStatement":
        this.expression(statement.test);
        this.block(statement.consequent);
        if (statement.alternate !== null) this.statement(statement.alternate);
        return;
      case "WhileStatement":
        this.expression(statement.test);
        this.loopBody(statement.body);
        return;
      case "ForStatement":
        this.withScope(this.scope.functionDepth, () => {
          if (statement.init?.type === "VarDeclaration") {
            const binding: VariableBinding = { kind: "let", scope: this.scope, initialized: false };
            this.declare(statement.init.id, binding);
            if (statement.init.init !== null) this.expression(statement.init.init);
            binding.initialized = true;
          } else if (statement.init !== null) {
            this.statement(statement.init);
          }
          if (statement.test !== null) this.expression(statement.test);
          if (statement.update !== null) this.statement(statement.update);
          this.loopBody(statement.body);
        });
        return;
      case "ForOfStatement":
        this.expression(statement.iterable);
        this.withScope(this.scope.functionDepth, () => {
          this.declare(statement.id, { kind: statement.kind, scope: this.scope, initialized: true });
          this.loopBody(statement.body);
        });
        return;
      case "BreakStatement":
      case "ContinueStatement":
        if (this.loopDepth === 0) {
          this.error(statement.loc, `'${statement.type === "BreakStatement" ? "break" : "continue"}' is only allowed inside a loop`);
        }
        return;
      case "ReturnStatement":
        if (this.scope.functionDepth === 0) this.error(statement.loc, "'return' is only allowed inside a function");
        if (statement.argument !== null) this.expression(statement.argument);
        return;
      case "Block":
        this.block(statement);
        return;
      case "AssignmentStatement":
        this.target(statement.target);
        this.expression(statement.value);
        return;
      case "UpdateStatement":
        this.target(statement.target);
        return;
      case "ExpressionStatement":
        this.expression(statement.expression);
        return;
    }
  }

  /** Checks a function or arrow body in its own scope, recording its calls in `site`. */
  private func(params: readonly Identifier[], body: Block | Expression, site: CallSite): void {
    const outerSite = this.site;
    const outerLoops = this.loopDepth;
    this.site = site;
    this.loopDepth = 0;
    this.withScope(this.scope.functionDepth + 1, () => {
      for (const param of params) this.declare(param, { kind: "param", scope: this.scope, initialized: true });
      if (body.type === "Block") this.statements(body.body);
      else this.expression(body);
    });
    this.site = outerSite;
    this.loopDepth = outerLoops;
  }

  /** The identifier an access chain such as `a.b[0].c` starts from. */
  private root(expression: Expression): Identifier | undefined {
    let e = expression;
    while (e.type === "MemberExpression" || e.type === "IndexExpression" || e.type === "CallExpression") {
      e = e.type === "CallExpression" ? e.callee : e.object;
    }
    return e.type === "Identifier" ? e : undefined;
  }

  /** The built-in value an expression's access chain starts from, if any. */
  private readOnlyRoot(expression: Expression): string | undefined {
    const root = this.root(expression);
    if (root === undefined) return undefined;
    const resolved = this.resolve(root.name);
    return resolved?.kind === "builtinValue" ? resolved.name : undefined;
  }

  private target(target: AssignmentTarget): void {
    if (target.type === "Identifier") {
      const resolved = this.reference(target);
      if (resolved === undefined) return;
      if (resolved.kind === "const") this.error(target.loc, `'${target.name}' is a const and cannot be assigned`);
      else if (resolved.kind === "builtinFunction") this.error(target.loc, `'${target.name}' is a built-in and cannot be assigned`);
      else if (resolved.kind === "builtinValue") this.error(target.loc, `'${target.name}' is read-only`);
      return;
    }
    this.expression(target.object);
    if (target.type === "IndexExpression") this.expression(target.index);
    const readOnly = this.readOnlyRoot(target);
    if (readOnly !== undefined) this.error(target.loc, `'${readOnly}' and everything reachable from it are read-only`);
  }

  /** The type of field `name` of a known value, reporting a field the Ruleset does not define. */
  private member(known: Known | undefined, name: string, loc: Location): Known | undefined {
    if (known === undefined) return undefined;
    const { type, path } = known;
    if (type === "any") return undefined;
    if (type === "string" || (typeof type !== "string" && "list" in type)) {
      if (name === "length") return { type: "number", path: `${path}.length` };
      const { language } = this.options;
      if (lookup(type === "string" ? language.stringMethods : language.listMethods, name) !== undefined) return undefined;
      this.error(loc, `${path} is ${describeType(type)} and has no field '${name}'`);
      return undefined;
    }
    if (typeof type === "string") {
      this.error(loc, `${path} is ${describeType(type)} and has no fields`);
      return undefined;
    }
    if ("map" in type) return { type: type.map, path: `${path}.${name}` };
    const field = lookup(type.record, name);
    if (field === undefined) {
      this.error(loc, `${path} has no field '${name}'`);
      return undefined;
    }
    return { type: field, path: `${path}.${name}` };
  }

  private expression(expression: Expression, inlineCallback = false): Known | undefined {
    switch (expression.type) {
      case "NumberLiteral":
      case "StringLiteral":
      case "BooleanLiteral":
      case "NullLiteral":
        return undefined;
      case "Identifier": {
        const resolved = this.reference(expression);
        if (resolved?.kind === "builtinValue") return { type: resolved.valueType, path: resolved.name };
        return undefined;
      }
      case "ListLiteral":
        for (const element of expression.elements) this.expression(element);
        return undefined;
      case "RecordLiteral":
        for (const field of expression.fields) this.expression(field.value);
        return undefined;
      case "ArrowFunction":
        this.arrow(expression, inlineCallback);
        return undefined;
      case "UnaryExpression":
        this.expression(expression.operand);
        return undefined;
      case "BinaryExpression":
        this.expression(expression.left);
        this.expression(expression.right);
        return undefined;
      case "ConditionalExpression":
        this.expression(expression.test);
        this.expression(expression.consequent);
        this.expression(expression.alternate);
        return undefined;
      case "MemberExpression":
        return this.member(this.expression(expression.object), expression.property.name, expression.property.loc);
      case "IndexExpression": {
        const known = this.expression(expression.object);
        this.expression(expression.index);
        if (known === undefined || typeof known.type === "string") return undefined;
        if ("list" in known.type) return { type: known.type.list, path: `${known.path}[]` };
        if (expression.index.type === "StringLiteral") return this.member(known, expression.index.value, expression.index.loc);
        return undefined;
      }
      case "CallExpression":
        return this.call(expression);
    }
  }

  /** An arrow passed straight to a call is treated as run by that call, for init-phase reachability. */
  private arrow(arrow: ArrowFunction, inlineCallback: boolean): void {
    const site = inlineCallback ? this.site : { name: "an arrow function", functions: [], builtins: [] };
    this.func(arrow.params, arrow.body, site);
  }

  private arity(name: string, min: number, max: number, given: number, loc: Location): void {
    if (given < min || given > max) {
      this.error(loc, `'${name}' takes ${arityText(min, max)} but is given ${String(given)}`);
    }
  }

  private call(call: CallExpression): Known | undefined {
    const { callee, args } = call;
    let result: Known | undefined;
    if (callee.type === "Identifier") {
      const resolved = this.reference(callee);
      if (resolved?.kind === "builtinFunction") this.builtinCall(resolved.name, resolved.builtin, call);
      else if (resolved?.kind === "function") this.site.functions.push(resolved.decl);
    } else if (callee.type === "MemberExpression") {
      result = this.methodCall(callee, args.length);
    } else {
      this.expression(callee);
    }
    for (const arg of args) this.expression(arg, true);
    return result;
  }

  private builtinCall(name: string, builtin: BuiltinFunction, call: CallExpression): void {
    const { callee, args } = call;
    this.arity(name, builtin.minArgs, builtin.maxArgs, args.length, callee.loc);
    this.site.builtins.push({ name, builtin, loc: callee.loc });
    const first = args[0];
    if (first === undefined) return;
    if (builtin.mutatesFirstArgument === true) {
      const readOnly = this.readOnlyRoot(first);
      if (readOnly !== undefined) this.error(first.loc, `'${name}' cannot change '${readOnly}', which is read-only`);
    }
    const { slots } = this.options;
    if (builtin.slotArgument !== undefined && slots !== undefined && first.type === "StringLiteral") {
      const [ids, noun] = builtin.slotArgument === "weapon" ? [slots.weapons, "weapon"] : [slots.rangefinders, "rangefinder"];
      if (!ids.includes(first.value)) {
        const installed = ids.length === 0 ? `this Build has no ${noun}s` : `its ${noun}s are in ${ids.map((id) => `'${id}'`).join(", ")}`;
        this.error(first.loc, `the Build has no ${noun} in Slot '${first.value}': ${installed}`);
      }
    }
  }

  private methodCall(callee: MemberExpression, given: number): Known | undefined {
    const known = this.expression(callee.object);
    const name = callee.property.name;
    const type = known?.type;
    const isList = typeof type === "object" && "list" in type;
    if (known === undefined || (type !== "string" && !isList)) return this.member(known, name, callee.property.loc);
    const { language } = this.options;
    const method = lookup(isList ? language.listMethods : language.stringMethods, name);
    if (method === undefined) {
      this.error(callee.property.loc, `${known.path} is ${describeType(known.type)} and has no method '${name}'`);
      return undefined;
    }
    this.arity(`.${name}`, method.minArgs, method.maxArgs, given, callee.property.loc);
    if (method.mutates === true) {
      const readOnly = this.readOnlyRoot(callee.object);
      if (readOnly !== undefined) this.error(callee.property.loc, `'.${name}' cannot change '${readOnly}', which is read-only`);
    }
    if (typeof known.type !== "string" && "list" in known.type) {
      if (name === "slice" || name === "filter" || name === "sort") return known;
      if (name === "find" || name === "pop") return { type: known.type.list, path: `${known.path}[]` };
    }
    return undefined;
  }

  private entryPoints(program: Program): void {
    let hasTick = false;
    for (const decl of program.body) {
      const { name, loc } = decl.id;
      if (name !== "tick" && name !== "init") continue;
      if (name === "tick") hasTick = true;
      if (decl.type !== "FunctionDeclaration") this.error(loc, `'${name}' must be declared as a function`);
      else if (decl.params.length > 0) this.error(loc, `${name}() cannot take parameters`);
    }
    if (!hasTick) this.error({ line: 1, column: 1 }, "the Program must declare function tick()");
  }

  /** Reports built-ins the init phase may not call that it reaches through statically resolved calls. */
  private initPhase(): void {
    const roots: CallSite[] = [this.initializers];
    const init = this.scope.names.get("init");
    if (init?.kind === "function") {
      const site = this.sites.get(init.decl);
      if (site !== undefined) roots.push(site);
    }
    const via = new Map<CallSite, CallSite | undefined>(roots.map((r) => [r, undefined]));
    const queue = [...roots];
    for (let site = queue.shift(); site !== undefined; site = queue.shift()) {
      for (const decl of site.functions) {
        const next = this.sites.get(decl);
        if (next !== undefined && !via.has(next)) {
          via.set(next, site);
          queue.push(next);
        }
      }
      for (const { name, builtin, loc } of site.builtins) {
        if (builtin.initPhase) continue;
        const chain = [name];
        for (let s: CallSite | undefined = site; s !== undefined; s = via.get(s)) chain.unshift(s.name);
        this.error(loc, `'${name}' cannot be called during the init phase (${chain.join(" → ")})`);
      }
    }
  }
}

function utf8Bytes(source: string): number {
  return new TextEncoder().encode(source).length;
}

/** Checks a Program's source against its Ruleset's language, as when a Revision is saved. */
export function check(source: string, options: CheckOptions): CheckResult {
  const bytes = utf8Bytes(source);
  if (bytes > options.maxSourceBytes) {
    return {
      ok: false,
      errors: [{ line: 1, column: 1, message: `the Program is ${String(bytes)} bytes, over the ${String(options.maxSourceBytes)}-byte limit` }],
    };
  }
  const parsed = parse(source);
  if (parsed.errors.length > 0) return { ok: false, errors: parsed.errors };
  const checker = new Checker(options);
  checker.checkProgram(parsed.program);
  if (checker.errors.length === 0) return { ok: true, program: parsed.program };
  const seen = new Set<string>();
  const errors = [...checker.errors].sort(compareLocations).filter((e) => {
    const key = `${String(e.line)}:${String(e.column)}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ok: false, errors };
}
