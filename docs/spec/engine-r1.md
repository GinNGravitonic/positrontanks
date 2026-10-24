# Simulation Rules, Ruleset r1

How the r1 engine (`packages/engine-r1`) moves Bots, resolves collisions and weapon fire, takes sensor readings and runs Programs. [v1.md §2](v1.md#2-simulation) states what the simulation does; this document fixes how, so that Players and LLM agents can predict it. Like the rest of a Ruleset, these rules are frozen once r1 is released.

The balance numbers, including the ramming constants in §5, are confirmed in [catalog-r1.md](catalog-r1.md).

---

## 1. Stats the engine reads

Rulesets declare open-ended stat sets ([ADR-0004](../adr/0004-extensibility-through-ruleset-data.md)). engine-r1 gives meaning to these, and refuses to run a Ruleset that lacks them:

| Where | Stat | Meaning |
|---|---|---|
| `chassisStats` | `mass` | Base mass in kg, greater than 0 |
| `chassisStats` | `hitPoints` | Hit Points, greater than 0 |
| `chassisStats` | `operationBudget` | Operations per Tick of the minimal Processor every Chassis includes, a whole number of at least 1 |
| `componentKinds.motor` (slot-mounted) | `force` | Drive force in newtons |
| | `maxSpeed` | Top speed in m/s |
| | `turnRate` | Turn rate in degrees/s on the bare Chassis |
| | `motorTerrain` | Per-Terrain `{speed, accel}` multipliers |
| every side-mounted kind | `armor` | Damage absorbed per hit on that side |
| any kind (optional) | `mass` | Added to the Bot's mass, in kg |
| `componentKinds.weapon` (slot-mounted) | `category` | Enum: `melee`, `projectile` or `beam` |
| | `arcWidth` | Firing Arc width in degrees, 0 to 360, centred on the Slot direction |
| | `range` | How far a shot reaches from the Bot's centre, in meters |
| | `reloadTicks` | Ticks between shots, a whole number of at least 1 |
| | `damage` | Raw damage per hit |
| | `projectileSpeed` | Projectile speed in m/s, greater than 0 for Projectile Weapons; ignored by the others |
| `componentKinds.sensor` (slot-mounted) | `kind` | Enum: `radar`, `rangefinder` or `projectileDetector` |
| | `arcWidth` | Arc width in degrees, 0 to 360, centred on the Slot direction; ignored by Rangefinders |
| | `range` | How far the sensor reaches from the Bot's centre, in meters |
| `componentKinds.processor` (optional, slot-mounted) | `operationBudget` | Operations per Tick, a whole number of at least 1 |

## 2. Figures derived from a Build

- **Mass** is the Chassis mass plus the `mass` of every installed Component, Armor included.
- **Acceleration** is the sum of the motors' `force` divided by the mass.
- **Top speed** is the lowest `maxSpeed` among the motors: the slowest motor limits the Bot.
- **Turn rate** is the highest motor `turnRate`, scaled by Chassis mass ÷ total mass, so a heavily loaded Bot turns more slowly.
- **Motor Terrain modifiers** for the whole Build (`self.motorTerrain`) are what each Terrain does to the combined figures: for speed, the lowest `maxSpeed × motor speed modifier` divided by the top speed; for acceleration, the force-weighted mean of the motors' accel modifiers. With one motor, these are just that motor's modifiers. Terrains where both are 1 are omitted.
- A Bot with no motor cannot move or turn.
- **Operation Budget** is the highest `operationBudget` of the Chassis and any installed Processor: a better Processor replaces the minimal one rather than adding to it.

## 3. Movement

Each Tick lasts `dt = 1 / tickRate` seconds. After all commands are collected:

1. The Terrain under the Bot's centre at the start of the Tick gives two multipliers: speed = Terrain `speed` × Build speed modifier, accel = Terrain `accel` × Build accel modifier.
2. The **target speed** is `throttle × top speed × speed multiplier`.
3. The Bot's speed moves towards the target by at most `acceleration × accel multiplier × dt`, speeding up or braking at the same rate. So `throttle(0)` brings a Bot to a stop, and leaving fast Terrain for slow Terrain slows the Bot gradually.
4. The **turn rate** is `turn × turn rate`, applied at once (no angular acceleration). Terrain does not affect turning.
5. The Bot turns by `turn rate × dt` and moves `speed × dt` along its Heading, both spread evenly over the Tick's substeps (§4); within each substep it turns first, then moves along its new Heading.

A Bot can turn on the spot. It never moves sideways.

## 4. Collisions

Bots cannot overlap each other, Obstacles, wrecks or the outside of the Map. Shapes are closed, so touching counts as overlapping, except that a Bot may touch the Map boundary.

The Tick is split into equal **substeps**, as many as it takes for no point of any Bot to move more than `SUBSTEP_LENGTH` (0.05 m) per substep, up to `MAX_SUBSTEPS` (100). In each substep:

1. Every Bot proposes its full move: turn and translate.
2. A Bot whose proposal overlaps the boundary, an Obstacle or a wreck is **blocked**.
3. Where two Bots' proposals overlap, the Bot that moved into the other's previous position is blocked. If both did, or neither did, both are blocked. A slower Bot that is rear-ended keeps going.
4. A blocked Bot falls back to turning in place, then to staying put, and step 2 repeats until no proposals overlap. All Bots are judged together, so the outcome does not depend on how Bots are numbered.
5. A Bot whose translation was blocked stops: its speed becomes 0 and it does not translate for the rest of the Tick, though it may still turn. It accelerates again from the next Tick.

There is no sliding along walls and no pushing: a blocked Bot simply stops.

## 5. Ramming

When a Bot's translation is blocked, it **collides** with what blocked it. The contact point is midway between the two shapes' nearest points, and the **closing speed** is the relative velocity of the two bodies along the contact normal. Against the boundary, the contact is the overshot wall at the point level with the Bot's centre.

If the closing speed is at least `MIN_RAM_SPEED` (3 m/s), the collision deals

    raw damage = RAM_DAMAGE_PER_JOULE × ½ × m × closing speed²

where `RAM_DAMAGE_PER_JOULE` is 0.01, and `m` is the reduced mass `m₁m₂ / (m₁ + m₂)` for two Bots, or the Bot's mass against anything immobile. Both parties take the same raw damage:

- A Bot takes it on the side struck: the side facing the contact point, judged from the Bot's Heading (front and rear within 45° inclusive, otherwise left or right). That side's Armor absorbs up to its value; the rest comes off its Hit Points.
- A destructible Obstacle takes it in full. The boundary, permanent Obstacles and wrecks take none.

Each pair of Bots rams at most once per substep. Friends ram each other like anyone else.

## 6. Weapons

Every shot starts from the firing Bot's **centre**, whichever Slot the weapon is in, and every aim, range and line of fire is measured from there. The Slot sets only the direction of the Firing Arc. So `range` includes the part of the Bot's own body the shot crosses: a Melee Weapon must reach past its Chassis outline to hit anything.

**Aiming.** `fire` aims at a point, along the line from the Bot's centre to it, or at a bearing relative to the Heading; `fireAbs` aims at an absolute bearing. The aim only sets the direction: a shot carries on past the point aimed at.

**Legality.** Judged against the snapshot at the start of the Tick, a shot is legal when:

1. the Bot is active, not Disabled;
2. the weapon has reloaded: its `ticksUntilReady` is 0;
3. the aim is within the Firing Arc: its bearing relative to the Heading differs from the Slot direction by at most half the `arcWidth`, inclusive. An arc of 360° covers every direction;
4. line of fire is clear. When aiming at a point, the first thing the line from the Bot's centre to that point meets, ignoring the firing Bot, must not be an Obstacle or wreck that the point lies outside. So a Bot may fire at an Obstacle, but not at a Bot behind one. A bearing has no target to be blocked from. Aiming at the Bot's own centre is illegal.

An illegal shot does nothing. Range is not part of legality: a shot at something out of range is legal, and misses.

**Firing.** Every legal shot fires at the start of the Tick, before movement, from the snapshot positions. Firing sets the weapon's `ticksUntilReady` to its `reloadTicks`; at the end of every Tick, each `ticksUntilReady` above 0 drops by 1. So a weapon fires at most once every `reloadTicks` Ticks, and every Tick when that is 1.

- **Melee and Beam** shots hit at once. Each travels in a straight line from the Bot's centre, up to `range` meters, and hits the first Bot, wreck, Obstacle or Map boundary it meets in the snapshot. Every such shot is traced before any of their damage is applied, so two Bots that Disable each other in the same Tick both fire. The two categories resolve alike; they differ in their stats.
- **Projectiles** are points launched from the Bot's centre at `projectileSpeed` along the aim, moving from the Tick they are fired. They move in step with the Bots: in each substep (§4), after the Bots move, every Projectile advances by its share of the Tick's travel and hits the first Bot, wreck, Obstacle or boundary its path meets. A Tick in which no Bot moves is a single substep. A Projectile that has travelled `range` meters without hitting anything is spent. Projectiles pass through each other.

**Hits** are purely geometric. A Bot takes the weapon's `damage` on the side struck, judged from the point where the shot meets its outline (as for ramming, §5), and that side's Armor absorbs up to its value. A destructible Obstacle takes the damage in full. Permanent Obstacles, wrecks and the boundary stop the shot and take nothing. Shots hit Friends like Foes, but a Bot's own shots pass through it, and through its wreck.

## 7. Damage and Disabling

- Damage dealt is capped at the target's remaining Hit Points. Each damage event records the raw damage, the part Armor absorbed, the damage dealt, the side struck, the impact point and the absorbing entity (always the Chassis in r1).
- A Bot at 0 Hit Points is **Disabled** (`destroyed`) at once, mid-Tick: it stops dead, its commands are cleared, and it becomes an indestructible wreck in place ([language-r1.md §10.4](language-r1.md#104-disabled-bots)).
- A destructible Obstacle at 0 Hit Points still blocks movement and shots for the rest of the Tick, taking no more damage, and is gone from the next.
- `stopped` is a Bot status reserved for later Rulesets (overheating). r1 never enters it.

## 8. Game start

- The world's random stream is stream 0 of the Game seed; each Bot's `random()` stream is its Bot id (from 1).
- Bots are numbered from 1 in Entry order, then in order within each Entry.
- **Spawn Zones**: Entries are assigned zones by seeded draw, largest Entry first (ties in Entry order), each uniformly among the remaining zones whose capacity holds it.
- **Placement**: each Bot, in id order, gets a uniformly random centre inside its zone's bounding box, retried until the centre is inside the zone and the Bot, facing the zone's Heading, lies within the Map without touching any Obstacle or Bot already placed. After `SPAWN_ATTEMPTS` (1,000) tries the Game cannot start.

## 9. Sensors

A sensor looks from the Bot's **centre**, whichever Slot it is in, like a weapon (§6). The Slot sets only the direction of the sensor's arc. A sensor **covers** a point when the point is within `range` meters of the Bot's centre and its bearing from the centre is within the sensor's arc: it differs from the Slot direction by at most half the `arcWidth`, inclusive, as for a Firing Arc. Every distance and bearing a sensor reports is measured from the Bot's centre too, as `distanceTo` and `bearingTo` are, so a Program can aim at what it sees with no correction for where the Slot is. Readings describe the snapshot at the start of the Tick.

- **Radar** sees another Bot that is not Disabled when one of the Bot's Radars covers the other Bot's centre with **line of sight**: the straight line between the two Bots' centres, ends included, touches no Obstacle and no wreck. Live Bots do not block line of sight. `scan()` merges every Radar's contacts into one list in Bot id order, without duplicates. `isFoe` is true for Bots of other Entries.
- **Rangefinder** casts a single ray from the Bot's centre along its Slot direction, up to its `range`, ignoring the Bot itself. It reports the distance to the first Bot, Obstacle, wreck or Map boundary the ray meets, as for a weapon's shot (§6); wrecks are reported as `"obstacle"`. With nothing within range, it reports `null`.
- **Projectile Detector** reports, in Projectile id order, each Projectile that one of the Bot's detectors covers and that is on a **collision course**: carrying on as it is, with every Bot and Obstacle staying still, the first thing it would meet within its remaining range is this Bot. A Projectile that would first hit another Bot, an Obstacle, a wreck or the boundary, or would be spent first, is not reported, and neither are the Bot's own Projectiles, which pass through it. `bearing` is that of the Projectile's current position; `ticksToImpact` is the Tick, counting the coming one as 1, in which it would hit: the distance to impact divided by `projectileSpeed / tickRate`, rounded up, and at least 1. Melee and Beam shots are never detected.

## 10. Programs

Each Bot's Program runs in the r1 interpreter ([language-r1.md](language-r1.md)).

- **Game start**: after placement (§8), each Program is checked against the Bot's Build, then its init phase runs, in Bot id order, with the init budget (`initBudgetMultiplier` × the Operation Budget). A Program that halts in its init phase Disables its Bot (`programHalted`) before Tick 1.
- **Each Tick**: every active Bot's `tick()` runs, in Bot id order, with its Operation Budget, against the snapshot at the start of the Tick. No Program sees another's commands; built-ins only read the world. Calling a sensor again in the same Tick returns the same reading.
- **Commands**: `throttle` and `turn` clamp their argument to [-1, 1]. `fire` and `fireAbs` judge legality against the snapshot (§6) and record the aim only when legal; the last legal aim per weapon is fired. Once every Program has run, the Tick resolves as §§3–7 describe.
- **Halting**: a Program that halts at the end of its `tick()` (over the memory cap) Disables its Bot at once, before the Tick resolves, so that Tick's commands from it are dropped.
- **`map.obstacles`** lists the live Obstacles in Map order, then wrecks in Bot id order, each with id `wreck:<Bot id>`, `destructible: false` and the Bot's outline at the moment it was Disabled.
- `terrainAt` and `checkTerrain` are runtime errors for points outside the Map; points on the boundary are on it.
