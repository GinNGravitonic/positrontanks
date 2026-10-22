# Programs are limited by a counted operation budget, not a time limit

Each Tick, a Bot's Program may perform a fixed number of operations, counted at the source level (expressions evaluated, calls, loop iterations; built-in sensor calls have documented costs), within a capped amount of persistent memory. When the budget runs out mid-Tick, the Program stops; commands already issued that Tick still apply.

A wall-clock limit (e.g. "100ms per Tick") was considered because it is easier for players to understand, but it would break determinism (ADR-0001): the same Program could finish on an idle laptop and time out on a busy server, so Games would not reproduce and local results would not match the server. Visibility is provided instead through a `budget_remaining()` built-in, per-Tick usage in CLI output and Game Records, and an endpoint that measures a tick handler's cost against a sample world.
