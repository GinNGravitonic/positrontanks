---
name: improve-by-self-play
description: Improve a Bot Design's Program or Build by self-play. Play a candidate change against the design's best Revision so far in seeded local Games, read the results, Replays and Program logs to find what loses, then save the winner as a new Revision and confirm it in Games on a local server. Use when asked to make a design stronger, tune its tactics or Build, compare Revisions, or find out why a design loses.
---

# Improve a design by self-play

Self-play here means pitting a design against its own **champion**, the best Revision so far, then changing one thing at a time and keeping a change only when it wins. Each cycle:

1. play the champion and read what decides its Games;
2. make one change to the Program or the Build;
3. play the candidate against the champion in a series of seeded local Games (`positrontanks run`, no server needed, seconds per Game);
4. if the candidate wins the series, save it as a new Revision and confirm it in server Games against the champion's Revision.

This skill assumes the `positrontanks` CLI is installed (`ptanks` is its alias) and Node.js 24 or later, which the CLI needs anyway, for the bundled scripts. Making the change itself is the job of two other skills: write-program for the Program, create-bot-design for the Build. This skill says what to change and whether it worked.

## 1. Pin down the brief

Settle, from the request or by asking:

- **Design**: the Bot Design's id, and which Revision is the champion (the latest, unless told otherwise).
- **Battleground**: the Map, Point Budget and time limit to judge on. Use the ones the design will really play on. Results on one Map do not carry over to another, so keep to one for the whole run.
- **What may change**: the Program only, or the Build too. A Build change costs points and may need Program changes to use it.
- **Opponents**: the champion itself (the default); earlier Revisions too; other designs of the Player's, as a check that a change is not tuned to beat only itself.
- **Stop when**: a number of cycles, a win rate to reach, or no change winning for two or three cycles in a row.

Done when you can state the design, the Map, the Point Budget and time limit, what may change and when to stop.

## 2. Set up the local server

Self-play Games on the server need **two Players**. The win condition counts Players, not Entries: the Game ends when at most one Player has a Bot left standing. Two Entries of the same Player therefore end the Game at Tick 0, a "win" by survival with no shot fired. A Player can also enter only their own designs. So a second account, the **sparring Player**, holds a copy of the champion and plays it.

Start a server with Docker, as in [docs/docker.md](../../docs/docker.md) (from the Positron Tanks repository, `docker build -t positrontanks-server .` first):

```bash
docker volume create positrontanks-data
docker run -d --name positrontanks -p 8080:8080 -v positrontanks-data:/data -e POSITRONTANKS_TICK_COST_CHECK=on positrontanks-server
```

`positrontanks server health` answers once it is up. The CLI's default profile points at `http://localhost:8080`. Sign up both Players, each in its own profile, with passwords piped on stdin:

```bash
positrontanks auth signup <you> --password-stdin
positrontanks auth login <you> --password-stdin
positrontanks config use sparring
positrontanks config set server http://localhost:8080
positrontanks auth signup <you>-sparring --password-stdin
positrontanks auth login <you>-sparring --password-stdin
positrontanks config use default
```

From then on, `--profile sparring` on any command acts as the sparring Player. If the design lives on another server, pull it with `designs show <DESIGN_ID> --program-out` on that server's profile and `designs create` it here; save the final result back there at the end.

Upload the Map (`positrontanks maps create --name <name> --map <file> --json`, keeping its `id`), or reuse a Map already on the server with `maps show <MAP_ID> --out <name>.map.json` to get its file for local Games.

Done when both profiles answer `positrontanks auth whoami` and you have the Map's id and its file.

## 3. Lay out the workspace

Keep everything for the run in one folder:

- `<map>.map.json`: the Map.
- `r<N>.build.json` and `r<N>.ptk` for each Revision played, pulled with `positrontanks designs revision <DESIGN_ID> <N> --json --program-out r<N>.ptk` (save the JSON's `build` as `r<N>.build.json`).
- `r<N>.entry.json`: one Entry file per Revision, with a Player name and a Bot Name that both say which Revision it is:

  ```json
  { "ruleset": "r1", "player": "r3", "bots": [{ "name": "R3", "build": <r3.build.json>, "programFile": "r3.ptk" }] }
  ```

  For a multi-Bot design Entry, list every Bot, each with its own Bot Name (`R3-tank`, `R3-scout`).
- `c<K>.ptk`, `c<K>.build.json` and `c<K>.entry.json` for each candidate, numbered 1, 2, 3 ... in the order tried, with Player `c<K>` and Bot Name `C<K>`. A candidate that is kept becomes a Revision and gets `r<N>` files too.
- `results.md`: one line per series played, such as `C2 vs R3, arena, 800 pts, 10 Games: C2 won 7, drew 1, lost 2. Fewer side hits; still stuck on rocks. Kept as R4.`

Done when the champion has its Entry file.

## 4. Play and measure

Two bundled scripts do the measuring.

[`series.mjs`](series.mjs) plays a series of local Games between two Entry files with `positrontanks run`, on seeds 1 to N and swapping the Entry order every other Game, then sums them up:

```bash
node <this skill's folder>/series.mjs --map <map>.map.json --entry c2.entry.json --entry r3.entry.json --games 10 --point-budget <P> --time-limit <S> --out series/c2-vs-r3
```

Any other `positrontanks run` option is passed through. Each Game's `replay.json`, `program-logs.json` and `game-record.json` go to `<out>/<seed>/`, so any one Game can be looked at or replayed with the same seed. Set `POSITRONTANKS_CLI` if the CLI is not on the PATH as `positrontanks`.

[`replay-stats.mjs`](replay-stats.mjs) sums up any Replays, local or from the server, per Bot Name:

```bash
node <this skill's folder>/replay-stats.mjs [--json] <replay.json> [<replay.json> ...]
```

For each Bot it reports Games won, drawn and lost and how often it survived; shots fired and where they ended (on Foes, Friends or Obstacles, or out of range); Foe damage dealt and damage taken, with what Armor absorbed and which side was struck; collisions with Bots and with Obstacles, wrecks or the boundary; how much of the time it stood still; and the Tick and cause of each Disabling.

First play the champion against itself (`--entry r3.entry.json --entry r3-mirror.entry.json`, a copy with another Player and Bot Name). A mirror should come out about even. It shows how noisy the results are, and how the champion's Games are decided: on survival or on damage at the time limit, and how fast. Many mirror Games end in a Draw by mutual destruction, since two identical Bots run the same damage race.

Done when you have the mirror series' stats and know what decides the champion's Games.

## 5. Find what to change

Read the stats, then look into single Games. A Replay is one line of JSON: `entries` (the Bots' ids, names and Builds), `ticks` (per Tick: every Bot's `x`, `y`, `heading`, `speed`, `hitPoints` and `status`, the Projectiles in flight, and `events`) and `result`. `program-logs.json` has, per Bot and Tick, the operations used, any runtime error and the `log` lines. Add `log` calls to a candidate's Program to see what it decided, such as which branch ran and which contact it targeted.

What the stats point to:

| Stat | Likely cause | Try |
| --- | --- | --- |
| Few shots for the Game's length | The Foe sits outside the Firing Arc, or Obstacles block the line of fire | Keep the Foe inside half the `arcWidth` while weapons are ready; move to clear the line of fire |
| Many shots on Obstacles or out of range | Firing through cover or past `range` | Check the line to the Foe; close in |
| Shots on Foes but a low share of shots | The Foe moves across the line of fire | Lead the target (write-program skill) |
| Damage taken on the sides or rear | The Bot turns its weak sides to the Foe | Face the Foe with the best Armor; or move that Armor to the side that is struck (a Build change) |
| Collisions with Obstacles, wrecks or the boundary | Stuck, or reversing blind | Unstick logic; plan around `map.obstacles`; do not reverse toward the boundary |
| Standing still most of the time while losing | An easy target | Move while firing, if it keeps the guns on target |
| Out of budget, errors or a halt in the run output | The Program fails, not the tactics | Fix it first (write-program skill) |
| Every Game a Draw or decided by a few points | The two are even | Change something larger, or change the Build |

Compare the winner's numbers with the loser's. The stat with the widest gap usually says what decided the Games. Pick **one** change that should move it. Two changes at once leave you unsure which helped.

Done when you can name the change and the stat it should move.

## 6. Make the change

Write the candidate as `c<K>.ptk`, starting from a copy of the champion's (and `c<K>.build.json` for a Build change, else a copy of the champion's Build), and its `c<K>.entry.json`. Follow the write-program skill for Programs, including its offline check:

```bash
positrontanks tick-cost --entry c<K>.entry.json --ticks 100
```

Follow the create-bot-design skill for Builds; its cost check matters, since the Entry must fit the Point Budget.

Done when the candidate passes the tick cost check.

## 7. Judge it offline

Play the candidate against the champion:

```bash
node <this skill's folder>/series.mjs --map <map>.map.json --entry c<K>.entry.json --entry r<N>.entry.json --games 10 --point-budget <P> --time-limit <S> --out series/c<K>-vs-r<N>
```

Did the stat you aimed at move? If not, the change did not do what you meant. Look at a Game or two before trying something else.

Keep the candidate only if it **wins clearly**: at least 6 of 10 Games with more wins than losses, or, when most Games are Draws, more Foe damage and less damage taken. For a close result, play 20 more Games before deciding. Ten Games of an even match often split 6 to 4 by chance. If other opponents are part of the brief, play them too; a candidate that beats the champion but loses to the rest is not better.

Write the result to `results.md` either way. A rejected candidate is still a finding: it says what does not work against this design.

Done when the candidate is kept or dropped, with the series result written down.

## 8. Save and confirm on the server

Save a kept candidate as the design's next Revision. Put the evidence in the notes:

```bash
positrontanks designs revise <DESIGN_ID> --program c<K>.ptk --notes "<the change>; beat R<N> 7-1-2 in 10 local Games on <map>" --json
```

Add `--build c<K>.build.json` for a Build change. Rejections are reported as in the write-program skill. The output's `number` is the new Revision's number, `M` below (usually N+1). Copy the candidate's files to `r<M>.ptk`, `r<M>.build.json` and `r<M>.entry.json`, with Player `r<M>` and Bot Name `R<M>`, for later series.

Give the sparring Player the old champion. The first time, create its copy of the design. After that, revise the same copy:

```bash
positrontanks designs create --name "<design> sparring" --build r<N>.build.json --program r<N>.ptk --notes "copy of <DESIGN_ID>@<N>" --profile sparring --json
positrontanks designs revise <SPARRING_DESIGN_ID> --build r<N>.build.json --program r<N>.ptk --notes "copy of <DESIGN_ID>@<N>" --profile sparring --json
```

Then play a few server Games, each one like this:

```bash
positrontanks games create --map <MAP_ID> --players 2 --point-budget <P> --time-limit <S> --unthrottled --json
positrontanks games enter <GAME_ID> --bot R<M>=<DESIGN_ID>@<M>
positrontanks games enter <GAME_ID> --bot R<N>=<SPARRING_DESIGN_ID> --profile sparring
positrontanks games watch <GAME_ID> --wait
positrontanks games replay <GAME_ID> --out server/<GAME_ID>.replay.json
positrontanks games logs <GAME_ID> --out server/<GAME_ID>.logs.json
```

The Game starts once the second Entry is in; `games watch` prints the result. An unthrottled Game is often over before `watch` connects, so its `--out` would hold only the tail of the Game. Fetch the whole Replay with `games replay` after the Game ends. `games logs` gives only your own Bots' Program logs; add `--profile sparring` for the champion's. Then sum up the server Games:

```bash
node <this skill's folder>/replay-stats.mjs server/*.replay.json
```

The server picks each Game's seed, so these Games are not the local ones replayed. They play the saved Revisions through the server, which is the check: they should agree with the local series. If they disagree, play more Games before trusting either result.

Done when the new Revision R<M> is saved, the sparring Player holds the old champion, and the server Games are summed up.

## 9. Repeat and report

The new Revision is the champion. Go back to step 5 with the stats of its series and repeat until the brief's stopping rule is met. When a few candidates in a row lose, try a bigger change: a different tactic, a Build change, or a new role. A champion that keeps winning has earned its place.

`positrontanks designs revisions <DESIGN_ID>` lists the Revisions with their notes. Report, from `results.md`:

- the design's `id` and the champion's Revision number;
- each Revision or candidate played, what it changed, and its series results (won, drawn and lost, on which Map and Point Budget), kept or dropped;
- the server Games' results for each saved Revision;
- what you learned about the design: what decides its Games, and what did not help.

Done when the report is given and the champion is the design's latest Revision.

Stop the server with `docker stop positrontanks` when finished. `docker start positrontanks` brings it back with the same data for the next run.
