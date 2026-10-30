---
name: create-map
description: Author a Positron Tanks Map (Map Format 1 JSON) and save it to a server with the API CLI. Use when creating a new Map, revising an existing Map, or fixing a Map file the runner or server rejected.
---

# Create a Map

A Map is one JSON file in Map Format 1. You write the file, check it locally with `positrontanks run`, then upload it with `positrontanks maps create` (or `maps revise` for a new Revision of a Map you own). The same file works locally and on the server, unchanged.

This skill assumes the `positrontanks` CLI is installed (`ptanks` is its alias). Uploading also needs a CLI profile signed in to the target server.

## 1. Pin down the brief

Settle, from the request or by asking:

- **Players**: how many Entries the Map hosts. That is the Spawn Zone count, at least 2.
- **Bots per Entry**: the largest Entry a zone must hold. That is each zone's `capacity`.
- **Character**: open or cramped, symmetric or not, which Terrains, any destructible cover.
- **Ruleset**: the Ruleset the Map is played under, default the latest (`r1`).

Done when you can state the Spawn Zone count, every zone's capacity, and the Ruleset.

## 2. Look up the Ruleset's Terrains

Terrain names must exist in the Ruleset's Terrain table. With a server:

```bash
positrontanks rulesets terrains r1 --json
positrontanks rulesets show r1 --json
```

`rulesets show` lists `mapFormats`; it must include `1`. Offline, the r1 Terrains are `grass` (baseline), `road` (fast), `sand` (slow), `mud` (very slow, worst on Wheels) and `ice` (fast, poor acceleration); `positrontanks run` rejects any other name.

Done when every Terrain you plan to use is in the table.

## 3. Write the Map file

Write `<name>.map.json`. Start from this two-Player template and reshape it:

```json
{
  "format": 1,
  "width": 60,
  "height": 40,
  "baseTerrain": "grass",
  "terrainRegions": [
    { "terrain": "road", "shape": "polygon", "points": [{ "x": 0, "y": 18 }, { "x": 60, "y": 18 }, { "x": 60, "y": 22 }, { "x": 0, "y": 22 }] },
    { "terrain": "sand", "shape": "circle", "x": 30, "y": 20, "radius": 6 }
  ],
  "obstacles": [
    { "id": "pillar", "destructible": false, "shape": "circle", "x": 30, "y": 20, "radius": 2 },
    { "id": "crate-north", "destructible": true, "hitPoints": 150, "shape": "polygon", "points": [{ "x": 28, "y": 6 }, { "x": 32, "y": 6 }, { "x": 32, "y": 10 }, { "x": 28, "y": 10 }] }
  ],
  "spawnZones": [
    { "heading": 90, "capacity": 4, "shape": "polygon", "points": [{ "x": 2, "y": 10 }, { "x": 12, "y": 10 }, { "x": 12, "y": 30 }, { "x": 2, "y": 30 }] },
    { "heading": 270, "capacity": 4, "shape": "polygon", "points": [{ "x": 48, "y": 10 }, { "x": 58, "y": 10 }, { "x": 58, "y": 30 }, { "x": 48, "y": 30 }] }
  ]
}
```

### Format rules

The validator is strict: unknown fields are errors, and every problem is reported with a path such as `map.obstacles[2].hitPoints`.

- **Coordinates**: meters; the Map is `[0, width] x [0, height]`, origin top-left, **y down**. Headings are degrees clockwise from up the Map: `0` up, `90` right, `180` down, `270` left, in `[0, 360)`.
- **Geometry**: every feature is either `"shape": "circle"` with `x`, `y`, `radius > 0`, or `"shape": "polygon"` with `points`, a list of at least 3 `{x, y}`. A polygon must be simple (no edge crosses or touches another), enclose non-zero area, and never repeat a point back to back; do not close it by repeating the first point.
- **Bounds**: every feature lies entirely within the Map, edges allowed.
- **`baseTerrain`**: the Terrain wherever no region covers.
- **`terrainRegions`**: `terrain` plus a shape. Where regions overlap, the later one in the list wins, so list broad regions first and details after.
- **`obstacles`**: `id` (1-64 letters, digits, `-`, `_`; unique within the Map), `destructible`, and `hitPoints > 0` only when `destructible` is `true`. Obstacles block movement, shots and line of sight; a destructible one is removed once its Hit Points run out.
- **`spawnZones`**: `heading` (where the Entry's Bots face at the start), `capacity` (a whole number, at least 1: the most Bots one Entry may place there), plus a shape. One zone per Player; at least 2.
- **Spawn Zone clearance**: a zone may not touch or overlap any Obstacle or any other zone. Touching counts, so leave a gap.

### Server limits

The server also applies its own size limits, configured per server. The defaults are width and height at most 200, at most 64 points per polygon, and at most 100 features (Terrain Regions, Obstacles and Spawn Zones combined). The local runner does not check them.

### Design rules

- **Room to spawn**: each Bot gets a random centre inside its zone, clear of Obstacles and of Bots already placed; a Bot that finds no room spills to the nearest free spot outside the zone. Budget about `(2 x reach + 1)^2` square meters per Bot of capacity. Reach runs from 0.5 m (Scout) to 1.5 m (Juggernaut) in r1, so a zone for 4 Juggernauts needs about 64 m², such as 8 x 8.
- **Fairness**: unless the brief asks otherwise, make the Map symmetric (mirror or rotation) so every Spawn Zone has the same distance to cover, the same Terrain and the same capacity. Spawn Zones are assigned to Entries by seeded draw, so no Player chooses a side.
- **Facing**: point each zone's `heading` toward the action, usually the Map centre.
- **Cover and lanes**: give long sightlines something to break them, and leave paths at least 3 m wide between Obstacles and the boundary so the largest Chassis can pass.

Done when the file follows every format rule above and fits the brief.

## 4. Check it locally

Run a one-Tick Game with the bundled smoke Entry, [`smoke.entry.json`](smoke.entry.json): one idle Scout. It checks the Map exactly as the server checks a Game's Map: Map Format, every format rule, and Terrain names against the Ruleset.

```bash
positrontanks run --map <name>.map.json --entry <this skill's folder>/smoke.entry.json --unthrottled --time-limit 1 --out <a scratch folder>
```

On exit code 1, fix every reported path and run it again. Problems surface in stages: structure first, then geometry (bounds, Spawn Zone clearance), then Terrain names, so a fixed file can fail again on a later stage. Done when the run exits 0 and prints a `Result:` line.

This is the only early Terrain check: the server checks Terrain names only when a Game picks the Map and a Ruleset, not when the Map is saved.

To watch real Bots on the Map, play the worked Entries in the repo's `packages/cli/examples` (`alice.entry.json`, `bob.entry.json`) at their default time limit.

## 5. Upload it

Create a new Map:

```bash
positrontanks maps create --name "<Map name>" --map <name>.map.json --description "<public description>" --json
```

The name is 1-64 characters. The JSON output is the created Map; its `id` is what Games are created with. Map names, descriptions and Revisions are public.

To change a Map you created, add a Revision instead; Revisions are immutable, and Games keep the Revision they were made with:

```bash
positrontanks maps revise <MAP_ID> --map <name>.map.json --notes "<what changed>" --json
```

To edit an existing Map's content, fetch it first with `positrontanks maps show <MAP_ID> --out <name>.map.json`.

A rejection exits 1 with every problem on stderr, one `path: message` per line: fix them all, rerun step 4, and upload again. Exit code 3 means you are not signed in to that server.

Done when the command exits 0 and you have reported the Map's `id`, and its Revision number when you revised it.
