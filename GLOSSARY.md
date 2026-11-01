# Positron Tanks

Positron Tanks is a programmable robot-combat game. Players design bots from a point-budgeted parts catalog, program them in a small language, and enter them into fully automatic battles that they can watch but not influence.

## Players and their bots

**Player**:
An account holder who designs bots and enters games; may be a human or an LLM agent.
_Avoid_: User, account, competitor

**Garage**:
A player's private collection of Bot Designs.
_Avoid_: Inventory, hangar

**Bot Design**:
A reusable blueprint consisting of a Build and a Program, authored against one Ruleset version.
_Avoid_: Chassis design, robot, loadout

**Build**:
The physical half of a Bot Design: its Chassis plus installed Components and Armor, without the Program; visible to everyone once a Game is Running.
_Avoid_: Loadout, configuration, component list

**Revision**:
An immutable snapshot of a Bot Design or Map; editing creates a new Revision, and Entries and Games always reference a specific Revision. Revisions used by any Game are never deleted, only archived along with their design or Map.
_Avoid_: Version (reserved for Rulesets), snapshot

**Emblem**:
A Player's optional image, displayed alongside all of that Player's Bots; always the Player's current one, also when rewatching earlier Games.
_Avoid_: Team icon, logo, avatar

**Program**:
The code, written in the Positron Tanks language, that controls every Bot built from a Bot Design; visible only to its owner.
_Avoid_: Script, AI, brain

**Component**:
A part from the Parts Catalog (weapon, armor, motor, sensor, etc.) with a point cost.
_Avoid_: Part, module, item

**Chassis**:
The body a Bot Design is built on, which sets its size, shape, base mass, hit points, and Slots; every Bot Design has exactly one.
_Avoid_: Frame, hull, body

**Slot**:
A mounting point on a Chassis with a type (weapon, sensor, motor, utility), a position, and a facing, into which a compatible Component is installed.
_Avoid_: Hardpoint, socket, mount

**Hit Points**:
The amount of damage a Chassis can absorb before the Bot is Disabled.
_Avoid_: Health, HP, structure

**Armor**:
Protection bought separately for each side of a Bot (front, left, right, rear) that reduces damage from hits striking that side.
_Avoid_: Shield, plating

**Melee Weapon**:
A weapon that hits only at contact range.
_Avoid_: Close-combat weapon

**Projectile Weapon**:
A weapon whose shots travel across the Map over several Ticks and can be dodged or blocked.
_Avoid_: Gun, ballistic weapon

**Beam Weapon**:
A weapon that hits instantly along a straight line within its range.
_Avoid_: Laser, hitscan weapon

**Turret**:
A weapon Component variant with a wide Firing Arc, costing more points and mass than its fixed counterpart.
_Avoid_: Gimbal, rotating mount

**Firing Arc**:
The range of angles, relative to a Bot's Heading, within which a mounted weapon can hit a target.
_Avoid_: Field of fire, cone

**Processor**:
The Component that sets a Bot's Operation Budget; every Chassis includes a minimal one, and better ones are bought with points.
_Avoid_: CPU, brain, computer

**Operation Budget**:
The number of operations a Program may perform in a single Tick, set by the Bot's Processor.
_Avoid_: CPU time, instruction limit, gas

## Games

**Game**:
A single battle on one Map under one Ruleset version, from creation through to result.
_Avoid_: Match, battle, round

**Initiator**:
The Player who creates a Game and chooses its Map, Point Budget, player count, and time limit.
_Avoid_: Host, creator, owner

**Point Budget**:
The maximum total point cost a single Entry may have in a given Game; chosen by the Initiator within a range set by the Ruleset.
_Avoid_: Point limit, cap, weight class

**Entry**:
What a Player submits to a Game: one or more Bot Designs whose combined cost fits within the Point Budget. A Player has at most one Entry in a Game.
_Avoid_: Submission, team, roster

**Bot**:
A live instance of a Bot Design inside a running Game; one design entered twice yields two Bots.
_Avoid_: Robot, unit

**Bot Name**:
The display name a Player gives each Bot when building an Entry; unique within a Game.
_Avoid_: Callsign, label

**Pace**:
Whether a Game is simulated in real time (one simulated second per real second) or unthrottled (as fast as possible); chosen by the Initiator.
_Avoid_: Speed, mode

**Disabled**:
The state of a Bot whose Hit Points have reached zero or whose Program has halted; it no longer acts or counts toward its Player's survival, and remains on the Map as a wreck Obstacle.
_Avoid_: Dead, destroyed, killed

**Friend**:
From a Bot's point of view, any other Bot from the same Entry; Friends can still damage each other.
_Avoid_: Ally, teammate

**Foe**:
From a Bot's point of view, any Bot from a different Entry.
_Avoid_: Enemy, opponent

**Map**:
The arena a Game is played in, including its boundaries and Obstacles; versioned by Map Format, independently of Rulesets.
_Avoid_: Arena, level, board

**Map Format**:
The versioned structure of a Map; each Ruleset declares which Map Formats it supports.
_Avoid_: Map version, map schema

**Spawn Zone**:
An area of a Map, with a starting Heading and a capacity, where one Entry's Bots are placed when a Game starts.
_Avoid_: Start position, base

**Terrain**:
A Ruleset-defined ground type (e.g. road, grass, sand) that scales a Bot's maximum speed and acceleration; never blocks or damages.
_Avoid_: Ground, surface, tile

**Base Terrain**:
The Terrain covering every part of a Map not inside a Terrain Region.
_Avoid_: Default terrain, background

**Terrain Region**:
A polygon or circle on a Map painted with one Terrain; where regions overlap, the later-listed one wins.
_Avoid_: Terrain zone, patch, area

**Obstacle**:
An immobile feature of a Map that blocks movement and weapons; may be permanent or destructible.
_Avoid_: Wall, terrain, block

**Heading**:
The direction a Bot is facing, in degrees clockwise from "up" the Map; Bots move only forward or backward along their Heading and turn to change it.
_Avoid_: Facing, orientation, direction

**Tick**:
One discrete step of simulated time in which every Bot's Program runs and all commands resolve simultaneously.
_Avoid_: Turn, frame, step

**Winner**:
The last Player with any Bot not Disabled; at the time limit, the Player whose Bots inflicted the most damage on Foes.
_Avoid_: Victor, champion

**Draw**:
A Game result with no Winner, reached when the time limit expires and all tiebreaks are equal.

**Game Record**:
Everything needed to reproduce a Game exactly: Ruleset version, Map, Entries (including Programs), starting positions, and random seed; held only by the server that played it.
_Avoid_: Replay file, log

**Replay**:
The full history of events in a Game together with every participating Bot Design's component list, but never its Program; what Players and Spectators use to rewatch a Game.
_Avoid_: Recording, playback, game log

**Spectator**:
Anyone watching a Game they have no Entry in.
_Avoid_: Viewer, observer, audience

**Open** / **Running** / **Finished** / **Cancelled**:
The states of a Game: accepting Entries; being simulated; ended with a result; ended without being played.
_Avoid_: Pending, active, complete, aborted

## Rules and versioning

**Ruleset**:
A single versioned bundle of the Parts Catalog, the game rules, and the language specification; the unit of compatibility between Bot Designs and Games.
_Avoid_: Version, edition, patch

**Parts Catalog**:
The list of Components available under a Ruleset, with their stats and point costs.
_Avoid_: Shop, store, parts list
