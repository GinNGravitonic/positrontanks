/**
 * The golden Games: fixed Maps, Designs (Builds and Programs), seeds and time
 * limits under the real r1 Ruleset (v1.md section 11, "Testing").
 *
 * These definitions are only read when the goldens are regenerated; the
 * checked-in `golden/<name>.json` files are what golden.test.ts plays. See
 * golden.test.ts for how to regenerate them.
 *
 * Each Game is meant to exercise a different part of the engine: win
 * conditions, weapon categories, Terrains, Obstacles, sensors and Program
 * failures.
 */

import type { Build, MapFormat1 } from "@positrontanks/ruleset-data";
import type { ProgramEntrySetup } from "./game.js";

export interface GoldenGame {
  /** The file name under `golden/`, without `.json`. */
  readonly name: string;
  /** What the Game is meant to exercise. */
  readonly description: string;
  readonly map: MapFormat1;
  readonly entries: readonly ProgramEntrySetup[];
  readonly seed: number;
  readonly timeLimitTicks: number;
}

type Armor = Build["armor"];
const bare: Armor = { front: null, left: null, right: null, rear: null };

function rect(x: number, y: number, w: number, h: number): { x: number; y: number }[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/**
 * Seeks the nearest Foe it can see and fires `weapon` at it once it is
 * roughly ahead; with no Foe in sight it heads for the Map centre and sweeps.
 */
function hunter(weapon: string, closeTo: number): string {
  return `
let sweep = 1;

function nearest(contacts) {
  return contacts.reduce((best, c) => best == null || c.distance < best.distance ? c : best, null);
}

function tick() {
  const foe = nearest(scan().filter((c) => c.isFoe));
  if (foe == null) {
    const cx = map.width / 2;
    const cy = map.height / 2;
    if (distanceTo(cx, cy) > 6) {
      turn(clamp(bearingTo(cx, cy) / 30, -1, 1));
      throttle(0.8);
    } else {
      turn(sweep);
      throttle(0.2);
      if (self.tick % 40 == 0) { sweep = -sweep; }
    }
    return;
  }
  turn(clamp(foe.bearing / 20, -1, 1));
  throttle(foe.distance > ${String(closeTo)} ? 1 : -0.3);
  if (abs(foe.bearing) < 12) {
    if (fire("${weapon}", foe)) { log("fired at " + foe.name + " " + str(round(foe.distance))); }
  }
}`;
}

/** Wanders at random, dodges detected Projectiles and fires every gun it has at any Foe it sees. */
function wanderer(guns: readonly string[]): string {
  return `
const guns = [${guns.map((g) => `"${g}"`).join(", ")}];
let heading = 0;

function init() {
  heading = random() * 360;
  log("start " + terrainHere() + " " + str(map.obstacles.length) + " obstacles");
}

function tick() {
  const threats = incoming();
  if (threats.length > 0) {
    const t = threats[0];
    turn(t.bearing > 0 ? -1 : 1);
    throttle(1);
    log("dodge " + str(t.ticksToImpact));
  } else {
    if (random() < 0.05) { heading = random() * 360; }
    if (self.x < 6 || self.y < 6 || self.x > map.width - 6 || self.y > map.height - 6) {
      heading = absBearingTo(map.width / 2, map.height / 2);
    }
    turn(clamp(normalizeAngle(heading - self.heading) / 45, -1, 1));
    throttle(terrainHere() == "road" ? 1 : 0.7);
  }
  const foes = scan().filter((c) => c.isFoe);
  if (foes.length > 0) {
    const foe = foes[floor(random() * foes.length)];
    for (const g of guns) { fire(g, foe); }
  }
}`;
}

/** Charges the nearest Foe to ram it and strike with its prow weapon, steering round Obstacles with its rangefinder if it has one. */
function rammer(weapon: string, rangefinder: string | null): string {
  const probe =
    rangefinder === null
      ? ""
      : `
  const r = rangefind("${rangefinder}");
  if (r != null && r.hit == "obstacle" && r.distance < 5) { turn(1); throttle(-0.5); return; }`;
  return `
let target = null;

function tick() {
  const foes = scan().filter((c) => c.isFoe);
  if (foes.length > 0) { target = foes[0]; }
  const goal = target == null ? { x: map.width - 12, y: map.height / 2 } : target;${probe}
  const b = bearingTo(goal.x, goal.y);
  turn(clamp(b / 15, -1, 1));
  throttle(abs(b) < 45 ? 1 : 0.3);
  fire("${weapon}", 0);
  if (checkTerrain(0, 3) == "mud") { log("mud ahead"); }
}`;
}

export const GOLDEN_GAMES: readonly GoldenGame[] = [
  {
    name: "duel-last-standing",
    description:
      "Two Scouts on grass with a road, a sand patch, a pillar and two destructible crates: a hover Laser Scout hunts a wheeled Pellet Gun Scout. Beam against Projectile weapons; ends with one Player left standing.",
    seed: 1234,
    timeLimitTicks: 1200,
    map: {
      format: 1,
      width: 60,
      height: 40,
      baseTerrain: "grass",
      terrainRegions: [
        { terrain: "road", shape: "polygon", points: rect(0, 18, 60, 4) },
        { terrain: "sand", shape: "circle", x: 30, y: 20, radius: 6 },
      ],
      obstacles: [
        { id: "pillar", destructible: false, shape: "circle", x: 30, y: 20, radius: 2 },
        { id: "crate-north", destructible: true, hitPoints: 150, shape: "polygon", points: rect(28, 6, 4, 4) },
        { id: "crate-south", destructible: true, hitPoints: 150, shape: "polygon", points: rect(28, 30, 4, 4) },
      ],
      spawnZones: [
        { heading: 90, capacity: 2, shape: "polygon", points: rect(2, 10, 10, 20) },
        { heading: 270, capacity: 2, shape: "polygon", points: rect(48, 10, 10, 20) },
      ],
    },
    entries: [
      {
        player: "ann",
        bots: [
          {
            name: "Glint",
            build: { chassis: "scout", components: { gun: "laser", eye: "radar", drive: "hover" }, armor: { ...bare, front: "lightPlate" } },
            program: hunter("gun", 12),
          },
        ],
      },
      {
        player: "bob",
        bots: [
          {
            name: "Peashooter",
            build: { chassis: "scout", components: { gun: "pelletGun", eye: "shortRadar", drive: "wheels" }, armor: bare },
            program: hunter("gun", 8),
          },
        ],
      },
    ],
  },
  {
    name: "four-corners-time-limit",
    description:
      "Three Players on a sand Map crossed by roads, with a keep, rocks and a destructible barrel: an Autocannon Rover, a Cannon Turret Brawler on tracks and a hover Rocket Scout wander, dodge with Projectile Detectors and fire at random Foes. Ends at the time limit, decided by Foe damage.",
    seed: 987654321,
    timeLimitTicks: 240,
    map: {
      format: 1,
      width: 80,
      height: 80,
      baseTerrain: "sand",
      terrainRegions: [
        { terrain: "road", shape: "polygon", points: rect(38, 0, 4, 80) },
        { terrain: "road", shape: "polygon", points: rect(0, 38, 80, 4) },
      ],
      obstacles: [
        {
          id: "keep",
          destructible: false,
          shape: "polygon",
          points: [
            { x: 40, y: 32 },
            { x: 48, y: 40 },
            { x: 40, y: 48 },
            { x: 32, y: 40 },
          ],
        },
        { id: "rock-1", destructible: false, shape: "circle", x: 20, y: 40, radius: 3 },
        { id: "rock-2", destructible: false, shape: "circle", x: 60, y: 40, radius: 3 },
        { id: "barrel", destructible: true, hitPoints: 40, shape: "circle", x: 40, y: 15, radius: 1 },
      ],
      spawnZones: [
        { heading: 135, capacity: 3, shape: "circle", x: 10, y: 10, radius: 7 },
        { heading: 225, capacity: 3, shape: "circle", x: 70, y: 10, radius: 7 },
        { heading: 315, capacity: 3, shape: "circle", x: 70, y: 70, radius: 7 },
        { heading: 45, capacity: 2, shape: "circle", x: 10, y: 70, radius: 5 },
      ],
    },
    entries: [
      {
        player: "cat",
        bots: [
          {
            name: "Twin",
            build: {
              chassis: "rover",
              components: {
                leftGun: "autocannon", rightGun: "autocannon", eye: "radar", rearEye: "detector", drive: "wheels", bay: "coprocessor",
              },
              armor: { front: "mediumPlate", left: "lightPlate", right: "lightPlate", rear: null },
            },
            program: wanderer(["leftGun", "rightGun"]),
          },
        ],
      },
      {
        player: "dan",
        bots: [
          {
            name: "Bulwark",
            build: {
              chassis: "brawler",
              components: { nose: "cannonTurret", eye: "domeRadar", rearEye: "detector", leftDrive: "tracks", rightDrive: "tracks", bay: "fastProcessor" },
              armor: { front: "heavyPlate", left: "mediumPlate", right: "mediumPlate", rear: "mediumPlate" },
            },
            program: wanderer(["nose"]),
          },
        ],
      },
      {
        player: "eve",
        bots: [
          {
            name: "Skipper",
            build: { chassis: "scout", components: { gun: "rocketPod", eye: "domeRadar", drive: "hover" }, armor: bare },
            program: wanderer(["gun"]),
          },
        ],
      },
    ],
  },
  {
    name: "ice-and-mud-teams",
    description:
      "A two-Bot team (a tracked Hammer Wedge with a rangefinder and a walking Saw Brawler) against a Juggernaut with a Rocket Pod, Autocannons and a tail Pellet Gun, on ice and mud with destructible walls and a boulder. Melee, a rangefinder, Friends and every Terrain modifier.",
    seed: 42,
    timeLimitTicks: 500,
    map: {
      format: 1,
      width: 70,
      height: 50,
      baseTerrain: "grass",
      terrainRegions: [
        { terrain: "ice", shape: "polygon", points: rect(15, 0, 12, 50) },
        { terrain: "mud", shape: "polygon", points: rect(43, 0, 12, 50) },
        { terrain: "road", shape: "circle", x: 35, y: 25, radius: 5 },
      ],
      obstacles: [
        { id: "wall-north", destructible: true, hitPoints: 60, shape: "polygon", points: rect(33, 8, 4, 8) },
        { id: "wall-south", destructible: true, hitPoints: 60, shape: "polygon", points: rect(33, 34, 4, 8) },
        { id: "boulder", destructible: false, shape: "circle", x: 50, y: 42, radius: 2.5 },
      ],
      spawnZones: [
        { heading: 90, capacity: 2, shape: "polygon", points: rect(2, 15, 10, 20) },
        { heading: 270, capacity: 2, shape: "polygon", points: rect(58, 15, 10, 20) },
      ],
    },
    entries: [
      {
        player: "red",
        bots: [
          {
            name: "Anvil",
            build: {
              chassis: "wedge",
              components: { prow: "hammer", eye: "rangefinder", leftDrive: "tracks", rightDrive: "tracks" },
              armor: { ...bare, front: "heavyPlate" },
            },
            program: rammer("prow", "eye"),
          },
          {
            name: "Buzz",
            build: {
              chassis: "brawler",
              components: {
                nose: "saw", eye: "domeRadar", leftDrive: "walker", rightDrive: "walker",
              },
              armor: { front: "mediumPlate", left: "lightPlate", right: "lightPlate", rear: null },
            },
            program: rammer("nose", null),
          },
        ],
      },
      {
        player: "blue",
        bots: [
          {
            name: "Colossus",
            build: {
              chassis: "juggernaut",
              components: {
                leftNose: "rocketPod", leftGun: "autocannon", rightGun: "autocannon", tail: "pelletGun",
                eye: "longRadar", topEye: "domeRadar", rearEye: "detector", leftDrive: "tracks", rightDrive: "tracks", bay1: "fastProcessor",
              },
              armor: { front: "heavyPlate", left: "heavyPlate", right: "heavyPlate", rear: "mediumPlate" },
            },
            program: `
function tick() {
  const foes = scan().filter((c) => c.isFoe);
  if (foes.length == 0) { turn(0.4); throttle(0); return; }
  const foe = foes.reduce((a, c) => c.distance < a.distance ? c : a, foes[0]);
  turn(clamp(foe.bearing / 10, -1, 1));
  throttle(foe.distance < 3 ? 0 : 0.3);
  for (const g of ["leftNose", "leftGun", "rightGun", "tail"]) { fire(g, foe); }
}`,
          },
        ],
      },
    ],
  },
  {
    name: "program-failures",
    description:
      "Three Players whose Programs fail in different ways: one halts in its init phase, one hits a runtime error some Ticks and runs out of budget in others, and one spins a Beam Turret. Exercises halting, error logging and budget use; ends with one Player left standing or at the time limit.",
    seed: 7,
    timeLimitTicks: 250,
    map: {
      format: 1,
      width: 40,
      height: 40,
      baseTerrain: "road",
      terrainRegions: [{ terrain: "grass", shape: "circle", x: 20, y: 20, radius: 8 }],
      obstacles: [],
      spawnZones: [
        { heading: 180, capacity: 1, shape: "circle", x: 20, y: 6, radius: 3 },
        { heading: 0, capacity: 1, shape: "circle", x: 20, y: 34, radius: 3 },
        { heading: 90, capacity: 1, shape: "circle", x: 6, y: 20, radius: 3 },
      ],
    },
    entries: [
      {
        player: "fay",
        bots: [
          {
            name: "Oops",
            build: { chassis: "scout", components: { gun: "pelletGun", eye: "shortRadar", drive: "wheels" }, armor: bare },
            program: `
const plan = [1, 2, 3];
function init() { log("planning"); const step = plan[3]; }
function tick() { throttle(1); }`,
          },
        ],
      },
      {
        player: "gus",
        bots: [
          {
            name: "Glitch",
            build: { chassis: "scout", components: { gun: "spike", eye: "shortRadar", drive: "walker" }, armor: { ...bare, front: "lightPlate" } },
            program: `
let n = 0;
function tick() {
  n += 1;
  throttle(0.5);
  turn(0.2);
  if (n % 7 == 0) { const r = {}; log(r.missing); }
  if (n % 11 == 0) { let i = 0; while (true) { i += 1; } }
  fire("gun", 0);
}`,
          },
        ],
      },
      {
        player: "hal",
        bots: [
          {
            name: "Lighthouse",
            build: { chassis: "rover", components: { leftGun: "beamTurret", eye: "domeRadar", drive: "wheels" }, armor: bare },
            program: `
function tick() {
  turn(1);
  throttle(0.1);
  const foes = scan().filter((c) => c.isFoe);
  if (foes.length > 0) {
    const ok = fire("leftGun", foes[0]);
    log(ok ? "zap " + foes[0].name : "reloading " + str(self.weapons[0].ticksUntilReady));
  }
}`,
          },
        ],
      },
    ],
  },
  {
    name: "mutual-destruction-draw",
    description:
      "Two identical Laser Scouts on wheels face each other across open grass and trade Beam shots without moving. Instant weapons all fire before any damage is dealt, so the last two Bots are Disabled in the same Tick: ends with none standing, tied on Foe damage and Hit Points, a Draw.",
    seed: 2024,
    timeLimitTicks: 600,
    map: {
      format: 1,
      width: 40,
      height: 20,
      baseTerrain: "grass",
      terrainRegions: [],
      obstacles: [],
      spawnZones: [
        { heading: 90, capacity: 1, shape: "polygon", points: rect(6, 9, 2, 2) },
        { heading: 270, capacity: 1, shape: "polygon", points: rect(32, 9, 2, 2) },
      ],
    },
    entries: (["ivy", "jay"] as const).map((player, i) => ({
      player,
      bots: [
        {
          name: i === 0 ? "Mirror" : "Image",
          build: { chassis: "scout", components: { gun: "laser", eye: "radar", drive: "wheels" }, armor: { ...bare, front: "lightPlate" } },
          program: `
function tick() {
  throttle(0);
  const foes = scan().filter((c) => c.isFoe);
  if (foes.length == 0) { return; }
  const foe = foes[0];
  turn(clamp(foe.bearing / 20, -1, 1));
  if (fire("gun", foe)) { log("hit " + foe.name + " at " + str(self.hitPoints)); }
}`,
        },
      ],
    })),
  },
];
