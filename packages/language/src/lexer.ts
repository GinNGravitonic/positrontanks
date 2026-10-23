/**
 * Tokenizer for Aumohta source (language-r1 section 2).
 *
 * The lexer never stops at the first problem: it records a Diagnostic and
 * produces the most plausible token so parsing can carry on. A reserved word
 * becomes an identifier, `===` becomes `==`, and a string with a bad escape
 * keeps its other characters.
 */

import type { Location } from "./ast.js";

export interface Diagnostic extends Location {
  readonly message: string;
}

export type TokenKind = "number" | "string" | "identifier" | "keyword" | "punct" | "eof";

export interface Token {
  readonly kind: TokenKind;
  /** Identifier or keyword name, punctuator text, or a string's decoded value. */
  readonly value: string;
  /** The value of a number token; 0 otherwise. */
  readonly number: number;
  readonly line: number;
  readonly column: number;
}

export const KEYWORDS: ReadonlySet<string> = new Set([
  "let",
  "const",
  "function",
  "return",
  "if",
  "else",
  "while",
  "for",
  "of",
  "break",
  "continue",
  "true",
  "false",
  "null",
]);

const RESERVED_HINTS: Readonly<Record<string, string>> = {
  var: "use let or const",
  undefined: "use null",
  this: "there is no this",
  class: "there are no classes; use records and functions",
  switch: "use if / else if",
  case: "use if / else if",
  default: "use if / else if",
  do: "use while",
  try: "there are no exceptions",
  catch: "there are no exceptions",
  finally: "there are no exceptions",
  throw: "there are no exceptions",
  new: "write a record or list literal",
  delete: "use remove(record, key)",
  typeof: "compare with == null, or check with has()",
  instanceof: "there are no classes",
  in: "use has(record, key) or for (const x of list)",
  void: "",
  with: "",
  yield: "",
  async: "",
  await: "",
  import: "there are no modules",
  export: "there are no modules",
  enum: "",
  super: "there are no classes",
};

const RESERVED: ReadonlySet<string> = new Set(Object.keys(RESERVED_HINTS));

const PUNCTUATORS = [
  "===",
  "!==",
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "+=",
  "-=",
  "*=",
  "/=",
  "++",
  "--",
  "=>",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "<",
  ">",
  "?",
  ":",
  "=",
  ".",
  ",",
  ";",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
];

const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

function isIdentStart(c: string): boolean {
  return /^[A-Za-z_$]$/.test(c);
}

function isIdentPart(c: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(c);
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

export function tokenize(source: string): { tokens: Token[]; errors: Diagnostic[] } {
  const tokens: Token[] = [];
  const errors: Diagnostic[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;

  const at = (offset = 0): string => source.charAt(pos + offset);
  const column = (): number => pos - lineStart + 1;
  const error = (l: number, c: number, message: string): void => {
    errors.push({ line: l, column: c, message });
  };
  const push = (kind: TokenKind, value: string, l: number, c: number, number = 0): void => {
    tokens.push({ kind, value, number, line: l, column: c });
  };

  while (pos < source.length) {
    const c = at();
    if (c === "\n") {
      pos++;
      line++;
      lineStart = pos;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      pos++;
      continue;
    }
    const l = line;
    const col = column();

    if (c === "/" && at(1) === "/") {
      while (pos < source.length && at() !== "\n") pos++;
      continue;
    }
    if (c === "/" && at(1) === "*") {
      pos += 2;
      let closed = false;
      while (pos < source.length) {
        if (at() === "*" && at(1) === "/") {
          pos += 2;
          closed = true;
          break;
        }
        if (at() === "\n") {
          line++;
          lineStart = pos + 1;
        }
        pos++;
      }
      if (!closed) error(l, col, "unterminated block comment");
      continue;
    }

    if (isIdentStart(c)) {
      const start = pos;
      while (pos < source.length && isIdentPart(at())) pos++;
      const word = source.slice(start, pos);
      if (KEYWORDS.has(word)) {
        push("keyword", word, l, col);
      } else {
        if (RESERVED.has(word)) {
          const hint = RESERVED_HINTS[word] ?? "";
          error(l, col, `'${word}' is not supported${hint === "" ? "" : `: ${hint}`}`);
        }
        push("identifier", word, l, col);
      }
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(at(1)))) {
      const start = pos;
      while (isDigit(at())) pos++;
      if (at() === "." && isDigit(at(1))) {
        pos++;
        while (isDigit(at())) pos++;
      } else if (at() === "." && !isIdentStart(at(1))) {
        error(l, col, "a number's '.' must be followed by digits");
        pos++;
      }
      let end = pos;
      if (at() === "e" || at() === "E") {
        let p = pos + 1;
        if (source.charAt(p) === "+" || source.charAt(p) === "-") p++;
        if (isDigit(source.charAt(p))) {
          while (isDigit(source.charAt(p))) p++;
          pos = end = p;
        }
      }
      if (isIdentPart(at())) {
        error(l, column(), "unexpected character after a number");
        while (isIdentPart(at())) pos++;
      }
      const text = source.slice(start, end);
      let value = Number(text.endsWith(".") ? text.slice(0, -1) : text);
      if (!Number.isFinite(value)) {
        error(l, col, "number is too large");
        value = 0;
      }
      push("number", text, l, col, value);
      continue;
    }

    if (c === '"' || c === "'") {
      pos++;
      let value = "";
      let closed = false;
      while (pos < source.length && at() !== "\n") {
        const ch = at();
        if (ch === c) {
          pos++;
          closed = true;
          break;
        }
        if (ch === "\\") {
          const next = at(1);
          const escaped = ESCAPES[next];
          if (escaped === undefined) {
            error(
              l,
              column(),
              next === "\n" || next === ""
                ? "a string cannot continue onto the next line"
                : `invalid escape '\\${next}' (allowed: \\n \\t \\\\ \\" \\')`,
            );
            pos += next === "\n" || next === "" ? 1 : 2;
          } else {
            value += escaped;
            pos += 2;
          }
          continue;
        }
        value += ch;
        pos++;
      }
      if (!closed) error(l, col, "unterminated string");
      push("string", value, l, col);
      continue;
    }

    if (c === "`") {
      error(l, col, "template literals are not supported: use + and str()");
      pos++;
      while (pos < source.length && at() !== "`") {
        if (at() === "\n") {
          line++;
          lineStart = pos + 1;
        }
        pos++;
      }
      pos++;
      push("string", "", l, col);
      continue;
    }

    const punct = PUNCTUATORS.find((p) => source.startsWith(p, pos));
    if (punct !== undefined) {
      pos += punct.length;
      if (punct === "===" || punct === "!==") {
        const suggested = punct.slice(0, 2);
        error(l, col, `'${punct}' is not supported: use '${suggested}'`);
        push("punct", suggested, l, col);
      } else {
        push("punct", punct, l, col);
      }
      continue;
    }

    const code = source.codePointAt(pos) ?? 0;
    const char = String.fromCodePoint(code);
    error(l, col, `unexpected character '${char}'`);
    pos += char.length;
  }

  push("eof", "", line, column());
  return { tokens, errors };
}
