/**
 * Runtime values of the Positron Tanks language (language-r1 section 4.1).
 *
 * Numbers, strings, booleans and null are JavaScript primitives. Lists and
 * records are wrapper objects so that they can be marked read-only (section
 * 4.5) and so that record fields keep insertion order even for integer-like
 * keys (section 12). Functions are closures or references to built-ins.
 */

import type { ArrowFunction, Block, Expression, FunctionDeclaration, Identifier } from "./ast.js";

export type Value = number | string | boolean | null | ListValue | RecordValue | FunctionValue;

export class ListValue {
  constructor(
    readonly items: Value[],
    /** True for `self`, `game`, `map` and everything reachable from them. */
    readonly readOnly = false,
  ) {}
}

export class RecordValue {
  constructor(
    readonly fields: Map<string, Value>,
    readonly readOnly = false,
  ) {}
}

/** A variable in a scope. `initialized` is false until a let/const declaration has run. */
export interface Binding {
  value: Value;
  initialized: boolean;
  readonly constant: boolean;
}

export class Scope {
  readonly bindings = new Map<string, Binding>();
  constructor(readonly parent: Scope | null) {}

  lookup(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }
}

/** A user function: a `function` declaration or an arrow function, with the scope it closes over. */
export class Closure {
  constructor(
    readonly node: FunctionDeclaration | ArrowFunction,
    readonly params: readonly Identifier[],
    readonly body: Block | Expression,
    readonly scope: Scope,
    /** Declared at the top level: code, not state, so it costs no memory (section 9). */
    readonly topLevel: boolean,
  ) {}
}

/** A built-in function used as a value, such as `xs.map(str)`. */
export class BuiltinRef {
  constructor(readonly name: string) {}
}

export type FunctionValue = Closure | BuiltinRef;

/**
 * A runtime error raised by the interpreter or by a host function. Host
 * functions throw it without a location; the interpreter adds the call's.
 */
export class ProgramError extends Error {
  constructor(
    message: string,
    readonly loc?: { readonly line: number; readonly column: number },
  ) {
    super(message);
    this.name = "ProgramError";
  }
}

export type TypeName = "number" | "string" | "boolean" | "null" | "list" | "record" | "function";

export function typeName(value: Value): TypeName {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    default:
      if (value instanceof ListValue) return "list";
      if (value instanceof RecordValue) return "record";
      return "function";
  }
}

/** `==` (section 4.2): primitives by value, everything else by identity. Never errors. */
export function equals(a: Value, b: Value): boolean {
  return a === b;
}

/** Plain data a host can turn into a read-only value with `fromHost`. */
export type HostData = number | string | boolean | null | readonly HostData[] | { readonly [key: string]: HostData };

/**
 * Converts host data (such as `self` or a `scan()` contact) into a read-only
 * value. Record fields take the object's key order, so hosts must not use
 * integer-like keys, which JavaScript objects reorder.
 */
export function fromHost(data: HostData): Value {
  if (data === null || typeof data === "string" || typeof data === "boolean") return data;
  if (typeof data === "number") {
    if (!Number.isFinite(data)) throw new Error(`host value ${String(data)} is not a finite number`);
    return data;
  }
  if (Array.isArray(data)) return new ListValue(data.map(fromHost), true);
  const record = data as { readonly [key: string]: HostData };
  return new RecordValue(new Map(Object.keys(record).map((k) => [k, fromHost(record[k] ?? null)])), true);
}

/** Thrown by `str` when its result would be longer than `maxCollectionLength`. */
function tooLong(limit: number): ProgramError {
  return new ProgramError(`the string would be longer than ${String(limit)} characters`);
}

/**
 * `str(x)` (section 7.5): numbers as `Number.prototype.toString`, lists and
 * records JSON-style. Iterative, with the length checked as it grows, so deep
 * or self-containing values cannot overflow the host stack.
 */
export function str(value: Value, limit: number): string {
  if (typeof value === "string") return value;
  let out = "";
  const work: (Value | { readonly text: string })[] = [value];
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    let text: string;
    if (item instanceof ListValue) {
      text = "[";
      work.push({ text: "]" });
      for (let i = item.items.length - 1; i >= 0; i--) {
        work.push(item.items[i] ?? null);
        if (i > 0) work.push({ text: "," });
      }
    } else if (item instanceof RecordValue) {
      text = "{";
      work.push({ text: "}" });
      const entries = [...item.fields];
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, field] = entries[i] ?? ["", null];
        work.push(field, { text: `${JSON.stringify(key)}:` });
        if (i > 0) work.push({ text: "," });
      }
    } else if (item !== null && typeof item === "object" && "text" in item) {
      text = item.text;
    } else if (typeof item === "string") {
      text = JSON.stringify(item);
    } else if (item instanceof Closure || item instanceof BuiltinRef) {
      text = "<function>";
    } else {
      text = String(item);
    }
    out += text;
    if (out.length > limit) throw tooLong(limit);
  }
  return out;
}
