/**
 * Recursive-descent parser for the grammar in language-r1 section 3.
 *
 * A syntax error abandons only the statement it occurs in: the parser records
 * it, skips to the end of that statement, and carries on, so one save reports
 * every independent syntax error. Nesting is capped at MAX_NESTING so hostile
 * input cannot exhaust the stack.
 */

import type {
  ArrowFunction,
  AssignmentOperator,
  BinaryOperator,
  Block,
  Expression,
  ForOfStatement,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  Location,
  Program,
  RecordField,
  SimpleStatement,
  Statement,
  TopLevelDeclaration,
  VarDeclaration,
} from "./ast.js";
import { tokenize, type Diagnostic, type Token } from "./lexer.js";

/** How deeply expressions and blocks may nest. */
export const MAX_NESTING = 128;

export interface ParseResult {
  /** Statements with syntax errors are left out. */
  readonly program: Program;
  /** Lexical and syntax errors, in source order. */
  readonly errors: readonly Diagnostic[];
}

class SyntaxError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

const ASSIGNMENT_OPERATORS: ReadonlySet<string> = new Set(["=", "+=", "-=", "*=", "/="]);

const BINARY_LEVELS: readonly (readonly BinaryOperator[])[] = [
  ["||"],
  ["&&"],
  ["==", "!="],
  ["<", "<=", ">", ">="],
  ["+", "-"],
  ["*", "/", "%"],
];

function describe(token: Token): string {
  switch (token.kind) {
    case "eof":
      return "end of input";
    case "string":
      return "a string";
    case "number":
      return `number ${token.value}`;
    default:
      return `'${token.value}'`;
  }
}

function locOf(token: Token): Location {
  return { line: token.line, column: token.column };
}

class Parser {
  private pos = 0;
  private depth = 0;
  readonly errors: Diagnostic[] = [];

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(offset = 0): Token {
    const last = this.tokens[this.tokens.length - 1];
    if (last === undefined) throw new Error("token list must end with eof");
    return this.tokens[this.pos + offset] ?? last;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== "eof") this.pos++;
    return token;
  }

  private isPunct(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === "punct" && token.value === value;
  }

  private isKeyword(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === "keyword" && token.value === value;
  }

  private fail(token: Token, message: string): never {
    throw new SyntaxError({ line: token.line, column: token.column, message });
  }

  private unexpected(expected: string): never {
    const token = this.peek();
    if (token.kind === "punct" && (ASSIGNMENT_OPERATORS.has(token.value) || token.value === "++" || token.value === "--")) {
      this.fail(token, `'${token.value}' is a statement, not an expression: assignments and ++/-- cannot appear inside expressions`);
    }
    this.fail(token, `expected ${expected} but found ${describe(token)}`);
  }

  private expectPunct(value: string): Token {
    if (!this.isPunct(value)) this.unexpected(`'${value}'`);
    return this.next();
  }

  private expectKeyword(value: string): Token {
    if (!this.isKeyword(value)) this.unexpected(`'${value}'`);
    return this.next();
  }

  private identifier(what = "a name"): Identifier {
    const token = this.peek();
    if (token.kind !== "identifier") this.unexpected(what);
    this.next();
    return { type: "Identifier", name: token.value, loc: locOf(token) };
  }

  private nest<T>(token: Token, parse: () => T): T {
    if (this.depth >= MAX_NESTING) this.fail(token, `code is nested more than ${String(MAX_NESTING)} levels deep`);
    this.depth++;
    try {
      return parse();
    } finally {
      this.depth--;
    }
  }

  /**
   * Skips the rest of a statement that failed to parse. In a `for` header the
   * `;` separators are inside parentheses and do not end the statement.
   */
  private synchronize(start: number): void {
    let depth = 0;
    let parens = 0;
    const isFor = this.tokens[start]?.kind === "keyword" && this.tokens[start].value === "for";
    const parenDelta = (token: Token): number =>
      token.kind === "punct" ? (token.value === "(" ? 1 : token.value === ")" ? -1 : 0) : 0;
    if (isFor) for (let i = start; i < this.pos; i++) parens += parenDelta(this.tokens[i] ?? this.peek());
    for (;;) {
      const token = this.peek();
      if (token.kind === "eof") break;
      parens += parenDelta(token);
      if (token.kind === "punct") {
        if (token.value === ";" && depth === 0 && (!isFor || parens <= 0)) {
          this.next();
          break;
        }
        if (token.value === "{") depth++;
        if (token.value === "}") {
          if (depth === 0) break;
          depth--;
          this.next();
          if (depth === 0) break;
          continue;
        }
      }
      this.next();
    }
    if (this.pos === start) this.next();
  }

  /** Parses one statement, or records its syntax error and returns null. */
  private recovering<T>(parse: () => T): T | null {
    const start = this.pos;
    const depth = this.depth;
    try {
      return parse();
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      this.errors.push(e.diagnostic);
      this.depth = depth;
      this.synchronize(start);
      return null;
    }
  }

  parseProgram(): Program {
    const body: TopLevelDeclaration[] = [];
    while (this.peek().kind !== "eof") {
      const decl = this.recovering(() => this.topLevel());
      if (decl !== null) body.push(decl);
    }
    return { type: "Program", body };
  }

  private topLevel(): TopLevelDeclaration | null {
    if (this.isKeyword("let") || this.isKeyword("const")) return this.varDeclaration();
    if (this.isKeyword("function")) return this.functionDeclaration();
    const token = this.peek();
    this.statement();
    this.errors.push({
      line: token.line,
      column: token.column,
      message: "only let, const and function declarations are allowed at the top level",
    });
    return null;
  }

  private varDeclaration(): VarDeclaration {
    const kindToken = this.next();
    const kind = kindToken.value === "const" ? "const" : "let";
    const id = this.identifier();
    let init: Expression | null = null;
    if (this.isPunct("=")) {
      this.next();
      init = this.expression();
    } else if (kind === "const") {
      this.fail(this.peek(), `const '${id.name}' requires an initializer`);
    }
    this.expectPunct(";");
    return { type: "VarDeclaration", kind, id, init, loc: locOf(kindToken) };
  }

  private functionDeclaration(): FunctionDeclaration {
    const start = this.expectKeyword("function");
    const id = this.identifier("a function name");
    this.expectPunct("(");
    const params = this.params();
    const body = this.block("function");
    return { type: "FunctionDeclaration", id, params, body, loc: locOf(start) };
  }

  /** Parameter names up to and including the closing ')'. */
  private params(): Identifier[] {
    const params: Identifier[] = [];
    if (!this.isPunct(")")) {
      params.push(this.identifier("a parameter name"));
      while (this.isPunct(",")) {
        this.next();
        params.push(this.identifier("a parameter name"));
      }
    }
    this.expectPunct(")");
    return params;
  }

  private block(owner: string): Block {
    const open = this.peek();
    if (!this.isPunct("{")) this.fail(open, `the body of ${owner} must be a block in braces`);
    return this.nest(open, () => {
      this.next();
      const body: Statement[] = [];
      while (!this.isPunct("}")) {
        if (this.peek().kind === "eof") this.fail(open, "this '{' is never closed");
        const statement = this.recovering(() => this.statement());
        if (statement !== null) body.push(statement);
      }
      this.next();
      return { type: "Block", body, loc: locOf(open) };
    });
  }

  private statement(): Statement {
    const token = this.peek();
    if (token.kind === "keyword") {
      switch (token.value) {
        case "let":
        case "const":
          return this.varDeclaration();
        case "function":
          return this.functionDeclaration();
        case "if":
          return this.ifStatement();
        case "while": {
          this.next();
          this.expectPunct("(");
          const test = this.expression();
          this.expectPunct(")");
          return { type: "WhileStatement", test, body: this.block("while"), loc: locOf(token) };
        }
        case "for":
          return this.forStatement();
        case "break":
        case "continue":
          this.next();
          this.expectPunct(";");
          return { type: token.value === "break" ? "BreakStatement" : "ContinueStatement", loc: locOf(token) };
        case "return": {
          this.next();
          const argument = this.isPunct(";") ? null : this.expression();
          this.expectPunct(";");
          return { type: "ReturnStatement", argument, loc: locOf(token) };
        }
      }
    }
    if (this.isPunct("{")) return this.block("a block");
    const statement = this.simpleStatement();
    this.expectPunct(";");
    return statement;
  }

  private ifStatement(): IfStatement {
    const start = this.expectKeyword("if");
    this.expectPunct("(");
    const test = this.expression();
    this.expectPunct(")");
    const consequent = this.block("if");
    let alternate: IfStatement | Block | null = null;
    if (this.isKeyword("else")) {
      this.next();
      alternate = this.isKeyword("if") ? this.nest(start, () => this.ifStatement()) : this.block("else");
    }
    return { type: "IfStatement", test, consequent, alternate, loc: locOf(start) };
  }

  private forStatement(): ForStatement | ForOfStatement {
    const start = this.expectKeyword("for");
    this.expectPunct("(");
    if ((this.isKeyword("let") || this.isKeyword("const")) && this.peek(1).kind === "identifier" && this.isKeyword("of", 2)) {
      const kind = this.next().value === "const" ? "const" : "let";
      const id = this.identifier();
      this.next();
      const iterable = this.expression();
      this.expectPunct(")");
      return { type: "ForOfStatement", kind, id, iterable, body: this.block("for"), loc: locOf(start) };
    }
    let init: VarDeclaration | SimpleStatement | null = null;
    if (this.isKeyword("const")) {
      this.fail(this.peek(), "use let for a for loop's counter: const can only be used with for...of");
    } else if (this.isKeyword("let")) {
      const letToken = this.next();
      const id = this.identifier();
      this.expectPunct("=");
      init = { type: "VarDeclaration", kind: "let", id, init: this.expression(), loc: locOf(letToken) };
    } else if (!this.isPunct(";")) {
      init = this.simpleStatement();
    }
    this.expectPunct(";");
    const test = this.isPunct(";") ? null : this.expression();
    this.expectPunct(";");
    const update = this.isPunct(")") ? null : this.simpleStatement();
    this.expectPunct(")");
    return { type: "ForStatement", init, test, update, body: this.block("for"), loc: locOf(start) };
  }

  private simpleStatement(): SimpleStatement {
    const first = this.peek();
    const expression = this.expression();
    const op = this.peek();
    const isAssignment = op.kind === "punct" && ASSIGNMENT_OPERATORS.has(op.value);
    const isUpdate = op.kind === "punct" && (op.value === "++" || op.value === "--");
    if (!isAssignment && !isUpdate) return { type: "ExpressionStatement", expression, loc: locOf(first) };
    if (expression.type !== "Identifier" && expression.type !== "MemberExpression" && expression.type !== "IndexExpression") {
      this.fail(op, `cannot assign to this expression: '${op.value}' needs a variable, field or element on its left`);
    }
    this.next();
    if (isUpdate) {
      return { type: "UpdateStatement", operator: op.value === "++" ? "++" : "--", target: expression, loc: locOf(op) };
    }
    const value = this.expression();
    return { type: "AssignmentStatement", operator: op.value as AssignmentOperator, target: expression, value, loc: locOf(op) };
  }

  private expression(): Expression {
    return this.nest(this.peek(), () => {
      const test = this.binary(0);
      if (!this.isPunct("?")) return test;
      const question = this.next();
      const consequent = this.expression();
      this.expectPunct(":");
      const alternate = this.expression();
      return { type: "ConditionalExpression", test, consequent, alternate, loc: locOf(question) };
    });
  }

  private binary(level: number): Expression {
    const operators = BINARY_LEVELS[level];
    if (operators === undefined) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.peek();
      const operator = operators.find((o) => token.kind === "punct" && token.value === o);
      if (operator === undefined) return left;
      this.next();
      const right = this.binary(level + 1);
      left = { type: "BinaryExpression", operator, left, right, loc: locOf(token) };
    }
  }

  private unary(): Expression {
    const token = this.peek();
    if (token.kind === "punct" && (token.value === "!" || token.value === "-")) {
      this.next();
      const operand = this.nest(token, () => this.unary());
      return { type: "UnaryExpression", operator: token.value, operand, loc: locOf(token) };
    }
    return this.postfix();
  }

  private postfix(): Expression {
    let expression = this.primary();
    for (;;) {
      const token = this.peek();
      if (this.isPunct(".")) {
        this.next();
        const property = this.identifier("a field name");
        expression = { type: "MemberExpression", object: expression, property, loc: locOf(token) };
      } else if (this.isPunct("[")) {
        this.next();
        const index = this.expression();
        this.expectPunct("]");
        expression = { type: "IndexExpression", object: expression, index, loc: locOf(token) };
      } else if (this.isPunct("(")) {
        this.next();
        const args: Expression[] = [];
        if (!this.isPunct(")")) {
          args.push(this.expression());
          while (this.isPunct(",")) {
            this.next();
            args.push(this.expression());
          }
        }
        this.expectPunct(")");
        expression = { type: "CallExpression", callee: expression, args, loc: locOf(token) };
      } else {
        return expression;
      }
    }
  }

  private primary(): Expression {
    const token = this.peek();
    const loc = locOf(token);
    switch (token.kind) {
      case "number":
        this.next();
        return { type: "NumberLiteral", value: token.number, loc };
      case "string":
        this.next();
        return { type: "StringLiteral", value: token.value, loc };
      case "identifier":
        if (this.isPunct("=>", 1)) return this.arrow();
        this.next();
        return { type: "Identifier", name: token.value, loc };
      case "keyword":
        if (token.value === "true" || token.value === "false") {
          this.next();
          return { type: "BooleanLiteral", value: token.value === "true", loc };
        }
        if (token.value === "null") {
          this.next();
          return { type: "NullLiteral", loc };
        }
        break;
      case "punct":
        if (token.value === "(") {
          if (this.arrowAhead()) return this.arrow();
          this.next();
          const inner = this.expression();
          this.expectPunct(")");
          return inner;
        }
        if (token.value === "[") return this.listLiteral();
        if (token.value === "{") return this.recordLiteral();
        break;
      case "eof":
        break;
    }
    this.unexpected("an expression");
  }

  /** Whether the '(' at the current position starts an arrow function's parameters. */
  private arrowAhead(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token === undefined || token.kind === "eof") return false;
      if (token.kind !== "punct") continue;
      if (token.value === "(") depth++;
      if (token.value === ")" && --depth === 0) {
        const after = this.tokens[i + 1];
        return after?.kind === "punct" && after.value === "=>";
      }
    }
    return false;
  }

  private arrow(): ArrowFunction {
    const start = this.peek();
    let params: Identifier[];
    if (this.isPunct("(")) {
      this.next();
      params = this.params();
    } else {
      params = [this.identifier()];
    }
    this.expectPunct("=>");
    const body = this.isPunct("{") ? this.block("an arrow function") : this.expression();
    return { type: "ArrowFunction", params, body, loc: locOf(start) };
  }

  private listLiteral(): Expression {
    const open = this.expectPunct("[");
    const elements: Expression[] = [];
    while (!this.isPunct("]")) {
      elements.push(this.expression());
      if (!this.isPunct(",")) break;
      this.next();
    }
    this.expectPunct("]");
    return { type: "ListLiteral", elements, loc: locOf(open) };
  }

  private recordLiteral(): Expression {
    const open = this.expectPunct("{");
    const fields: RecordField[] = [];
    while (!this.isPunct("}")) {
      const key = this.peek();
      if (key.kind !== "identifier" && key.kind !== "string") this.unexpected("a field name");
      this.next();
      this.expectPunct(":");
      fields.push({ key: key.value, value: this.expression(), loc: locOf(key) });
      if (!this.isPunct(",")) break;
      this.next();
    }
    this.expectPunct("}");
    return { type: "RecordLiteral", fields, loc: locOf(open) };
  }
}

export function compareLocations(a: Location, b: Location): number {
  return a.line - b.line || a.column - b.column;
}

export function parse(source: string): ParseResult {
  const lexed = tokenize(source);
  const parser = new Parser(lexed.tokens);
  const program = parser.parseProgram();
  const errors = [...lexed.errors, ...parser.errors].sort(compareLocations);
  return { program, errors };
}
