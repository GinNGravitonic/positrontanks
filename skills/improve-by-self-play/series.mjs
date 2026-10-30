#!/usr/bin/env node
// Plays a series of local Games between two Entry files with `positrontanks
// run`, swapping which Entry is listed first every other Game and using seeds
// 1..N so the series can be repeated, then sums up the Replays with
// replay-stats.mjs. Usage:
//
//   node series.mjs --map MAP --entry A.entry.json --entry B.entry.json
//     [--games N] [--out DIR] [--json] [any other `positrontanks run` option]
//
// --games defaults to 10 and --out to ./series. Each Game's files go to
// DIR/<seed>/. Set POSITRONTANKS_CLI to run a CLI other than `positrontanks`
// on the PATH (such as "node path/to/main.js").

import { spawnSync } from "node:child_process";
import console from "node:console";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const entries = [];
const pass = [];
let games = 10;
let out = "series";
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--entry") entries.push(args[++i]);
  else if (a === "--games") games = Number(args[++i]);
  else if (a === "--out") out = args[++i];
  else if (a === "--json") json = true;
  else if (a === "--seed" || a === "--unthrottled") {
    if (a === "--seed") i++; // the series chooses the seeds and always runs unthrottled
  } else pass.push(a);
}
if (entries.length !== 2 || !Number.isInteger(games) || games < 1) {
  console.error("Usage: node series.mjs --map MAP --entry A.entry.json --entry B.entry.json [--games N] [--out DIR] [--json] [run options]");
  process.exit(2);
}

const cli = process.env.POSITRONTANKS_CLI ?? "positrontanks";
const quote = (s) => (/^[\w./:\\-]+$/.test(s) ? s : `"${s.replaceAll('"', '\\"')}"`);
const replays = [];
for (let seed = 1; seed <= games; seed++) {
  const [first, second] = seed % 2 === 1 ? entries : [entries[1], entries[0]];
  const dir = join(out, String(seed));
  const command = [cli, "run", ...pass, "--entry", first, "--entry", second, "--seed", String(seed), "--unthrottled", "--out", dir, "--json"]
    .map((s, i) => (i === 0 ? s : quote(s)))
    .join(" ");
  const run = spawnSync(command, { shell: true, encoding: "utf8" });
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout);
    console.error(`Game ${String(seed)} failed (exit code ${String(run.status)}): ${command}`);
    process.exit(1);
  }
  const summary = JSON.parse(run.stdout);
  const r = summary.result;
  console.error(`Game ${String(seed)}: ${r.winner === null ? "Draw" : `${r.winner} wins`} by ${r.decidedBy} in Tick ${String(r.tick)}`);
  replays.push(join(dir, "replay.json"));
}

const stats = join(dirname(fileURLToPath(import.meta.url)), "replay-stats.mjs");
const result = spawnSync(process.execPath, [stats, ...(json ? ["--json"] : []), ...replays], { stdio: "inherit" });
process.exit(result.status ?? 1);
