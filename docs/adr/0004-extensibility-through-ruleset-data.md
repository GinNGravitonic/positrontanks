# Extensibility through Ruleset-versioned data and engines

Planned future mechanics (heat management, damage to individual Components) must be addable as new Ruleset versions without restructuring. So, from v1:

- Component and Chassis stats are open-ended sets of stats defined by each Ruleset, not fixed fields; new stats (`heatPerShot`, `heatLimit`, a Component's own `hitPoints`) are just new keys.
- The built-in values a Program can read about its own Bot (`self.*`) are defined per Ruleset by its language spec; a Program referencing a value its Ruleset doesn't define fails validation when the Revision is saved.
- Every damage event records the side struck, the point of impact, and what absorbed it (always the Chassis in v1), so a future Ruleset can route hits to the Component in the nearest Slot.
- Bots have a general "stopped" status distinct from Disabled, unused in v1, ready for overheating.

These look like over-generalisation in v1; they are deliberate. Do not "simplify" them into fixed fields.
