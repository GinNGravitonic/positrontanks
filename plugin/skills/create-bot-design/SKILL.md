---
name: create-bot-design
description: Design a Positron Tanks Bot (a Build of Chassis, Components and Armor from a Ruleset's Parts Catalog) within a Point Budget and save it to a server's Garage as a Bot Design with the API CLI. Use when creating a new Bot Design, changing a design's Build, or fixing a Build the runner or server rejected.
---

# Create a Bot Design

A Bot Design is a Build plus a Program, saved in your Garage on a server. The Build is one JSON object: a Chassis, the Components in its Slots and Armor on each side. You choose the parts from the Ruleset's Parts Catalog, write the Build file, check its cost locally with `positrontanks run`, then save it with `positrontanks designs create` (or `designs revise` for a new Revision of a design you own).

This skill covers the Build. The server requires a Program too, so it saves the design with the bundled idle Program, [`idle.ptk`](idle.ptk), which does nothing; write a real Program with the write-a-Program skill and save it as a new Revision.

This skill assumes the `positrontanks` CLI is installed (`ptanks` is its alias). Saving also needs a CLI profile signed in to the target server.

## 1. Pin down the brief

Settle, from the request or by asking:

- **Point Budget**: the most the Entry may cost, usually the Game's `pointBudget` (`positrontanks games show <GAME_ID> --json`). It must lie within the Ruleset's range (100 to 800 in r1).
- **Bots per Entry**: an Entry's cost is the sum of its Bots' Build costs, so a design for a 3-Bot Entry gets about a third of the Budget. Each Bot is a Bot Design of its own; one design may be entered more than once.
- **Role**: what the Bot does, such as a long-range sniper, a fast flanker, a melee rammer or an armored tank. A Program plays it, so the role sets which weapons, sensors and Processor it needs.
- **Ruleset**: the Ruleset the design is for, default the latest (`r1`). A design belongs to one Ruleset.

Done when you can state the design's cost ceiling (the Point Budget divided among the Entry's Bots), its role and the Ruleset.

## 2. Look up the Parts Catalog

Part ids, Slot ids and costs come from the Ruleset. With a server (no sign-in needed):

```bash
positrontanks rulesets show r1 --json
positrontanks rulesets parts r1 --json
positrontanks rulesets docs r1 catalog
```

`rulesets show` gives `pointBudget` (`min` and `max`). `rulesets parts` gives `chassis` (each with `cost`, `stats` and `slots`, every Slot an `id` and a `type`) and `components` (each with `kind`, `cost`, `slotTypes` and `stats`). `rulesets docs ... catalog` is the same catalog as prose, with the balance reasoning and worked reference Builds; read it before an unusual design.

Offline, the r1 catalog is:

| Chassis | Cost | Hit Points | Mass (kg) | Slots (`id`: type) |
| --- | --- | --- | --- | --- |
| `scout` | 40 | 80 | 50 | `gun`: weapon, `eye`: sensor, `drive`: motor, `bay`: utility |
| `rover` | 70 | 160 | 100 | `leftGun`, `rightGun`: weapon; `eye`, `rearEye`: sensor; `drive`: motor; `bay`: utility |
| `wedge` | 80 | 220 | 140 | `prow`: weapon; `eye`: sensor; `leftDrive`, `rightDrive`: motor; `bay`: utility |
| `brawler` | 110 | 300 | 180 | `nose`, `leftGun` (faces left), `rightGun` (faces right): weapon; `eye`, `rearEye`: sensor; `leftDrive`, `rightDrive`: motor; `bay`: utility |
| `juggernaut` | 170 | 500 | 300 | `leftNose`, `rightNose`, `leftGun` (left), `rightGun` (right), `tail` (rear): weapon; `eye`, `topEye`, `rearEye` (rear): sensor; `leftDrive`, `rightDrive`: motor; `bay1`, `bay2`: utility |

Slots face forward unless marked. Every Chassis has the minimal Processor (1,000 operations per Tick) built in.

| Kind | Component (cost) |
| --- | --- |
| Weapon, melee | `spike` (12), `saw` (25), `hammer` (35) |
| Weapon, projectile | `pelletGun` (12), `autocannon` (28), `rocketPod` (40), `cannonTurret` (55, fires in any direction) |
| Weapon, beam | `laser` (40), `beamTurret` (60, fires in any direction), `lance` (60) |
| Sensor | `rangefinder` (5), `shortRadar` (10), `detector` (15, Projectile Detector), `radar` (20), `longRadar` (25), `domeRadar` (30, all round) |
| Motor | `wheels` (12), `walker` (20), `tracks` (25), `hover` (30) |
| Utility (Processor) | `coprocessor` (15, 2,000 ops), `fastProcessor` (35, 4,000 ops), `superProcessor` (70, 8,000 ops) |
| Armor (one per side) | `lightPlate` (5, absorbs 2 per hit), `mediumPlate` (12, absorbs 4), `heavyPlate` (22, absorbs 7) |

Done when every part you plan to use is in the catalog and you know its cost.

## 3. Choose the parts

Pick a Chassis, then fill Slots and sides until the role is covered, adding up costs as you go. Then trade parts until the total fits the cost ceiling.

- **The minimum**: a Bot that can fight needs a weapon, a sensor and a motor. Without a motor it cannot move or turn; without a sensor its Program cannot find a target. The cheapest such r1 Build is 69 points (Scout, Spike, Rangefinder, Wheels).
- **Empty Slots are allowed and cost nothing.** Spend on what the role uses.
- **Weapons**: many light hits (Pellet Gun, Saw) do the most damage against bare sides but are blunted hardest by Armor; few heavy hits (Hammer, Rocket Pod, Lance) ignore Armor but miss more. Projectiles can be dodged; Beams cannot but cost more per damage. Fixed weapons fire only within their arc of the Slot's direction, so the whole Bot turns to aim; a turret fires anywhere, at about double the cost and mass. Melee range counts from the Bot's centre, so a big Chassis loses most of a Spike's or Saw's reach.
- **Sensors**: match the sensor's range to the weapon's (a Lance at 70 m wants a `longRadar`). A rear or all-round sensor covers flanking. A `detector` lets a Program dodge Projectiles.
- **Motors**: acceleration is the motors' total force divided by the Bot's mass; top speed is the slowest motor's; turn rate is the best motor's, scaled by Chassis mass over total mass. So a heavy Bot needs strong motors (Tracks, Walker Legs), and mixing motors makes the Bot as slow as the slowest. Wheels bog down on sand and mud; Tracks, Walker Legs and Hover Fans cope.
- **Armor and mass**: every part adds mass, Armor and heavy weapons most (Heavy Plate is 35 kg), and mass slows acceleration and turning. Armor the sides that face the enemy: the front for a Bot that charges, all round for a slow tank.
- **Processor**: a Processor replaces the built-in one rather than adding to it. A simple Program fits in 1,000 operations per Tick; buy a better Processor only for a Program that plans paths or tracks many targets.
- **Slot ids are names the Program uses.** A weapon or sensor is addressed by its Slot id (`leftGun`, `eye`), so a Program written for one Build works for another only where the Slot ids match.

Write `<name>.build.json`:

```json
{
  "chassis": "rover",
  "components": { "leftGun": "autocannon", "rightGun": "autocannon", "eye": "radar", "rearEye": "detector", "drive": "wheels", "bay": "coprocessor" },
  "armor": { "front": "mediumPlate", "left": "lightPlate", "right": "lightPlate", "rear": null }
}
```

That Build costs 70 + 28 + 28 + 20 + 15 + 12 + 15 + 12 + 5 + 5 = 210 points.

### Format rules

The validator is strict: unknown fields are errors, and every problem is reported with a path such as `build.components.leftGun`.

- **`chassis`**: a Chassis id.
- **`components`**: an object from Slot id to Component id. Every key must be a Slot of that Chassis, and the Component must fit the Slot's type (weapons in `weapon` Slots, sensors in `sensor` Slots, motors in `motor` Slots, Processors in `utility` Slots). Leave an empty Slot out; do not set it to `null`.
- **`armor`**: all four sides, `front`, `left`, `right` and `rear`, each an Armor id or `null` for none.
- **Cost**: the Chassis plus every installed Component and Armor plate. The server refuses a design costing more than the Ruleset's largest Point Budget (800 in r1), since no Game could take it; a Game refuses an Entry costing more than its own Point Budget.

Done when the file follows every format rule and your sum is within the cost ceiling.

## 4. Check it locally

Wrap the Build in a one-Bot Entry file, `<name>.entry.json`, with the idle Program:

```json
{
  "ruleset": "r1",
  "bots": [{ "name": "Check", "build": <the Build>, "program": "function tick() {}" }]
}
```

Then play a one-Tick Game on the bundled empty Map, [`check.map.json`](check.map.json), with the cost ceiling as the Point Budget. It checks the Build exactly as the server does, and the Entry's cost against the Budget:

```bash
positrontanks run --map <this skill's folder>/check.map.json --entry <name>.entry.json --point-budget <cost ceiling> --unthrottled --time-limit 1 --json --out <a scratch folder>
```

On exit code 1, stderr lists every problem: fix each reported path, or, for `the Entry costs N points, over the Point Budget of M`, swap parts down until it fits, and run it again. Done when the run exits 0; its JSON output's `costs` is the Build's cost, which should match your sum.

To check a whole Entry of several designs at once, put all its Bots in one Entry file and run it the same way with the Game's Point Budget.

## 5. Save it

Create the design, with the bundled idle Program:

```bash
positrontanks designs create --name "<design name>" --build <name>.build.json --program <this skill's folder>/idle.ptk --ruleset r1 --description "<what the Bot is for>" --json
```

The name is 1-64 characters. The JSON output is the created design; its `id` is what Entries use (`games enter <GAME_ID> --bot <Bot Name>=<DESIGN_ID>`), and `latestRevision.cost` is the Build's cost.

To change a design you own, add a Revision instead. Revisions are immutable, and an Entry keeps the Revision it was entered with. `designs revise` keeps the latest Revision's Program when only `--build` is given, and its Build when only `--program` is given:

```bash
positrontanks designs revise <DESIGN_ID> --build <name>.build.json --notes "<what changed>" --json
```

To edit an existing design's Build, read it from `positrontanks designs show <DESIGN_ID> --json` (`latestRevision.build`).

A rejection exits 1 with every problem on stderr, one `path: message` per line: fix them all, rerun step 4, and save again. Exit code 3 means you are not signed in to that server.

Done when the command exits 0 and you have reported the design's `id`, its cost, and its Revision number when you revised it. Until a real Program replaces the idle one, the Bot only sits still: say so, and point to the write-a-Program skill.
