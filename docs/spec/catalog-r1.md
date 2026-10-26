# Parts Catalog and Balance, Ruleset r1

The starter Parts Catalog and balance numbers for Ruleset r1. [v1.md §5](v1.md#5-rulesets-and-the-parts-catalog) fixes the structure, the Ruleset schema in `packages/ruleset-data/src/ruleset.ts` fixes the data shape, and [engine-r1.md](engine-r1.md) gives each stat its meaning. This document fixes the values. The r1 Ruleset data file (aumohta-0ka.27) transcribes them. Like the rest of a Ruleset, they are frozen once r1 is released.

Vocabulary follows [GLOSSARY.md](../../GLOSSARY.md).

---

## 1. Design intent

- **Scale.** Arenas are tens of meters across (the sample Maps are 60 × 40 and 80 × 80). Bots are 1–2.4 m long, move at 3–9 m/s and fight at 1.5–70 m.
- **Fight length.** Two evenly matched Builds at a 300-point Budget should take roughly 15–40 simulated seconds to Disable one another, so Programs that dodge, flank and retreat matter more than raw stats.
- **No dominant part.** Each choice trades against cost, mass or another stat:
  - Many light hits (Pellet Gun, Saw) out-damage everything against bare sides, and are the most blunted by Armor. Few heavy hits (Hammer, Rocket Pod, Lance) shrug off Armor but miss more and waste damage on overkill.
  - Projectiles can be dodged and detected; Beams cannot, but cost more for their damage.
  - Turrets free a slow Bot from aiming its whole body, at roughly double the cost and mass.
  - Mass slows acceleration and turning (engine-r1 §2), so Armor, heavy weapons and extra motors all have a mobility price.
- **Programs are part of the Build.** A better Processor is a real alternative to a better gun.

## 2. Global values

| Key | Value | Notes |
|---|---|---|
| `tickRate` | 10 | Confirms [v1.md §2](v1.md#time). |
| `pointBudget` | 100–800 | 100 fields one useful Scout; 800 fields a fully kitted Juggernaut plus escort, or ten armed Scouts. |
| `mapFormats` | `[1]` | |
| `slotTypes` | `weapon`, `sensor`, `motor`, `utility` | `utility` holds Processors in r1. |

The Point Budget minimum is above the cheapest Chassis (40) so that every legal Budget buys a Bot that can move, see and shoot. The maximum bounds an Entry at 20 Chassis on paper; in practice a Bot that can move, see and shoot costs at least 69 (Scout, Spike, Rangefinder, Wheels), so at most 11 per Entry, and Spawn Zone capacity limits it further.

## 3. Terrain

| Terrain | `speed` | `accel` | Character |
|---|---|---|---|
| `grass` | 1 | 1 | The baseline. |
| `road` | 1.25 | 1.2 | Fast lanes. |
| `sand` | 0.6 | 0.6 | Slows everything; Tracks, Legs and Hover cope. |
| `mud` | 0.4 | 0.4 | Nearly impassable on Wheels. |
| `ice` | 1.1 | 0.3 | Fast but slippery: slow to speed up and to brake. Tracks and Legs grip. |

Terrain does not affect turning (engine-r1 §3).

## 4. Chassis

Every Chassis includes the minimal Processor: `operationBudget` 1,000 for all five. Positions are meters in the Bot frame (x right, y down, Heading up); directions are degrees relative to the Heading.

| Chassis | Cost | Shape | Reach | Mass (kg) | Hit Points | Slots |
|---|---|---|---|---|---|---|
| Scout (`scout`) | 40 | circle r 0.5 | 0.50 | 50 | 80 | 1 weapon, 1 sensor, 1 motor, 1 utility |
| Rover (`rover`) | 70 | circle r 0.7 | 0.70 | 100 | 160 | 2 weapon, 2 sensor, 1 motor, 1 utility |
| Wedge (`wedge`) | 80 | triangle, nose 1.0 ahead, base 1.6 wide 0.6 behind | 1.00 | 140 | 220 | 1 weapon, 1 sensor, 2 motor, 1 utility |
| Brawler (`brawler`) | 110 | rectangle 1.4 × 1.8 | 1.14 | 180 | 300 | 3 weapon, 2 sensor, 2 motor, 1 utility |
| Juggernaut (`juggernaut`) | 170 | rectangle 1.8 × 2.4 | 1.50 | 300 | 500 | 5 weapon, 3 sensor, 2 motor, 2 utility |

Reach is the distance from the centre to the farthest point of the outline (`BotSpec.reach`).

### Slots

| Chassis | Slot id | Type | x | y | Direction |
|---|---|---|---|---|---|
| Scout | `gun` | weapon | 0 | -0.3 | 0 |
| | `eye` | sensor | 0 | 0 | 0 |
| | `drive` | motor | 0 | 0.3 | 180 |
| | `bay` | utility | 0.2 | 0.1 | 0 |
| Rover | `leftGun` | weapon | -0.3 | -0.5 | 0 |
| | `rightGun` | weapon | 0.3 | -0.5 | 0 |
| | `eye` | sensor | 0 | -0.2 | 0 |
| | `rearEye` | sensor | 0 | 0.5 | 180 |
| | `drive` | motor | 0 | 0.3 | 180 |
| | `bay` | utility | 0 | 0 | 0 |
| Wedge | `prow` | weapon | 0 | -0.8 | 0 |
| | `eye` | sensor | 0 | -0.3 | 0 |
| | `leftDrive` | motor | -0.4 | 0.4 | 180 |
| | `rightDrive` | motor | 0.4 | 0.4 | 180 |
| | `bay` | utility | 0 | 0.3 | 0 |
| Brawler | `nose` | weapon | 0 | -0.9 | 0 |
| | `leftGun` | weapon | -0.7 | 0 | -90 |
| | `rightGun` | weapon | 0.7 | 0 | 90 |
| | `eye` | sensor | 0 | -0.5 | 0 |
| | `rearEye` | sensor | 0 | 0.7 | 180 |
| | `leftDrive` | motor | -0.5 | 0.5 | 180 |
| | `rightDrive` | motor | 0.5 | 0.5 | 180 |
| | `bay` | utility | 0 | 0.2 | 0 |
| Juggernaut | `leftNose` | weapon | -0.5 | -1.2 | 0 |
| | `rightNose` | weapon | 0.5 | -1.2 | 0 |
| | `leftGun` | weapon | -0.9 | 0 | -90 |
| | `rightGun` | weapon | 0.9 | 0 | 90 |
| | `tail` | weapon | 0 | 1.2 | 180 |
| | `eye` | sensor | 0 | -0.8 | 0 |
| | `topEye` | sensor | 0 | 0 | 0 |
| | `rearEye` | sensor | 0 | 1.0 | 180 |
| | `leftDrive` | motor | -0.6 | 0.8 | 180 |
| | `rightDrive` | motor | 0.6 | 0.8 | 180 |
| | `bay1` | utility | -0.3 | 0.3 | 0 |
| | `bay2` | utility | 0.3 | 0.3 | 0 |

The Wedge outline is the triangle (0, -1), (0.8, 0.6), (-0.8, 0.6). Motor and utility Slot directions have no effect in r1.

## 5. Components

Every Slot-mounted Component fits only Slots of its own kind's type (weapons in `weapon` Slots, Processors in `utility` Slots, and so on).

### 5.1 Weapons

DPS is raw damage per second, `damage × tickRate / reloadTicks`, before Armor.

| Weapon | Cost | Category | Arc | Range (m) | Reload (Ticks) | Damage | DPS | Projectile speed (m/s) | Mass (kg) |
|---|---|---|---|---|---|---|---|---|---|
| Spike (`spike`) | 12 | melee | 60 | 1.5 | 10 | 30 | 30 | – | 8 |
| Saw (`saw`) | 25 | melee | 90 | 1.4 | 2 | 8 | 40 | – | 15 |
| Hammer (`hammer`) | 35 | melee | 60 | 1.8 | 15 | 70 | 46.7 | – | 30 |
| Pellet Gun (`pelletGun`) | 12 | projectile | 30 | 30 | 3 | 5 | 16.7 | 35 | 6 |
| Autocannon (`autocannon`) | 28 | projectile | 20 | 45 | 5 | 10 | 20 | 45 | 18 |
| Rocket Pod (`rocketPod`) | 40 | projectile | 20 | 60 | 25 | 55 | 22 | 18 | 22 |
| Cannon Turret (`cannonTurret`) | 55 | projectile | 360 | 40 | 6 | 10 | 16.7 | 40 | 35 |
| Laser (`laser`) | 40 | beam | 20 | 35 | 8 | 14 | 17.5 | – | 10 |
| Beam Turret (`beamTurret`) | 60 | beam | 360 | 25 | 10 | 12 | 12 | – | 25 |
| Lance (`lance`) | 60 | beam | 10 | 70 | 40 | 60 | 15 | – | 28 |

`projectileSpeed` is 0 in the data for Melee and Beam weapons, which ignore it.

Ranges are measured from the Bot's centre (engine-r1 §6), so a Melee Weapon's useful reach beyond its own outline is `range` minus the outline's distance from the centre in the firing direction:

| Melee weapon | Scout (0.5) | Rover (0.7) | Wedge prow (1.0) | Brawler nose (0.9) / side (0.7) | Juggernaut nose (1.2) / side (0.9) / tail (1.2) |
|---|---|---|---|---|---|
| Spike (1.5) | 1.0 | 0.8 | 0.5 | 0.6 / 0.8 | 0.3 / 0.6 / 0.3 |
| Saw (1.4) | 0.9 | 0.7 | 0.4 | 0.5 / 0.7 | 0.2 / 0.5 / 0.2 |
| Hammer (1.8) | 1.3 | 1.1 | 0.8 | 0.9 / 1.1 | 0.6 / 0.9 / 0.6 |

### 5.2 Sensors

| Sensor | Cost | Kind | Arc | Range (m) | Mass (kg) |
|---|---|---|---|---|---|
| Short Radar (`shortRadar`) | 10 | radar | 90 | 30 | 2 |
| Radar (`radar`) | 20 | radar | 120 | 50 | 4 |
| Dome Radar (`domeRadar`) | 30 | radar | 360 | 30 | 6 |
| Long Radar (`longRadar`) | 25 | radar | 45 | 90 | 5 |
| Rangefinder (`rangefinder`) | 5 | rangefinder | 0 (ignored) | 60 | 1 |
| Projectile Detector (`detector`) | 15 | projectileDetector | 360 | 30 | 3 |

### 5.3 Motors

| Motor | Cost | Force (N) | Max speed (m/s) | Turn rate (°/s) | Mass (kg) |
|---|---|---|---|---|---|
| Wheels (`wheels`) | 12 | 1,000 | 7 | 200 | 12 |
| Tracks (`tracks`) | 25 | 2,200 | 4.5 | 120 | 35 |
| Hover Fans (`hover`) | 30 | 700 | 9 | 240 | 8 |
| Walker Legs (`walker`) | 20 | 3,000 | 3 | 240 | 45 |

`motorTerrain` modifiers, as `speed / accel` multipliers on top of the Terrain's own (grass has none):

| Motor | road | sand | mud | ice |
|---|---|---|---|---|
| Wheels | 1.1 / 1 | 0.8 / 0.8 | 0.6 / 0.6 | 1 / 0.7 |
| Tracks | 0.9 / 1 | 1.4 / 1.4 | 1.6 / 1.6 | 1 / 2.5 |
| Hover Fans | 0.85 / 1 | 1.5 / 1.6 | 2.2 / 2.2 | 0.9 / 3 |
| Walker Legs | 0.8 / 1 | 1.4 / 1.5 | 2 / 2 | 1 / 2.5 |

So the effective speed multiplier on each Terrain (Terrain × motor) is:

| Motor | grass | road | sand | mud | ice |
|---|---|---|---|---|---|
| Wheels | 1 | 1.38 | 0.48 | 0.24 | 1.1 |
| Tracks | 1 | 1.13 | 0.84 | 0.64 | 1.1 |
| Hover Fans | 1 | 1.06 | 0.90 | 0.88 | 0.99 |
| Walker Legs | 1 | 1.0 | 0.84 | 0.8 | 1.1 |

### 5.4 Processors

| Processor | Cost | `operationBudget` | Mass (kg) |
|---|---|---|---|
| (built into every Chassis) | – | 1,000 | – |
| Coprocessor (`coprocessor`) | 15 | 2,000 | 2 |
| Fast Processor (`fastProcessor`) | 35 | 4,000 | 3 |
| Super Processor (`superProcessor`) | 70 | 8,000 | 4 |

Processors replace rather than add (engine-r1 §2), so a second one in the Juggernaut only helps if it is better than the first.

### 5.5 Armor

One per side at most; a side without Armor absorbs nothing.

| Armor | Cost | `armor` | Mass (kg) |
|---|---|---|---|
| Light Plate (`lightPlate`) | 5 | 2 | 8 |
| Medium Plate (`mediumPlate`) | 12 | 4 | 18 |
| Heavy Plate (`heavyPlate`) | 22 | 7 | 35 |

Armor absorbs per hit, so its worth depends on what it faces. Damage left per hit:

| | Pellet 5 | Saw 8 | Autocannon 10 | Cannon Turret 10 | Beam Turret 12 | Laser 14 | Spike 30 | Rocket 55 | Lance 60 | Hammer 70 |
|---|---|---|---|---|---|---|---|---|---|---|
| Light (2) | 3 | 6 | 8 | 8 | 10 | 12 | 28 | 53 | 58 | 68 |
| Medium (4) | 1 | 4 | 6 | 6 | 8 | 10 | 26 | 51 | 56 | 66 |
| Heavy (7) | 0 | 1 | 3 | 3 | 5 | 7 | 23 | 48 | 53 | 63 |

### 5.6 Visual size

How big clients draw each Slot-mounted Component (`visualSize`, [v1.md §5](v1.md#5-rulesets-and-the-parts-catalog)): length along the Slot direction and width across it, in meters, with the origin at the Slot. These are placeholders chosen by eye for v1's placeholder shapes. They are not stats: no engine reads them, and weapon and sensor `range` is still measured from the Bot's centre (engine-r1 §6 and §9). Each is at most the largest Chassis dimension (2.4 m, the Juggernaut's length); drawn Components may overlap one another or other Bots. Armor has no visual size.

| Component | Length (m) | Width (m) |
|---|---|---|
| Spike (`spike`) | 0.5 | 0.12 |
| Saw (`saw`) | 0.4 | 0.4 |
| Hammer (`hammer`) | 0.6 | 0.25 |
| Pellet Gun (`pelletGun`) | 0.35 | 0.1 |
| Autocannon (`autocannon`) | 0.55 | 0.15 |
| Rocket Pod (`rocketPod`) | 0.4 | 0.3 |
| Cannon Turret (`cannonTurret`) | 0.5 | 0.35 |
| Laser (`laser`) | 0.5 | 0.12 |
| Beam Turret (`beamTurret`) | 0.4 | 0.35 |
| Lance (`lance`) | 0.9 | 0.1 |
| Short Radar (`shortRadar`) | 0.2 | 0.25 |
| Radar (`radar`) | 0.25 | 0.3 |
| Dome Radar (`domeRadar`) | 0.3 | 0.3 |
| Long Radar (`longRadar`) | 0.2 | 0.45 |
| Rangefinder (`rangefinder`) | 0.15 | 0.08 |
| Projectile Detector (`detector`) | 0.2 | 0.2 |
| Wheels (`wheels`) | 0.3 | 0.8 |
| Tracks (`tracks`) | 0.4 | 0.9 |
| Hover Fans (`hover`) | 0.35 | 0.7 |
| Walker Legs (`walker`) | 0.4 | 0.8 |
| Coprocessor (`coprocessor`) | 0.15 | 0.15 |
| Fast Processor (`fastProcessor`) | 0.18 | 0.18 |
| Super Processor (`superProcessor`) | 0.2 | 0.2 |

## 6. Ramming

Confirms the constants of [engine-r1 §5](engine-r1.md#5-ramming):

| Constant | Value |
|---|---|
| `MIN_RAM_SPEED` | 3 m/s |
| `RAM_DAMAGE_PER_JOULE` | 0.01 |

Each party takes `0.01 × ½ × m × v²`. Driving into a wall at full speed on grass costs a Scout with Pellet Gun (70 kg, 7 m/s) 17 Hit Points, a Rover with twin Autocannons (191 kg, 7 m/s) 47, and a fully kitted Juggernaut (602 kg, 4.5 m/s) 61. Bumps below 3 m/s are free, so Bots can nose up to walls and each other. Ramming is a Hit Point trade, so it pays for the side with more Hit Points, and since one ram is one hit, Armor barely blunts it.

## 7. Language limits

Confirms [language-r1 §8.3 and §11](language-r1.md#11-ruleset-limits):

| Key | Value |
|---|---|
| Per-Tick Operation Budget | Per Processor; the minimal one gives 1,000 |
| `initBudgetMultiplier` | 50 |
| `memoryCells` | 10,000 |
| `maxCallDepth` | 64 |
| `maxCollectionLength` | 10,000 |
| `maxSourceBytes` | 65,536 |
| `logLinesPerTick` | 50 |
| `logLineLength` | 200 |

`initBudgetMultiplier` rises from the provisional 20 to 50, so the init phase can precompute a coarse Terrain grid of the Map (around 1,600 cells at a 2 m pitch on an 80 × 80 Map, at about 20 operations per cell with `terrainAt`) within the minimal Processor's 50,000 operations.

## 8. Reference Builds

Derived with engine-r1's `deriveBotSpec` from this catalog, on grass. Wall ram is the damage a Bot takes driving into a wall at top speed.

| Build | Cost | Mass (kg) | HP | Top speed (m/s) | Accel (m/s²) | Turn (°/s) | Armor F/L/R/R | Ops/Tick | Wall ram | Raw DPS |
|---|---|---|---|---|---|---|---|---|---|---|
| Scout: Pellet Gun, Short Radar, Wheels | 74 | 70 | 80 | 7 | 14.3 | 143 | 0/0/0/0 | 1,000 | 17 | 16.7 |
| Scout: Laser, Radar, Hover Fans, Light front | 135 | 80 | 80 | 9 | 8.8 | 150 | 2/0/0/0 | 1,000 | 32 | 17.5 |
| Rover: 2 Autocannons, Radar, Detector, Wheels, Coprocessor, Medium front, Light sides | 210 | 191 | 160 | 7 | 5.2 | 105 | 4/2/2/0 | 2,000 | 47 | 40 |
| Wedge: Hammer, Radar, 2 Wheels, Heavy front | 181 | 233 | 220 | 7 | 8.6 | 120 | 7/0/0/0 | 1,000 | 57 | 46.7 |
| Brawler: Saw, 2 side Autocannons, Radar, Detector, 2 Tracks, Coprocessor, Medium all round, Light rear | 332 | 372 | 300 | 4.5 | 11.8 | 58 | 4/4/4/2 | 2,000 | 38 | 80 |
| Brawler: Cannon Turret, Dome Radar, 2 Tracks, Fast Processor, Heavy front, Medium elsewhere | 338 | 383 | 300 | 4.5 | 11.5 | 56 | 7/4/4/4 | 4,000 | 39 | 16.7 |
| Juggernaut: Rocket Pod, Lance, 2 side Autocannons, tail Pellet Gun, Long + Dome Radar, Detector, 2 Tracks, Fast Processor, Heavy front and sides, Medium rear | 571 | 602 | 500 | 4.5 | 7.3 | 60 | 7/7/7/4 | 4,000 | 61 | 93.7 |
