# Floating-point numbers with our own deterministic math functions

The simulation and the Aumohta language use ordinary IEEE-754 doubles, but never call `Math.sin`, `Math.cos`, `Math.atan2`, `Math.sqrt`-adjacent transcendental functions, or any other built-in whose result the JavaScript spec leaves implementation-defined. Instead, each Ruleset's engine ships and pins its own implementations, and Programs get the same functions as built-ins.

Basic arithmetic is bit-identical across JavaScript engines, but the transcendental functions are not, so a Node upgrade could silently change how a frozen Ruleset plays, breaking ADR-0001 and the promise that old Rulesets stay playable. Fixed-point arithmetic was rejected because its rounding behaviour is confusing to players and LLMs writing Programs.
