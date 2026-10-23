# Simulation Rules, Ruleset r1

How the r1 engine (`packages/engine-r1`) moves Bots and resolves collisions. [v1.md §2](v1.md#2-simulation) states what the simulation does; this document fixes how, so that Players and LLM agents can predict it. Like the rest of a Ruleset, these rules are frozen once r1 is released.

Constants marked _provisional_ are balance numbers to confirm in the starter catalog session (aumohta-0ka.3).

---

## 1. Stats the engine reads

Rulesets declare open-ended stat sets ([ADR-0004](../adr/0004-extensibility-through-ruleset-data.md)). engine-r1 gives meaning to these, and refuses to run a Ruleset that lacks them:

| Where | Stat | Meaning |
|---|---|---|
| `chassisStats` | `mass` | Base mass in kg, greater than 0 |
| `chassisStats` | `hitPoints` | Hit Points, greater than 0 |
| `componentKinds.motor` (slot-mounted) | `force` | Drive force in newtons |
| | `maxSpeed` | Top speed in m/s |
| | `turnRate` | Turn rate in degrees/s on the bare Chassis |
| | `motorTerrain` | Per-Terrain `{speed, accel}` multipliers |
| every side-mounted kind | `armor` | Damage absorbed per hit on that side |
| any kind (optional) | `mass` | Added to the Bot's mass, in kg |

Weapon and sensor stats are added by the tasks that implement them.

## 2. Figures derived from a Build

- **Mass** is the Chassis mass plus the `mass` of every installed Component, Armor included.
- **Acceleration** is the sum of the motors' `force` divided by the mass.
- **Top speed** is the lowest `maxSpeed` among the motors: the slowest motor limits the Bot.
- **Turn rate** is the highest motor `turnRate`, scaled by Chassis mass ÷ total mass, so a heavily loaded Bot turns more slowly.
- **Motor Terrain modifiers** for the whole Build (`self.motorTerrain`) are what each Terrain does to the combined figures: for speed, the lowest `maxSpeed × motor speed modifier` divided by the top speed; for acceleration, the force-weighted mean of the motors' accel modifiers. With one motor, these are just that motor's modifiers. Terrains where both are 1 are omitted.
- A Bot with no motor cannot move or turn.

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

If the closing speed is at least `MIN_RAM_SPEED` (_provisional_: 2 m/s), the collision deals

    raw damage = RAM_DAMAGE_PER_JOULE × ½ × m × closing speed²

where `RAM_DAMAGE_PER_JOULE` is _provisional_ 0.04, and `m` is the reduced mass `m₁m₂ / (m₁ + m₂)` for two Bots, or the Bot's mass against anything immobile. Both parties take the same raw damage:

- A Bot takes it on the side struck: the side facing the contact point, judged from the Bot's Heading (front and rear within 45° inclusive, otherwise left or right). That side's Armor absorbs up to its value; the rest comes off its Hit Points.
- A destructible Obstacle takes it in full. The boundary, permanent Obstacles and wrecks take none.

Each pair of Bots rams at most once per substep. Friends ram each other like anyone else.

## 6. Damage and Disabling

- Damage dealt is capped at the target's remaining Hit Points. Each damage event records the raw damage, the part Armor absorbed, the damage dealt, the side struck, the impact point and the absorbing entity (always the Chassis in r1).
- A Bot at 0 Hit Points is **Disabled** (`destroyed`) at once, mid-Tick: it stops dead, its commands are cleared, and it becomes an indestructible wreck in place ([language-r1.md §10.4](language-r1.md#104-disabled-bots)).
- A destructible Obstacle at 0 Hit Points still blocks for the rest of the Tick and is gone from the next.
- `stopped` is a Bot status reserved for later Rulesets (overheating). r1 never enters it.

## 7. Game start

- The world's random stream is stream 0 of the Game seed; each Bot's `random()` stream is its Bot id (from 1).
- Bots are numbered from 1 in Entry order, then in order within each Entry.
- **Spawn Zones**: Entries are assigned zones by seeded draw, largest Entry first (ties in Entry order), each uniformly among the remaining zones whose capacity holds it.
- **Placement**: each Bot, in id order, gets a uniformly random centre inside its zone's bounding box, retried until the centre is inside the zone and the Bot, facing the zone's Heading, lies within the Map without touching any Obstacle or Bot already placed. After `SPAWN_ATTEMPTS` (1,000) tries the Game cannot start.
