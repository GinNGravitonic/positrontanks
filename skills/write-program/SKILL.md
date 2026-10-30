---
name: write-program
description: Write a Program (Positron Tanks language source, .ptk) for a Bot Design, check it against the save-time checker and the Operation Budget, and save it to a server as a new Revision with the API CLI. Use when giving a Bot Design its first real Program, changing a design's tactics, or fixing a Program the checker, runner or server rejected or that runs out of budget.
---

# Write a Program

A Program is the code a Bot runs every Tick. It is source in the Positron Tanks language for the design's Ruleset, conventionally a `.ptk` file. You read the design's Build, write the Program against the Build's Slot ids, check it offline with `positrontanks tick-cost` (the same checker the server runs, plus the Operation Budget), try it in a local Game, then save it with `positrontanks designs revise --program`.

This skill assumes the `positrontanks` CLI is installed (`ptanks` is its alias). Saving needs a CLI profile signed in to the server that holds the design. To make the design itself, use the create-bot-design skill first.

## 1. Pin down the brief

Settle, from the request or by asking:

- **Design**: the Bot Design's id, on which server. Or, with no design yet, the Build file the Program is for.
- **Role**: what the Bot should do, such as snipe from range, charge and ram, kite, guard a point or support Friends. The Build was chosen for a role; the Program plays it.
- **Team**: whether the Bot fights alone or alongside Friends in its Entry. Friends show up in `scan()` too, and shots hit Friends like Foes.

Done when you know the design (or Build) and can state its role in a sentence.

## 2. Read the Build

Fetch the design and its current Program:

```bash
positrontanks designs show <DESIGN_ID> --json --program-out current.ptk
```

From the JSON, save `latestRevision.build` as `<name>.build.json` and note `rulesetVersion`. Then list from the Build what the Program can use:

- **Weapons**: each weapon's **Slot id** (such as `gun`, `leftGun`, `prow`), which is what `fire` takes, and its kind. Slot direction matters: a fixed weapon only fires within its Firing Arc around the Slot's direction (forward unless the Slot faces left, right or rear), so the Bot turns to aim; a turret (`cannonTurret`, `beamTurret`) fires in any direction.
- **Sensors**: a Radar makes `scan()` return contacts; a `rangefinder` needs `rangefind("<its Slot id>")`; a `detector` makes `incoming()` return Projectiles. With no Radar, `scan()` is always empty.
- **Processor**: the per-Tick Operation Budget. 1,000 with the built-in Processor in r1, 2,000 with `coprocessor`, 4,000 with `fastProcessor`, 8,000 with `superProcessor`.

`positrontanks rulesets parts <RULESET> --json` gives every part's stats (`range`, `arcWidth`, `reloadTicks`, damage, `projectileSpeed`). A Program can also read its weapons and sensors at run time from `self.weapons` and `self.sensors`.

Done when you know every weapon and sensor Slot id, which way each faces, and the Operation Budget.

## 3. Learn the language

Read the language specification for the design's Ruleset once before writing:

```bash
positrontanks rulesets docs r1 language
positrontanks rulesets docs r1 engine
```

The first is the full language: grammar, every built-in and its operation cost, the memory cap and the errors. The second says how the world reacts: movement, aiming, line of fire, sensors. `positrontanks rulesets language r1 --json` gives the same as data: every built-in with its operation cost, the fields of `self`, `game` and `map`, and the limits.

The essentials for r1, enough for most Programs:

**Shape.** Top-level `let`, `const` and `function` declarations only. `tick()` is required and runs every Tick; `init()` is optional and runs once at Game start. Neither takes parameters. Top-level variables persist between Ticks; locals do not.

**It looks like JavaScript, but:**

- No coercion. `if`, `while`, `?:`, `!`, `&&`, `||` need booleans, so write `if (foe != null)`, never `if (foe)`. `+` needs two numbers or two strings: `"hp " + str(self.hitPoints)`.
- `==` and `!=` only; `===` is an error. `null` only; no `undefined`. Check a record field with `has(r, "f")` before reading it, since a missing field is an error.
- Braces are required on every `if`, `while` and `for` body. `for (const c of list)` works on lists only.
- Assignment, `++` and `--` are statements, not expressions: no `f(i++)`, no `a = b = 0`.
- No classes, `this`, `new`, `try`, `switch`, `var`, template literals, `**`, bitwise operators or `string[i]` (use `.slice(i, i + 1)`). Arrow functions and closures work.
- Dividing by zero, `sqrt(-1)` and the like are runtime errors, not NaN.
- You may not declare a name that a built-in uses (`scan`, `map`, `self`, `turn`, `min`, ...); call a variable `world` or `foes`, not `map`.
- Lists have `.length .push .pop .slice .indexOf .includes .join .map .filter .find .some .every .reduce .sort(cmp)`. `.reduce` needs its initial value and `.sort` its comparator. Strings have `.length .slice .indexOf .includes`. Records have no methods; use `keys`, `has`, `remove`.

**Geometry.** Meters, origin top-left, y down the Map. Absolute headings and bearings are degrees clockwise from up the Map, in [0, 360). Relative bearings are from the Bot's Heading, in (-180, 180], positive clockwise (to the right). Every distance and bearing is from the Bot's centre.

**Reading the world.**

- `self`: `x`, `y`, `heading`, `speed`, `hitPoints`, `maxHitPoints`, `tick`, `weapons` (`{id, category, arcWidth, range, reloadTicks, ticksUntilReady}`), `sensors`, `armor` and more. Read-only.
- `map`: `width`, `height`, `obstacles`, `terrainRegions`, `spawnZones`, `baseTerrain`. The whole Map is known from the start. `game`: `tickRate` (10), `timeLimitTicks`, `playerCount`.
- `scan()`: contacts seen by any Radar with line of sight, `{id, name, x, y, distance, bearing, absBearing, heading, speed, isFoe}`; Friends have `isFoe: false`. `id` is stable for the Game, so it can key what you remember about a Bot.
- `rangefind(slotId)`: `{distance, hit}` along that rangefinder's direction, or `null`. `incoming()`: `{bearing, ticksToImpact, category}` for Projectiles about to hit this Bot.
- `bearingTo(x, y)`, `absBearingTo(x, y)`, `distanceTo(x, y)`, `normalizeAngle(a)`, `terrainHere()`, `terrainAt(x, y)`, math (`sin`, `cos`, `atan2` and so on take and give degrees), `clamp`, `random()`.

**Acting.**

- `throttle(f)` and `turn(f)`, each in [-1, 1], stay in force until changed. Positive `turn` is clockwise. `turn(clamp(bearing / 20, -1, 1))` steers toward a bearing and eases off as it lines up.
- `fire(slotId, target)` aims at a record's `x` and `y` (a `scan()` contact) or at a relative bearing (a number); `fireAbs(slotId, absBearing)`. It returns `false`, doing nothing, if the aim is outside the Firing Arc, the weapon is reloading or an Obstacle blocks the line of fire. So it is safe to call every Tick. It aims where you say: lead a moving target yourself.
- `init()` may not call `throttle`, `turn`, `fire`, `fireAbs`, `scan`, `rangefind` or `incoming`; doing so halts the Program and Disables the Bot.
- `log(x)` writes to the owner-only Program log, at most 50 lines per Tick.

**Costs.** Every evaluated expression node costs 1 operation; each built-in has a fixed cost instead: `scan` 15, `rangefind` and `incoming` 8, `fire` and `.sort` 5, `bearingTo` and `distanceTo` 4, `sqrt`, `atan2`, `.map`, `.filter` and friends 3, `throttle`, `turn`, `str` and `log` 2, `clamp`, `abs`, `min`, `max`, `.push` and `.length` 1. Each loop iteration costs 1 more. When a Tick runs out of budget, `tick()` stops where it is; commands already issued still apply, and the next Tick starts fresh. The init phase gets 50 times the per-Tick budget. Persistent state is capped at 10,000 memory cells (a number is 1 cell, a list 1 plus its elements, a record field 1 plus its value); going over **halts the Program for the rest of the Game**.

Done when you have read the spec and the essentials hold no surprises.

## 4. Write the Program

Copy the bundled [`starter.ptk`](starter.ptk) to `<name>.ptk` and adapt it. It runs unchanged on any Build with a weapon, a Radar and a motor, because it reads its weapon Slot ids from `self.weapons`: it chases the nearest Foe, holds at weapon range and fires every weapon, chases a Foe's last position when it loses sight, and otherwise heads for the Map centre. The repo's [`packages/cli/examples`](../../packages/cli/examples) has two more worked Programs, `hunter.ptk` (sweeps and shoots) and `rammer.ptk` (charges with a Hammer).

Shape the Program around the role:

- **Name the Slots.** Where the Build is fixed, write `fire("leftGun", foe)` directly; the checker then catches a misspelt Slot id. Fire every weapon each Tick; a reloading or out-of-arc one just returns `false`.
- **Aim with the Bot.** For a forward weapon, turn toward the target first; the shot is legal once the bearing is within half the weapon's `arcWidth`. Side or rear weapons want the Bot turned so the target sits off that side. Turrets need no turning.
- **Keep the right distance.** Hold at most weapons' `range` for guns and beams, which can miss at the edge; close all the way for melee, whose range counts from the Bot's centre.
- **Lead Projectiles** at a moving Foe: aim at `x + sin(heading) * speed * t`, `y - cos(heading) * speed * t`, where `t` is the flight time, `distance / projectileSpeed`.
- **Dodge** with a `detector`: when `incoming()` reports something with few `ticksToImpact`, turn across its bearing and go full throttle.
- **Stay unstuck.** If `self.speed` stays near 0 while throttle is up, the Bot is against an Obstacle or the boundary: reverse and turn for a few Ticks. `map.obstacles` lets the Program plan around them.
- **Choose a target, not just the nearest:** the weakest, the one already damaged, or the one a Friend is fighting. Do not fire through a Friend.
- **Plan once in `init()`.** Path planning or Map analysis belongs there, with 50 times the budget; store the result in top-level variables, and keep it small for the memory cap.

Keep each Tick well under budget. Above all, keep loops over contacts or Map features cheap: `scan()` costs 15 every call, so call it once per Tick and keep the result in a local. A loop over 10 contacts that calls `distanceTo` and `bearingTo` costs over 100 operations. Use `budgetRemaining()` to cut optional work short.

Done when the file is written and covers the role.

## 5. Check it offline

Write a one-Bot Entry file, `<name>.entry.json`, next to the Program, with the design's Build and the Program file:

```json
{
  "ruleset": "r1",
  "bots": [{ "name": "Check", "build": <the Build>, "programFile": "<name>.ptk" }]
}
```

Then run the tick cost check:

```bash
positrontanks tick-cost --entry <name>.entry.json --ticks 100
```

It runs the same checks the server runs when the Revision is saved: the Build against the Ruleset, and the Program with the language checker against that Build (so a `fire` at a Slot the Build lacks is caught). Then it plays the init phase and up to 100 Ticks in a sample world: a 60 x 40 Map with one sample Foe 20 m ahead that circles and never fires.

- **Exit code 1**: save-time errors, one `<file>:<line>:<column>: Bot "Check": <message>` per line, all at once. Fix every one and rerun. The server would reject the same Program with the same messages.
- **Exit code 0**: the table shows, per Bot, the init phase's operations against the init budget, the **Tick peak** against the Operation Budget, how many Ticks ran **out of budget**, how many stopped at a runtime **error**, the **memory peak** against the cap, and whether the Program **halted**.

The check passes when Out of budget, Errors and Halted are all `0` or `-`, and the Tick peak leaves headroom: under about half the budget, since the sample world has a single Foe and a real Game may show more contacts, each costing your per-contact loop again. The text table counts runtime errors but does not say what they were; rerun with `--json` and read `bots[].report.runs[]`, where each run with `"outcome": "error"` has `error.line`, `error.column` and `error.message`. A halted Program has `report.halt` with the Tick and reason. Try a second `--seed` too, which changes the starting side and `random()`.

Then watch the Program fight. Play a local Game on the bundled [`arena.map.json`](arena.map.json) against the bundled sparring partner, [`sparring.entry.json`](sparring.entry.json) (a twin-autocannon Rover running the starter Program):

```bash
positrontanks run --map <this skill's folder>/arena.map.json --entry <name>.entry.json --entry <this skill's folder>/sparring.entry.json --unthrottled --point-budget 800 --out <a scratch folder>
```

The output gives the result, the damage each side dealt, and the **budget peaks** from the real Game, which is the better budget figure. `program-logs.json` in the output folder has, per Bot, every Tick's `operations`, `error` and `log` lines; read it when the Bot misbehaves, and add `log` calls to see what the Program decided. Fix and rerun across a few `--seed`s until the Bot plays its role: it finds the Foe, keeps its weapons on it, and does not stall against Obstacles. Whether it wins also depends on the Build, so a loss is a reason to look, not proof the Program is wrong; improving a design by self-play is its own skill. To play a whole Entry of several designs, put all its Bots in one Entry file.

Done when the tick cost check is clean with headroom, and a local Game shows the Bot doing what the role asks.

## 6. Save it

Add a Revision that changes only the Program; the Build stays that of the latest Revision:

```bash
positrontanks designs revise <DESIGN_ID> --program <name>.ptk --notes "<what the Program does or changed>" --json
```

To save a Build and Program together, add `--build <name>.build.json`; to create a new design with this Program, use `designs create ... --program <name>.ptk` as in the create-bot-design skill. Revisions are immutable, and an Entry keeps the Revision it was entered with, so re-enter a Game to play the new one.

The JSON output is the new Revision; its `number` is the Revision number. A rejection exits 1 with every problem on stderr, Program problems as `<name>.ptk:<line>:<column>: <message>`: fix them all, rerun step 5, and save again. Exit code 3 means you are not signed in to that server.

Optionally, check the saved Revision on the server as well. Only some servers offer it, usually a local one:

```bash
positrontanks server info --json
positrontanks designs tick-cost <DESIGN_ID> --ticks 100 --json
```

If `features.tickCostCheck` is `false`, `designs tick-cost` answers `feature_disabled` (exit code 1); the offline check of step 5 reports the same numbers, so rely on it.

Done when the command exits 0 and you have reported the design's `id`, the new Revision number, the Tick peak against the Operation Budget, and how the Program plays the role.
