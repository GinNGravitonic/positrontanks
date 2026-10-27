# CLI runner

The CLI runner (`packages/cli`, command `aumohta`) plays a Game locally from files, with no account, server or database ([v1.md section 10](v1.md#10-architecture)), and runs the tick cost check offline ([`aumohta tick-cost`](#tick-cost-check)). This document records its input format, its defaults and its output files. Vocabulary follows [GLOSSARY.md](../../GLOSSARY.md).

Worked examples are in [`packages/cli/examples`](../../packages/cli/examples): two Entry files (`alice.entry.json`, `bob.entry.json`) and their Programs (`hunter.aum`, `rammer.aum`). With the bundled duel Map:

```bash
aumohta run --map packages/ruleset-data/maps/duel.json \
  --entry packages/cli/examples/alice.entry.json \
  --entry packages/cli/examples/bob.entry.json --unthrottled
```

## Command

```
aumohta run --map FILE --entry FILE [--entry FILE ...] [options]
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--map FILE` | The Map, as Map Format JSON. Required. | |
| `--entry FILE` | An Entry file. Required; give one per Entry, in Entry order. At most one per Spawn Zone. | |
| `--unthrottled` | Unthrottled Pace (as fast as possible). | Real-time Pace: one simulated second per real second |
| `--seed N` | The Game's random seed, a whole number in [0, 2^32). | A random seed, printed so the Game can be repeated with `--seed` |
| `--time-limit SECONDS` | The time limit in simulated seconds; must be a positive whole number of Ticks. | `120` |
| `--point-budget N` | The Point Budget; must be within the Ruleset's range. | The Ruleset's maximum Point Budget |
| `--ruleset VERSION` | The Ruleset version. | `r1`, the latest Ruleset |
| `--out DIR` | Where the output files are written; created if missing. | `.` (the current directory) |
| `--json` | Print a JSON summary instead of text. | Text |
| `-h`, `--help` | Show usage. | |

The `--ruleset` default is the latest Ruleset this CLI supports; it is currently `r1`, the only one. When a later Ruleset is added, the default should move to it.

Before playing, the runner checks its inputs as the server checks a submission: the Map against the Ruleset (Map Format and Terrains), each Build and Program, each Entry's cost against the Point Budget, each Entry's Bot count against the Map's Spawn Zones, and Bot Names unique within the Game. It reports every problem it finds at once, with `file:line:column` positions for Program errors. Exit codes: 0 on a played Game, 1 on bad input, 2 on bad usage.

## Entry file

An Entry file is a JSON object describing one Entry: its Player and its Bots. Unknown fields are errors.

```json
{
  "ruleset": "r1",
  "player": "alice",
  "bots": [
    {
      "name": "Pecker",
      "build": {
        "chassis": "scout",
        "components": { "gun": "pelletGun", "eye": "shortRadar", "drive": "wheels" },
        "armor": { "front": null, "left": null, "right": null, "rear": null }
      },
      "programFile": "hunter.aum"
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `ruleset` | no | A Ruleset version. When given, it must equal the Game's Ruleset (`--ruleset`); it guards against running an Entry under the wrong Ruleset. |
| `player` | no | The Player, a non-empty string. Defaults to the file name without its `.json` and then `.entry` suffixes, so `alice.entry.json` is Player `alice`. Entry files with the same Player belong to one Player, as on the server. |
| `bots` | yes | A non-empty list of Bots. |
| `bots[].name` | yes | The Bot Name, a non-empty string, unique within the Game. |
| `bots[].build` | yes | The Build, in the same shape the server accepts for a Bot Design. |
| `bots[].program` | one of | The Program as inline source. |
| `bots[].programFile` | one of | A path to the Program's source file, relative to the Entry file's directory. |

Each Bot needs exactly one of `program` and `programFile`.

Locally there are no Garages, Bot Designs or Revisions: each Bot carries its Build and Program directly. The Entry's cost is the sum of its Builds' costs.

## Program files: `.aum`

`.aum` is the project-wide file extension for Program source (Aumohta language, UTF-8). The CLI runner's examples use it, and the API CLI will use it too. The runner itself reads a `programFile` of any name.

## Output

After the Game the runner prints the result and each Program's per-Tick budget peaks ([ADR-0002](../adr/0002-counted-operation-budget.md)), and writes three files into `--out`, replacing any already there:

| File | Contents |
| --- | --- |
| `game-record.json` | The Game Record: everything needed to reproduce the Game exactly, Programs included. |
| `replay.json` | The Replay: the Game's events and Builds, never Programs. |
| `program-logs.json` | Every Bot's Program log. Locally you own every participant, so all logs are written. |

The files are compact JSON (one line each). With `--json`, stdout is a summary object with `ruleset`, `seed`, `timeLimitTicks`, `pointBudget`, `costs` (each Entry's point cost, in Entry order), `result`, `budgetPeaks` and `files` (the three paths).

## Tick cost check

```
aumohta tick-cost --entry FILE [--ticks N] [--seed N] [--json]
```

Runs the tick cost check ([ADR-0002](../adr/0002-counted-operation-budget.md)) offline, with no server: each Bot of the Entry file runs its init phase and then `tick()` for `--ticks` Ticks in the sample world, exactly as the server's tick cost endpoints (`POST /tick-cost-checks`) run it, so the two report the same numbers for the same Build, Program, Ticks and seed. It is the offline alternative where a server leaves the endpoints off (`410 feature_disabled`; see [docs/docker.md](../docker.md#tick-cost-check)). Both run `tickCostCheck` from `packages/engine-r1`.

| Option | Meaning | Default |
| --- | --- | --- |
| `--entry FILE` | An [Entry file](#entry-file). Required. Its `ruleset`, if any, chooses the Ruleset. | Ruleset `r1` |
| `--ticks N` | Ticks to run `tick()` for, 1 to 100. | `20` |
| `--seed N` | The sample Game's seed, a whole number in [0, 2^32). It drives `random()` and which side the Bot starts on. | `1` |
| `--json` | Print JSON instead of text. | Text |
| `-h`, `--help` | Show usage. | |

The defaults and the 100-Tick maximum are the endpoint's. Each Bot is checked alone, as the server checks a Bot Design: its Build against the Ruleset and the Ruleset's largest Point Budget, and its Program with the language checker. Bot Names need not be unique and the Entry's total cost is not checked. Every problem is reported at once; exit codes are as for `run`.

The text output is a table of each Bot's init phase, Tick peak, Ticks out of budget or stopped at an error, memory peak and halt, then each Bot's operations by Tick. With `--json`, stdout is `{ "player": ..., "bots": [{ "name": ..., "report": ... }] }`, one per Bot in Entry file order, where each `report` has exactly the fields of the endpoint's `TickCostReport` (`rulesetVersion`, `operationBudget`, `seed`, `ticks`, `init`, `runs`, `peak`, `memory`, `halt`).

## Agreement with the server

A local Game should be repeatable as a server Game with the same Ruleset, Map, Entries, Point Budget and time limit (the server chooses its own seed, so the outcome may differ). Hence:

- **Time limit.** The CLI's 120 s default must stay at or below the server's maximum time limit. The server's default maximum is 600 s (`maxTimeLimitSeconds` in `packages/server/src/config.ts`); `packages/server/src/config.test.ts` checks it is at least the CLI default. An operator can lower it with `AUMOHTA_MAX_TIME_LIMIT_SECONDS`, so on such a server a 120 s local Game cannot be repeated as is. The server also takes the time limit as a whole number of seconds, while the CLI accepts any whole number of Ticks (for example `--time-limit 0.5` at 10 Ticks per second); only whole-second local time limits carry over.
- **Point Budget.** Both default and range come from the Ruleset, so any Point Budget the CLI accepts is one the server accepts.
- **Map.** The CLI reads a Map file directly; the server's Map Revisions also pass the server's Map size limits, which the CLI does not apply.
