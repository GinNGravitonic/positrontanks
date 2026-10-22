# Fixed-tick, simultaneous, deterministic simulation on a continuous 2D plane

Games are simulated in discrete Ticks on a top-down continuous 2D plane with simplified kinematics (acceleration, max speed, turn rate, mass, simple collision shapes). Each Tick, every Bot's Program runs against the same world snapshot and all commands resolve simultaneously. Given a Game Record, the simulation reproduces the Game exactly.

We chose this over a full real-time physics engine (hard to make deterministic and fair, hard for LLM players to reason about, forces concurrency and wall-clock time into the language) and over a turn-based board game (first-mover advantage, less like a battle). The hybrid keeps continuous movement and simultaneous action while giving replays, debuggability, and a simple "run once per Tick" model for Programs.

## Consequences

- Simulation math must be platform-independent (fixed-point or integer, no `Math.random`); randomness comes only from the Game's seed.
- Programs see Tick counts, never wall-clock time.
