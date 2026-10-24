import { validateBuild, type Build } from "@aumohta/ruleset-data";
import { loadRuleset } from "@aumohta/ruleset-data/rulesets";
import { describe, expect, it } from "vitest";
import { checkRuleset, deriveBotSpec } from "./bot-spec.js";

const r1 = loadRuleset("r1");

type Armor = Build["armor"];
const none: Armor = { front: null, left: null, right: null, rear: null };

interface Reference {
  readonly name: string;
  readonly build: Build;
  // catalog-r1.md section 8, rounded as there.
  readonly cost: number;
  readonly mass: number;
  readonly hitPoints: number;
  readonly topSpeed: number;
  readonly accel: number;
  readonly turnRate: number;
  readonly armor: readonly [number, number, number, number];
  readonly operationBudget: number;
  readonly wallRam: number;
  readonly dps: number;
}

const references: Reference[] = [
  {
    name: "Scout: Pellet Gun, Short Radar, Wheels",
    build: { chassis: "scout", components: { gun: "pelletGun", eye: "shortRadar", drive: "wheels" }, armor: none },
    cost: 74, mass: 70, hitPoints: 80, topSpeed: 7, accel: 14.3, turnRate: 143,
    armor: [0, 0, 0, 0], operationBudget: 1000, wallRam: 17, dps: 16.7,
  },
  {
    name: "Scout: Laser, Radar, Hover Fans, Light front",
    build: {
      chassis: "scout",
      components: { gun: "laser", eye: "radar", drive: "hover" },
      armor: { ...none, front: "lightPlate" },
    },
    cost: 135, mass: 80, hitPoints: 80, topSpeed: 9, accel: 8.8, turnRate: 150,
    armor: [2, 0, 0, 0], operationBudget: 1000, wallRam: 32, dps: 17.5,
  },
  {
    name: "Rover: 2 Autocannons, Radar, Detector, Wheels, Coprocessor, Medium front, Light sides",
    build: {
      chassis: "rover",
      components: {
        leftGun: "autocannon", rightGun: "autocannon", eye: "radar", rearEye: "detector", drive: "wheels", bay: "coprocessor",
      },
      armor: { front: "mediumPlate", left: "lightPlate", right: "lightPlate", rear: null },
    },
    cost: 210, mass: 191, hitPoints: 160, topSpeed: 7, accel: 5.2, turnRate: 105,
    armor: [4, 2, 2, 0], operationBudget: 2000, wallRam: 47, dps: 40,
  },
  {
    name: "Wedge: Hammer, Radar, 2 Wheels, Heavy front",
    build: {
      chassis: "wedge",
      components: { prow: "hammer", eye: "radar", leftDrive: "wheels", rightDrive: "wheels" },
      armor: { ...none, front: "heavyPlate" },
    },
    cost: 181, mass: 233, hitPoints: 220, topSpeed: 7, accel: 8.6, turnRate: 120,
    armor: [7, 0, 0, 0], operationBudget: 1000, wallRam: 57, dps: 46.7,
  },
  {
    name: "Brawler: Saw, 2 side Autocannons, Radar, Detector, 2 Tracks, Coprocessor, Medium all round, Light rear",
    build: {
      chassis: "brawler",
      components: {
        nose: "saw", leftGun: "autocannon", rightGun: "autocannon", eye: "radar", rearEye: "detector",
        leftDrive: "tracks", rightDrive: "tracks", bay: "coprocessor",
      },
      armor: { front: "mediumPlate", left: "mediumPlate", right: "mediumPlate", rear: "lightPlate" },
    },
    cost: 332, mass: 372, hitPoints: 300, topSpeed: 4.5, accel: 11.8, turnRate: 58,
    armor: [4, 4, 4, 2], operationBudget: 2000, wallRam: 38, dps: 80,
  },
  {
    name: "Brawler: Cannon Turret, Dome Radar, 2 Tracks, Fast Processor, Heavy front, Medium elsewhere",
    build: {
      chassis: "brawler",
      components: { nose: "cannonTurret", eye: "domeRadar", leftDrive: "tracks", rightDrive: "tracks", bay: "fastProcessor" },
      armor: { front: "heavyPlate", left: "mediumPlate", right: "mediumPlate", rear: "mediumPlate" },
    },
    cost: 338, mass: 383, hitPoints: 300, topSpeed: 4.5, accel: 11.5, turnRate: 56,
    armor: [7, 4, 4, 4], operationBudget: 4000, wallRam: 39, dps: 16.7,
  },
  {
    name: "Juggernaut: Rocket Pod, Lance, 2 side Autocannons, tail Pellet Gun, Long + Dome Radar, Detector, 2 Tracks, Fast Processor, Heavy front and sides, Medium rear",
    build: {
      chassis: "juggernaut",
      components: {
        leftNose: "rocketPod", rightNose: "lance", leftGun: "autocannon", rightGun: "autocannon", tail: "pelletGun",
        eye: "longRadar", topEye: "domeRadar", rearEye: "detector", leftDrive: "tracks", rightDrive: "tracks", bay1: "fastProcessor",
      },
      armor: { front: "heavyPlate", left: "heavyPlate", right: "heavyPlate", rear: "mediumPlate" },
    },
    cost: 571, mass: 602, hitPoints: 500, topSpeed: 4.5, accel: 7.3, turnRate: 60,
    armor: [7, 7, 7, 4], operationBudget: 4000, wallRam: 61, dps: 93.7,
  },
];

const round1 = (v: number) => Math.round(v * 10) / 10;

describe("the r1 Ruleset", () => {
  it("passes checkRuleset", () => {
    expect(checkRuleset(r1)).toEqual([]);
  });

  it.each(references)("derives the Reference Build $name (catalog-r1 section 8)", (ref) => {
    const validated = validateBuild(r1, ref.build);
    expect(validated.ok ? [] : validated.errors).toEqual([]);
    if (!validated.ok) return;
    expect(validated.cost).toBe(ref.cost);

    const spec = deriveBotSpec(r1, validated.build);
    expect(spec.mass).toBe(ref.mass);
    expect(spec.maxHitPoints).toBe(ref.hitPoints);
    expect(spec.topSpeed).toBe(ref.topSpeed);
    expect(round1(spec.accel)).toBe(ref.accel);
    expect(Math.round(spec.turnRate)).toBe(ref.turnRate);
    expect([spec.armor.front, spec.armor.left, spec.armor.right, spec.armor.rear]).toEqual(ref.armor);
    expect(spec.operationBudget).toBe(ref.operationBudget);
    expect(Math.round(0.01 * 0.5 * spec.mass * spec.topSpeed ** 2)).toBe(ref.wallRam);
    const dps = spec.weapons.reduce((sum, w) => sum + (w.damage * r1.tickRate) / w.reloadTicks, 0);
    expect(round1(dps)).toBe(ref.dps);
  });
});
