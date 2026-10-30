#!/usr/bin/env node
// Sums up one or more Replays (replay.json from `positrontanks run`, or
// `positrontanks games replay --out`), per Bot Name, so Revisions can be
// compared across a series of Games. Usage:
//
//   node replay-stats.mjs [--json] REPLAY [REPLAY ...]
//
// Bots are keyed by Bot Name, so give each Revision its own Bot Name and keep
// it the same in every Game of the series.

import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const files = args.filter((a) => a !== "--json");
if (files.length === 0) {
  console.error("Usage: node replay-stats.mjs [--json] REPLAY [REPLAY ...]");
  process.exit(2);
}

const STILL = 0.2; // m/s: slower than this counts as standing still
const stats = new Map();

function statsFor(name) {
  let s = stats.get(name);
  if (s === undefined) {
    s = {
      name,
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      survived: 0,
      shots: 0,
      hitsOnFoes: 0,
      hitsOnFriends: 0,
      hitsOnObstacles: 0,
      misses: 0,
      foeDamage: 0,
      damageTaken: 0,
      absorbed: 0,
      takenBySide: { front: 0, left: 0, right: 0, rear: 0 },
      rams: 0,
      bumps: 0,
      stillTicks: 0,
      ticks: 0,
      disabledAt: [],
    };
    stats.set(name, s);
  }
  return s;
}

for (const file of files) {
  const replay = JSON.parse(readFileSync(file, "utf8"));
  const bots = new Map(); // id -> {name, entry, player}
  replay.entries.forEach((entry, e) => {
    for (const b of entry.bots) bots.set(b.id, { name: b.name, entry: e, player: entry.player });
  });
  const result = replay.result;
  for (const bot of bots.values()) {
    const s = statsFor(bot.name);
    s.games++;
    if (result == null || result.winner == null) s.draws++;
    else if (result.winner === bot.player) s.wins++;
    else s.losses++;
  }
  const disabled = new Set();
  for (const t of replay.ticks) {
    for (const b of t.bots ?? []) {
      const bot = bots.get(b.id);
      if (bot === undefined || b.status !== "active") continue;
      const s = statsFor(bot.name);
      s.ticks++;
      if (Math.abs(b.speed) < STILL) s.stillTicks++;
    }
    for (const ev of t.events) {
      if (ev.type === "fired") {
        statsFor(bots.get(ev.bot).name).shots++;
      } else if (ev.type === "impact") {
        const s = statsFor(bots.get(ev.bot).name);
        if (ev.target === null) s.misses++;
        else if (ev.target.kind === "bot") {
          if (bots.get(ev.target.id).entry === bots.get(ev.bot).entry) s.hitsOnFriends++;
          else s.hitsOnFoes++;
        } else s.hitsOnObstacles++;
      } else if (ev.type === "damage" && ev.target.kind === "bot") {
        const target = bots.get(ev.target.id);
        const t2 = statsFor(target.name);
        t2.damageTaken += ev.dealt;
        t2.absorbed += ev.absorbed;
        if (ev.side !== null) t2.takenBySide[ev.side] += ev.dealt;
        const src = ev.source.kind === "weapon" ? bots.get(ev.source.bot) : null;
        if (src != null && src.entry !== target.entry) statsFor(src.name).foeDamage += ev.dealt;
        if (ev.source.kind === "collision" && ev.source.with.kind === "bot") {
          const other = bots.get(ev.source.with.id);
          if (other.entry !== target.entry) statsFor(other.name).foeDamage += ev.dealt;
        }
      } else if (ev.type === "collision") {
        const s = statsFor(bots.get(ev.bot).name);
        if (ev.with.kind === "bot") s.rams++;
        else s.bumps++;
      } else if (ev.type === "disabled") {
        const bot = bots.get(ev.bot);
        disabled.add(ev.bot);
        statsFor(bot.name).disabledAt.push(`${String(ev.tick)} (${ev.cause})`);
      }
    }
  }
  for (const [id, bot] of bots) if (!disabled.has(id)) statsFor(bot.name).survived++;
}

const rows = [...stats.values()];
if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const pct = (n, d) => (d === 0 ? "-" : `${String(Math.round((100 * n) / d))}%`);
  const num = (n) => String(Math.round(n)); // ramming damage is fractional
  console.log(`${String(files.length)} Replay(s)\n`);
  for (const s of rows) {
    const hits = s.hitsOnFoes + s.hitsOnFriends + s.hitsOnObstacles;
    console.log(`${s.name}`);
    console.log(`  games ${String(s.games)}: won ${String(s.wins)}, drew ${String(s.draws)}, lost ${String(s.losses)}; survived ${String(s.survived)}`);
    console.log(`  shots ${String(s.shots)}: on Foes ${String(s.hitsOnFoes)} (${pct(s.hitsOnFoes, s.shots)}), on Friends ${String(s.hitsOnFriends)}, on Obstacles ${String(s.hitsOnObstacles)}, out of range ${String(s.misses)}${hits + s.misses < s.shots ? ", still flying at the end " + String(s.shots - hits - s.misses) : ""}`);
    const side = s.takenBySide;
    console.log(`  Foe damage dealt ${num(s.foeDamage)}; damage taken ${num(s.damageTaken)} (Armor absorbed ${num(s.absorbed)})`);
    console.log(`  taken by side: front ${num(side.front)}, left ${num(side.left)}, right ${num(side.right)}, rear ${num(side.rear)}`);
    console.log(`  collisions: with Bots ${String(s.rams)}, with Obstacles, wrecks or the boundary ${String(s.bumps)}; standing still ${pct(s.stillTicks, s.ticks)} of active Ticks`);
    if (s.disabledAt.length > 0) console.log(`  Disabled at Tick ${s.disabledAt.join(", ")}`);
  }
}
