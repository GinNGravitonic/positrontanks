# Aumohta Language Specification, Ruleset r1

This document is the detailed language specification for Ruleset r1. It fills in the structure fixed by [v1.md §4](v1.md#4-the-aumohta-language-structure-only) and [ADR-0002](../adr/0002-counted-operation-budget.md). Vocabulary follows [GLOSSARY.md](../../GLOSSARY.md).

Numeric limits marked _provisional_ are Ruleset data and are finalised in the starter catalog design session (aumohta-0ka.3). This document defines what they mean, not their final values.

---

## 1. Overview

- A small, JavaScript-flavoured language: braces, semicolons, no significant whitespace.
- Dynamically typed with no implicit coercion. Most mistakes (unknown names, unknown `self.*` fields, wrong built-in arity) are caught by the checker when a Revision is saved.
- A Program declares top-level state and functions, an optional `init()`, and a required `tick()`.
- Every evaluated piece of code costs operations against the Bot's **Operation Budget**. Every built-in has a **constant** documented cost.
- Persistent state is limited by a **memory cap** measured in cells.
- Fully deterministic: no wall-clock time, no I/O, and all math and randomness come from the engine's pinned implementations ([ADR-0005](../adr/0005-own-deterministic-math-library.md)).

---

## 2. Lexical structure

- **Source**: UTF-8, at most `maxSourceBytes` bytes (_provisional_: 65,536).
- **Whitespace**: spaces, tabs and newlines separate tokens and are otherwise insignificant.
- **Comments**: `// to end of line` and `/* block */`. Block comments do not nest.
- **Identifiers**: `[A-Za-z_$][A-Za-z0-9_$]*`. Case-sensitive.
- **Number literals**: decimal digits with an optional fraction and exponent: `0`, `42`, `3.5`, `.5`, `1e3`, `2.5E-2`. There are no hex, octal, binary, BigInt or `_` separators. `-` is the unary operator, not part of the literal.
- **String literals**: `"..."` or `'...'` on a single line, with the escapes `\n`, `\t`, `\\`, `\"` and `\'`. Any other escape is a save-time error. There are no template literals.
- **Keywords**: `let const function return if else while for of break continue true false null`.
- **Reserved words**: these are not supported, but using them is a save-time error with a helpful message: `var class switch case default do try catch finally throw new delete typeof instanceof in this void with yield async await import export enum super undefined`.
- **Operators and punctuation**: `+ - * / % ! == != < <= > >= && || ? : = += -= *= /= ++ -- => . , ; ( ) [ ] { }`.
- `===` and `!==` are save-time errors that suggest `==` and `!=`.

---

## 3. Grammar

EBNF. `{ x }` means zero or more, `[ x ]` means optional.

```ebnf
Program        = { TopLevelDecl } ;
TopLevelDecl   = VarDecl | FunctionDecl ;

VarDecl        = ( "let" | "const" ) Identifier [ "=" Expression ] ";" ;   (* const requires an initializer *)
FunctionDecl   = "function" Identifier "(" [ Params ] ")" Block ;
Params         = Identifier { "," Identifier } ;

Block          = "{" { Statement } "}" ;
Statement      = VarDecl
               | FunctionDecl
               | IfStmt
               | WhileStmt
               | ForStmt
               | ForOfStmt
               | "break" ";"
               | "continue" ";"
               | "return" [ Expression ] ";"
               | Block
               | SimpleStmt ";" ;

SimpleStmt     = Assignment | Update | Expression ;
Assignment     = Target ( "=" | "+=" | "-=" | "*=" | "/=" ) Expression ;
Update         = Target ( "++" | "--" ) ;
Target         = Identifier | Postfix "." Identifier | Postfix "[" Expression "]" ;

IfStmt         = "if" "(" Expression ")" Block [ "else" ( IfStmt | Block ) ] ;
WhileStmt      = "while" "(" Expression ")" Block ;
ForStmt        = "for" "(" [ ForInit ] ";" [ Expression ] ";" [ SimpleStmt ] ")" Block ;
ForInit        = "let" Identifier "=" Expression | SimpleStmt ;
ForOfStmt      = "for" "(" ( "let" | "const" ) Identifier "of" Expression ")" Block ;

Expression     = Conditional ;
Conditional    = Or [ "?" Expression ":" Expression ] ;
Or             = And { "||" And } ;
And            = Equality { "&&" Equality } ;
Equality       = Relational { ( "==" | "!=" ) Relational } ;
Relational     = Additive { ( "<" | "<=" | ">" | ">=" ) Additive } ;
Additive       = Multiplicative { ( "+" | "-" ) Multiplicative } ;
Multiplicative = Unary { ( "*" | "/" | "%" ) Unary } ;
Unary          = ( "!" | "-" ) Unary | Postfix ;
Postfix        = Primary { "." Identifier | "[" Expression "]" | "(" [ Args ] ")" } ;
Args           = Expression { "," Expression } ;
Primary        = Number | String | "true" | "false" | "null" | Identifier
               | "(" Expression ")" | ListLiteral | RecordLiteral | ArrowFunction ;
ListLiteral    = "[" [ Expression { "," Expression } [ "," ] ] "]" ;
RecordLiteral  = "{" [ Field { "," Field } [ "," ] ] "}" ;
Field          = ( Identifier | String ) ":" Expression ;
ArrowFunction  = ( Identifier | "(" [ Params ] ")" ) "=>" ( Expression | Block ) ;
```

Notes:

- Bodies of `if`, `while` and `for` must be blocks (braces are required).
- Assignment, `++` and `--` are statements, not expressions. `x = y = 0` and `f(i++)` are syntax errors.
- Operator precedence and associativity follow JavaScript. `?:` is right-associative and all binary operators are left-associative.
- At the top level, only `let`, `const` and `function` declarations are allowed. Nested `function` declarations are allowed inside any block.
- Expressions and blocks may nest at most 128 levels deep. Each of these counts as one level: an expression, including one inside parentheses, a call's arguments, a list or record literal, an index or a `?:` branch; a unary operator; a block; and an `else if`. The operands of a chain of binary operators such as `a + b + c` do not add levels. Deeper nesting is a save-time error. This keeps the checker safe from hostile input. It is a fixed rule of the language, not Ruleset data.
- Function declarations are hoisted within their block, as in JavaScript, so mutually recursive functions work. `let` and `const` are not hoisted: using one before its declaration has run is a runtime error. When the checker can see the problem statically, it is a save-time error.

---

## 4. Values and operators

### 4.1 Types

| Type | Notes |
|---|---|
| number | IEEE-754 double. NaN and ±Infinity can never be produced (see 4.3). `-0` is allowed and `== 0`. |
| boolean | `true`, `false` |
| string | Immutable. Length is measured in UTF-16 code units. |
| null | The single "nothing" value. There is no `undefined`. |
| list | Mutable, ordered, shared by reference. |
| record | Mutable string-keyed fields, shared by reference. Fields are always kept in **insertion order**, including keys that look like integers. Fields can be added by assignment. |
| function | First-class. Declared with `function` or as an arrow function, with lexical closures. |

There are no classes, modules, I/O, networking, exceptions or `this`.

### 4.2 No coercion

- `if`, `while`, `for` conditions, `?:`, `!`, `&&` and `||` require booleans. `&&` and `||` short-circuit and return a boolean.
- Arithmetic (`- * / %`, unary `-`) requires numbers.
- `+` requires two numbers or two strings. `"hp: " + 5` is a runtime error, so write `"hp: " + str(5)`.
- `< <= > >=` require two numbers or two strings. Strings compare by UTF-16 code units.
- `==` and `!=` accept any two values and never error. Values of different types are unequal. Numbers, strings, booleans and null compare by value. Lists, records and functions compare by identity. `x == null` is the way to check for null.
- Any other type mismatch is a runtime error.

### 4.3 Number edge cases

- Any operation or built-in whose result would be NaN or ±Infinity is a runtime error, for example `x / 0`, `0 / 0`, `sqrt(-1)`, `asin(2)` or overflow.
- `%` follows JavaScript: the result takes the sign of the dividend, and `x % 0` is a runtime error.
- There are no bitwise operators and no `**`.

### 4.4 Access

- `record.name` and `record["name"]` read a field. Reading a missing field is a runtime error. Check with `has(record, "name")`.
- `list[i]` requires `i` to be an integer with `0 <= i < list.length`. Anything else is a runtime error. Assigning to `list[list.length]` is also a runtime error: use `.push`.
- `string[i]` is not supported. Use `.slice(i, i + 1)`.
- Record keys used with `[]` must be strings.
- No list or string may exceed `maxCollectionLength` elements or code units (_provisional_: 10,000). Any operation that would create a longer one is a runtime error.

### 4.5 Read-only values

`self`, `game`, `map` and every value reachable from them are read-only. Assigning to any of their fields or elements, or mutating them with `.push`, `.pop`, `.sort` or `remove`, is a runtime error. When the checker can see the problem statically, it is a save-time error. A Program that wants a mutable copy builds one itself.

---

## 5. Program structure and lifecycle

```js
let target = null;          // persistent state

function init() {           // optional
  // plan using map, game, self
}

function tick() {           // required
  const foes = scan().filter((c) => c.isFoe);
  // ...
}
```

### 5.1 Entry points

- `tick()` is required. `init()` is optional. Both take no parameters, and their return values are ignored. A missing `tick`, or either function declared with parameters, is a save-time error.
- At Game start, top-level initializers run in source order, followed by `init()` if it is declared. This whole phase shares one **init budget** of `initBudgetMultiplier` × the Bot's per-Tick Operation Budget (_provisional_ multiplier: 20).
- `tick()` runs once every Tick, from Tick 1, with the Bot's per-Tick Operation Budget. Budget does not carry over between Ticks.
- Persistent state is anything reachable from top-level variables. Local variables are discarded when the function returns, unless a closure stored in persistent state captures them.

### 5.2 What `init()` may use

During the init phase (top-level initializers and `init()`), Programs may use `self` (the starting state and Build), `game`, `map`, the Terrain built-ins, math, `random()`, `str`, `log`, `budgetRemaining()`, and list, string and record operations.

These are **forbidden** during the init phase: `throttle`, `turn`, `fire`, `fireAbs`, `scan`, `rangefind` and `incoming`. Calling one is a runtime error, which halts the Program (§10.3). The checker rejects the save if a forbidden built-in is reachable from top-level initializers or `init()` through calls it can resolve statically. Calls through function values can only be caught at runtime.

### 5.3 The Tick

Each Tick, every Bot's `tick()` runs against the same world snapshot ([ADR-0001](../adr/0001-fixed-tick-simultaneous-simulation.md)). `self`, `game`, `map` and all sensor results describe that snapshot. Calling a sensor twice in one Tick returns the same data, but each call still costs operations.

Commands issued during `tick()` are collected and resolved after every Bot's Program has run:

- `throttle` and `turn` persist until changed. Within a Tick, the last value issued wins.
- `fire` and `fireAbs` are one-shot. For each weapon, the last call issued in the Tick wins.
- If `tick()` stops early (budget exhausted or runtime error), commands already issued that Tick still apply.

---

## 6. Built-in values

All built-in values are read-only (§4.5). Reading a field the Ruleset does not define is a save-time error when written directly (`self.foo`), and a runtime error otherwise. The fields below are those of r1. Later Rulesets may add more ([ADR-0004](../adr/0004-extensibility-through-ruleset-data.md)).

### 6.1 `self`

A snapshot of the Bot's own state at the start of the current Tick. In the init phase, it is the Bot's starting state.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | The Bot Name |
| `tick` | number | The current Tick, starting at 1. It is 0 in the init phase. |
| `x`, `y` | number | Centre position, in meters |
| `heading` | number | Absolute Heading in degrees, [0, 360) |
| `speed` | number | Signed speed along the Heading, in m/s (negative means reversing) |
| `turnRate` | number | Current turn rate in degrees/s (positive means clockwise) |
| `throttle`, `turn` | number | The currently commanded values, in [-1, 1] |
| `hitPoints`, `maxHitPoints` | number | |
| `mass` | number | kg |
| `armor` | record | `{front, left, right, rear}` Armor values |
| `weapons` | list | One `{id, category, arcWidth, range, reloadTicks, ticksUntilReady}` per installed weapon. `id` is the Slot name, and `category` is `"melee"`, `"projectile"` or `"beam"`. |
| `sensors` | list | One `{id, kind, arcWidth, range}` per installed sensor. `id` is the Slot name, and `kind` is `"radar"`, `"rangefinder"` or `"projectileDetector"`. |
| `motorTerrain` | record | The Build's per-Terrain motor modifiers: `{terrainName: {speed, accel}}` multipliers. Terrains with no modifier are omitted. |

Assigning to `self`, or declaring a name `self`, is a save-time error.

### 6.2 `game`

| Field | Type | Meaning |
|---|---|---|
| `tickRate` | number | Ticks per simulated second (r1: 10) |
| `timeLimitTicks` | number | The Game's time limit, in Ticks |
| `playerCount` | number | The number of Players in the Game |

### 6.3 `map`

The full Map, known from the start.

| Field | Type | Meaning |
|---|---|---|
| `width`, `height` | number | meters |
| `baseTerrain` | string | The Base Terrain name |
| `terrainRegions` | list | In listed order (the later one wins on overlap): `{terrain, shape}` plus geometry |
| `obstacles` | list | Current Obstacles: `{id, destructible, shape}` plus geometry |
| `spawnZones` | list | `{shape, heading, capacity}` plus geometry |

The geometry of a `shape: "polygon"` is `points: [{x, y}, ...]`, and of a `shape: "circle"` it is `x, y, radius`.

`map.obstacles` reflects the snapshot. A destructible Obstacle that has been destroyed disappears from the list from the next Tick. A Bot that becomes Disabled appears as a wreck Obstacle from the next Tick (§10.4), with `destructible: false` and the Bot's collision shape.

---

## 7. Built-in functions

Built-ins are global, camelCase functions, except the list and string methods in §7.6. Declaring a name that matches a built-in or built-in value of the Program's Ruleset is a save-time error. When a later Ruleset adds a built-in that clashes with a name in the Program, Copy to Ruleset reports it. Calling a built-in directly with the wrong number of arguments is a save-time error, and arguments of the wrong type are runtime errors.

Bearings are relative to the Bot's Heading, in degrees within (-180, 180], positive clockwise, unless the name says `Abs`. Absolute bearings are in [0, 360), with 0 meaning up the Map.

### 7.1 Commands (not available in the init phase)

| Signature | Returns | Meaning |
|---|---|---|
| `throttle(f)` | null | Drive force as a fraction of the Build's maximum, clamped to [-1, 1]. Negative values mean reverse. |
| `turn(f)` | null | Turn as a fraction of the Build's maximum turn rate, clamped to [-1, 1]. Positive values mean clockwise. |
| `fire(weaponId, target)` | boolean | `target` is either a record with numeric `x` and `y` (such as a contact from `scan()`; it aims at that point, with no automatic lead) or a number (a relative bearing). |
| `fireAbs(weaponId, absBearing)` | boolean | Fire along an absolute bearing. |

`fire` and `fireAbs` return `true` if the shot is legal against the current snapshot: the aim is within the weapon's Firing Arc, the weapon has reloaded, and line of fire is not blocked by an Obstacle. Otherwise they return `false`, and the call is a no-op, not an error. An unknown `weaponId` is a runtime error.

### 7.2 Sensors (not available in the init phase)

| Signature | Returns |
|---|---|
| `scan()` | A list of contacts, merged across all of the Bot's Radars with no duplicates: `{id, name, x, y, distance, bearing, absBearing, heading, speed, isFoe}`. `id` is an opaque number that stays stable for the whole Game. Friends are included with `isFoe: false`. The Bot itself and Disabled Bots are never included. With no Radar, the list is empty. |
| `rangefind(sensorId)` | `{distance, hit}`, where `hit` is `"bot"`, `"obstacle"` or `"boundary"` (wrecks count as `"obstacle"`), or `null` if nothing is within range. It is a runtime error if `sensorId` is not one of the Bot's rangefinders. |
| `incoming()` | A list of `{bearing, ticksToImpact, category}` for Projectiles on a collision course, as detected by the Bot's Projectile Detectors ([v1.md §2](v1.md#sensors-and-knowledge)). With no detector, the list is empty. |

### 7.3 Terrain (Map knowledge; these see through Obstacles)

| Signature | Returns |
|---|---|
| `terrainHere()` | The Terrain name under the Bot's centre |
| `terrainAt(x, y)` | The Terrain name at a point. Out-of-Map points are a runtime error. |
| `checkTerrain(bearing, distance)` | The Terrain name at a relative bearing and distance from the Bot's centre |
| `terrainTable()` | `{terrainName: {speed, accel}}` multipliers from the Ruleset |

### 7.4 Math and geometry

All are from the engine's pinned library. Angles are in degrees.

| Signature | Notes |
|---|---|
| `sin(a)`, `cos(a)`, `tan(a)` | |
| `asin(x)`, `acos(x)` | Return degrees |
| `atan2(y, x)` | Returns degrees in (-180, 180], using the mathematical convention (counter-clockwise from +x). For bearings, use `absBearingTo`. |
| `sqrt(x)`, `hypot(x, y)`, `abs(x)` | |
| `min(a, b)`, `max(a, b)`, `clamp(x, lo, hi)` | |
| `floor(x)`, `ceil(x)`, `round(x)` | `round` rounds halves toward +∞, as in JavaScript |
| `normalizeAngle(a)` | Into (-180, 180] |
| `bearingTo(x, y)` | Relative bearing from the Bot to a point |
| `absBearingTo(x, y)` | Absolute bearing from the Bot to a point |
| `distanceTo(x, y)` | Distance from the Bot's centre to a point |
| `random()` | A number in [0, 1) from this Bot's own stream, derived from the Game seed. One Bot's calls never affect another Bot's sequence. |

### 7.5 Records and utilities

| Signature | Returns |
|---|---|
| `keys(r)` | A list of field names in insertion order |
| `has(r, k)` | boolean |
| `remove(r, k)` | boolean: whether the field existed (it is removed) |
| `str(x)` | A string. Numbers are formatted as JavaScript `Number.prototype.toString` does. Booleans and null become `true`, `false` and `null`. Lists and records render JSON-style, with fields in insertion order. Functions render as `<function>`. |
| `log(x)` | null. Writes `str(x)` to the owner-only Program log (§10.5). It does not affect the simulation. |
| `budgetRemaining()` | The operations left this Tick (or in the init budget), measured after this call's own cost |

### 7.6 List and string methods

Lists:

| Member | Returns |
|---|---|
| `.length` | number |
| `.push(x)` | The new length |
| `.pop()` | The removed last element. On an empty list it is a runtime error. |
| `.slice(start, end?)` | A new list, using JavaScript semantics including negative indices |
| `.indexOf(x)` | Index of the first element `== x`, or -1 |
| `.includes(x)` | boolean |
| `.join(sep)` | A string of `str(element)` values joined by `sep` |
| `.map(f)` | A new list of `f(x, i)` |
| `.filter(f)` | A new list of the elements where `f(x, i)` is `true` (`f` must return a boolean) |
| `.find(f)` | The first element where `f(x, i)` is `true`, or `null` |
| `.some(f)`, `.every(f)` | boolean |
| `.reduce(f, init)` | Folds with `f(acc, x, i)`. `init` is required. |
| `.sort(cmp)` | Sorts in place and returns the list. `cmp(a, b)` is required and must return a number. The sort is stable, and the engine pins its algorithm so the sequence of comparator calls is deterministic. |

Strings: `.length`, `.slice(start, end?)`, `.indexOf(sub)`, `.includes(sub)`.

Records have no methods. `r.length` on a record is an ordinary field read.

---

## 8. Operation Budget

### 8.1 Base model

- Every **evaluated expression node** costs 1: literals, identifier reads, unary and binary operators, `?:`, member access, indexing, user function calls, and creating an arrow function.
- **List and record literals** cost 1 + 1 per element or field. That is visible in the source: `[a, b, c]` costs 4, plus the cost of evaluating `a`, `b` and `c`.
- A **built-in call** costs its fixed cost from §8.2 in place of the 1 for the call node. Argument expressions are evaluated and charged as normal.
- Every **loop iteration** (`while`, `for`, `for…of`) costs 1, in addition to its condition and body.
- `+=`, `-=`, `*=`, `/=`, `++` and `--` cost 1 for the arithmetic, in addition to evaluating the target and right-hand side.
- Statements, declarations, `return`, `break`, `continue` and the final store of an assignment are otherwise free.
- Operands that short-circuit and are never evaluated cost nothing.
- Code inside a callback passed to a built-in (`.map`, `.sort`, …) costs operations each time it runs, exactly like any other code.
- The budget is checked before each charge. If a charge would exceed the remaining budget, the operation is not performed and execution stops (§10.2).

### 8.2 Built-in costs

Every built-in has one constant cost, whatever its arguments or results. Work that depends on the data, such as looping over contacts, shows up as the Program's own code operations.

| Cost | Built-ins |
|---|---|
| 1 | `budgetRemaining`, `abs`, `min`, `max`, `floor`, `ceil`, `round`, `clamp`, `normalizeAngle`, `.push`, `.pop`, `has`, `remove`, `.length` |
| 2 | `throttle`, `turn`, `random`, `terrainHere`, `str`, `log` |
| 3 | `sin`, `cos`, `tan`, `asin`, `acos`, `atan2`, `sqrt`, `hypot`, `.slice`, `.indexOf`, `.includes`, `.join`, `keys`, `.map`, `.filter`, `.find`, `.some`, `.every`, `.reduce` |
| 4 | `terrainAt`, `bearingTo`, `absBearingTo`, `distanceTo`, `terrainTable` |
| 5 | `fire`, `fireAbs`, `checkTerrain`, `.sort` |
| 8 | `rangefind`, `incoming` |
| 15 | `scan` |

Reading `self.*`, `game.*` and `map.*` is ordinary member access: 1 per node. `.length` costs 1 in place of the member-access node.

### 8.3 Budget sizes

- The per-Tick budget is set by the Bot's Processor (Parts Catalog). _Provisional_: the minimal Processor every Chassis includes gives 1,000 operations per Tick.
- The init budget is `initBudgetMultiplier` × the per-Tick budget. _Provisional_ multiplier: 20.
- Per-Tick usage is reported in CLI output, the owner's Program log and the Game Record, and by the check-tick-cost endpoint.

---

## 9. Memory cap

- Only **persistent state** counts: every value reachable from top-level variables. A value reachable by several paths is counted once.
- It is measured after the init phase ends and after every `tick()` ends, however it ended. Measuring costs no operations.
- Sizes, in cells:

| Value | Cells |
|---|---|
| number, boolean, null | 1 |
| string | 1 + ⌈length / 8⌉ |
| list | 1 + its elements' cells |
| record | 1 + per field: 1 for the key + the value's cells (so a field holding a number costs 2) |
| function declared at top level | 0 (it is code, not state) |
| any other function value | 1 + number of captured variables (plus the cells of what they reach) |

- The cap is `memoryCells` (_provisional_: 10,000).
- **Exceeding the cap halts the Program for the rest of the Game** (§10.3). The other Bots are unaffected. The CLI and the check-tick-cost endpoint report memory use so players can see the limit approaching.
- Values that are only temporary are bounded by the Operation Budget and `maxCollectionLength`, not by the memory cap.

---

## 10. Errors

### 10.1 Save-time errors

When a Bot Design Revision is saved or copied to a Ruleset, the checker reports every error it finds, each as `{line, column, message}`. A Revision with any error is rejected. Checks:

- Syntax errors, unsupported or reserved words, `===` / `!==`, and invalid escapes.
- A missing `tick`, `init` or `tick` declared with parameters, or a top-level statement that is not a declaration.
- Undeclared names, duplicate declarations in one scope, assignment to a `const`, and use of a `let`/`const` before its declaration when visible statically.
- Shadowing a built-in or a built-in value.
- Unknown `self.*`, `game.*` or `map.*` fields written directly, and direct assignment to them.
- Built-in calls with the wrong number of arguments.
- `break` or `continue` outside a loop, and `return` outside a function.
- A forbidden built-in reachable from the init phase (§5.2).
- Source longer than `maxSourceBytes`.
- Nesting deeper than 128 levels (§3).

### 10.2 Runtime errors in `tick()`

Running out of budget, or any runtime error (a type mismatch, NaN/Infinity, a missing field, an index out of range, exceeding `maxCollectionLength`, exceeding `maxCallDepth`, …), **ends that Tick's execution**. Commands already issued still apply. The error is logged as `{tick, line, column, message}`, and `tick()` runs normally next Tick. Since execution stops at the first error, at most one runtime error is logged per Tick.

`maxCallDepth` (_provisional_: 64) counts nested user-function and callback calls. `tick()` itself is depth 1.

### 10.3 Halting

A Bot's Program **halts** for the rest of the Game if:

- the init phase fails for any reason: a runtime error, running out of the init budget, or calling a forbidden built-in; or
- persistent state exceeds the memory cap at the end of the init phase or of any `tick()`.

A halted Program never runs again, and the halt is logged. A halted Bot becomes **Disabled** (cause `programHalted`), with the consequences in §10.4. The Game continues for every other Bot.

### 10.4 Disabled Bots

Every Disabled Bot follows the same rules, whatever the cause (`destroyed` when its Hit Points reached zero, or `programHalted`):

- It stops dead on the Tick it becomes Disabled: its speed and turn rate become 0 and its commands are cleared.
- It becomes an immobile, indestructible wreck Obstacle with the Bot's collision shape. The wreck blocks movement, line of sight and fire, and takes no further damage.
- It no longer appears in `scan()`. It appears in `map.obstacles` from the next Tick, and `rangefind` reports it as `"obstacle"`.
- It no longer counts toward its Player's survival.
- For the time-limit tiebreaks, damage it inflicted on Foes before becoming Disabled still counts for its Player. Its remaining Hit Points do not count in the remaining-Hit-Points tiebreak. A halt is not damage inflicted by anyone.
- The Replay records the cause.

### 10.5 Program log

The owner-only Program log records runtime errors, halts, per-Tick budget usage and `log()` output. `log()` output is capped at `logLinesPerTick` lines (_provisional_: 50) of at most `logLineLength` characters each (_provisional_: 200). Excess lines are dropped, with a single "truncated" marker for the Tick, and over-long lines are cut. These caps limit what is written, not what is charged: each `log()` call still costs its 2 operations.

---

## 11. Ruleset limits

Every value below is Ruleset data. The values are _provisional_ until aumohta-0ka.3.

| Key | Provisional r1 value |
|---|---|
| Per-Tick Operation Budget | Per Processor; minimal Processor 1,000 |
| `initBudgetMultiplier` | 20 |
| `memoryCells` | 10,000 |
| `maxCallDepth` | 64 |
| `maxCollectionLength` | 10,000 |
| `maxSourceBytes` | 65,536 |
| `logLinesPerTick` | 50 |
| `logLineLength` | 200 |

---

## 12. Determinism notes for implementers

- Record field order is always insertion order. Don't use plain JS objects, whose integer-like keys get reordered.
- Math built-ins and `atan2`-based geometry use only the engine's pinned library (ADR-0005).
- `random()` streams are derived per Bot from the Game seed, independently of call order across Bots.
- `.sort` uses a pinned stable algorithm. The number and order of comparator calls is part of the frozen engine.
- `str()` on numbers relies on ECMAScript's fully specified `Number.prototype.toString`.
- Cost accounting, memory measurement and every limit check are part of the frozen engine for a Ruleset version.
