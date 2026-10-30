/**
 * The syntax tree of a Positron Tanks Program (language-r1 section 3).
 *
 * Every node carries a `loc`. For operator-shaped nodes (binary, unary,
 * conditional, member access, indexing, calls, assignments and updates) it is
 * the position of the operator token, which is where runtime errors point; for
 * everything else it is the node's first token.
 */

/** 1-based line and column; columns count UTF-16 code units. */
export interface Location {
  readonly line: number;
  readonly column: number;
}

export interface Identifier {
  readonly type: "Identifier";
  readonly name: string;
  readonly loc: Location;
}

export interface NumberLiteral {
  readonly type: "NumberLiteral";
  readonly value: number;
  readonly loc: Location;
}

export interface StringLiteral {
  readonly type: "StringLiteral";
  readonly value: string;
  readonly loc: Location;
}

export interface BooleanLiteral {
  readonly type: "BooleanLiteral";
  readonly value: boolean;
  readonly loc: Location;
}

export interface NullLiteral {
  readonly type: "NullLiteral";
  readonly loc: Location;
}

export interface ListLiteral {
  readonly type: "ListLiteral";
  readonly elements: readonly Expression[];
  readonly loc: Location;
}

export interface RecordField {
  readonly key: string;
  readonly value: Expression;
  readonly loc: Location;
}

export interface RecordLiteral {
  readonly type: "RecordLiteral";
  readonly fields: readonly RecordField[];
  readonly loc: Location;
}

export interface ArrowFunction {
  readonly type: "ArrowFunction";
  readonly params: readonly Identifier[];
  readonly body: Expression | Block;
  readonly loc: Location;
}

export type UnaryOperator = "!" | "-";

export interface UnaryExpression {
  readonly type: "UnaryExpression";
  readonly operator: UnaryOperator;
  readonly operand: Expression;
  readonly loc: Location;
}

export type BinaryOperator =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%";

export interface BinaryExpression {
  readonly type: "BinaryExpression";
  readonly operator: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
  readonly loc: Location;
}

export interface ConditionalExpression {
  readonly type: "ConditionalExpression";
  readonly test: Expression;
  readonly consequent: Expression;
  readonly alternate: Expression;
  readonly loc: Location;
}

export interface MemberExpression {
  readonly type: "MemberExpression";
  readonly object: Expression;
  readonly property: Identifier;
  readonly loc: Location;
}

export interface IndexExpression {
  readonly type: "IndexExpression";
  readonly object: Expression;
  readonly index: Expression;
  readonly loc: Location;
}

export interface CallExpression {
  readonly type: "CallExpression";
  readonly callee: Expression;
  readonly args: readonly Expression[];
  readonly loc: Location;
}

export type Expression =
  | Identifier
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NullLiteral
  | ListLiteral
  | RecordLiteral
  | ArrowFunction
  | UnaryExpression
  | BinaryExpression
  | ConditionalExpression
  | MemberExpression
  | IndexExpression
  | CallExpression;

export type AssignmentTarget = Identifier | MemberExpression | IndexExpression;

export interface VarDeclaration {
  readonly type: "VarDeclaration";
  readonly kind: "let" | "const";
  readonly id: Identifier;
  readonly init: Expression | null;
  readonly loc: Location;
}

export interface FunctionDeclaration {
  readonly type: "FunctionDeclaration";
  readonly id: Identifier;
  readonly params: readonly Identifier[];
  readonly body: Block;
  readonly loc: Location;
}

export interface Block {
  readonly type: "Block";
  readonly body: readonly Statement[];
  readonly loc: Location;
}

export interface IfStatement {
  readonly type: "IfStatement";
  readonly test: Expression;
  readonly consequent: Block;
  readonly alternate: IfStatement | Block | null;
  readonly loc: Location;
}

export interface WhileStatement {
  readonly type: "WhileStatement";
  readonly test: Expression;
  readonly body: Block;
  readonly loc: Location;
}

/** `for (let i = 0; ...)`: the `let` form is a VarDeclaration with an initializer. */
export interface ForStatement {
  readonly type: "ForStatement";
  readonly init: VarDeclaration | SimpleStatement | null;
  readonly test: Expression | null;
  readonly update: SimpleStatement | null;
  readonly body: Block;
  readonly loc: Location;
}

export interface ForOfStatement {
  readonly type: "ForOfStatement";
  readonly kind: "let" | "const";
  readonly id: Identifier;
  readonly iterable: Expression;
  readonly body: Block;
  readonly loc: Location;
}

export interface BreakStatement {
  readonly type: "BreakStatement";
  readonly loc: Location;
}

export interface ContinueStatement {
  readonly type: "ContinueStatement";
  readonly loc: Location;
}

export interface ReturnStatement {
  readonly type: "ReturnStatement";
  readonly argument: Expression | null;
  readonly loc: Location;
}

export type AssignmentOperator = "=" | "+=" | "-=" | "*=" | "/=";

export interface AssignmentStatement {
  readonly type: "AssignmentStatement";
  readonly operator: AssignmentOperator;
  readonly target: AssignmentTarget;
  readonly value: Expression;
  readonly loc: Location;
}

export interface UpdateStatement {
  readonly type: "UpdateStatement";
  readonly operator: "++" | "--";
  readonly target: AssignmentTarget;
  readonly loc: Location;
}

export interface ExpressionStatement {
  readonly type: "ExpressionStatement";
  readonly expression: Expression;
  readonly loc: Location;
}

export type SimpleStatement = AssignmentStatement | UpdateStatement | ExpressionStatement;

export type Statement =
  | VarDeclaration
  | FunctionDeclaration
  | IfStatement
  | WhileStatement
  | ForStatement
  | ForOfStatement
  | BreakStatement
  | ContinueStatement
  | ReturnStatement
  | Block
  | SimpleStatement;

export type TopLevelDeclaration = VarDeclaration | FunctionDeclaration;

export interface Program {
  readonly type: "Program";
  readonly body: readonly TopLevelDeclaration[];
}
