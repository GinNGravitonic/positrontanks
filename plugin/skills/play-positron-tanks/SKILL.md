---
name: play-positron-tanks
description: Play Positron Tanks from start to finish. Install the game from its repository, run a local server, create Maps, Bot Designs and Programs and improve them by self-play there, then sign up or log in on a remote server and upload the finished Maps and designs to it. Use when starting with Positron Tanks from nothing, when asked to "play Positron Tanks", or when publishing locally tested Maps and designs to another server.
---

# Play Positron Tanks end to end

This skill is the entry point. It takes a player from nothing installed to their Maps and Bot Designs on a remote server, tested locally first. The other skills in this plugin do the steps in the middle:

- **create-map**: write a Map file and upload it.
- **create-bot-design**: choose a Build and save it as a Bot Design.
- **write-program**: write a design's Program and save it as a Revision.
- **improve-by-self-play**: make a design stronger against its own best Revision.

Those skills assume the `positrontanks` CLI is on the PATH (`ptanks` is its alias). This skill gets it there, and does not assume the repository has been cloned. The order:

1. install the game and its CLI;
2. start a local server and sign in to it;
3. make and test Maps and designs locally;
4. sign in to the remote server;
5. upload the finished Maps and designs.

## 1. Pin down the brief

Settle, from the request or by asking:

- **What to make**: how many Maps and designs, and what for: a Game format (Players, Bots per Entry, Point Budget, time limit), a role, or "something good".
- **Remote server**: its URL, such as `https://positrontanks.example.com`. Skip steps 6 and 7 if the player only wants to play locally.
- **Account**: whether the player already has an account on the remote server, and its username. Never sign up an account that already exists.
- **Folders**: where to clone the game (default `~/positrontanks`) and where to keep the player's work (default `~/positrontanks-work`, outside the clone).

Done when you know what to make, and the remote server and account, or that there is no remote.

## 2. Install the game

Check the prerequisites:

- **Node.js 24 or later**: `node --version`. If it is older or missing, ask the player to install it (from nodejs.org, or with nvm / nvm-windows).
- **pnpm 12**: `pnpm --version`. If it is missing or older, install it with npm. Do not use corepack: the corepack bundled with Node 24 cannot run pnpm 12.

  ```bash
  npm install -g pnpm@12
  ```

- **git**, to clone.
- **Docker**, optional, for the local server: `docker --version`. Without it, step 3 runs the server from the clone.

Clone and build:

```bash
git clone https://github.com/GinNGravitonic/positrontanks.git ~/positrontanks
cd ~/positrontanks
pnpm install
pnpm build
```

If the clone has no `package.json`, the code has not been published yet. Stop and tell the player.

Link the CLI so `positrontanks` and `ptanks` are on the PATH, from the CLI's package:

```bash
cd ~/positrontanks/packages/cli
npm link
```

This works the same on Windows, macOS and Linux. It puts the commands in npm's global bin folder (`npm prefix -g`; on Windows, `positrontanks.cmd` and `positrontanks.ps1` shims too). If `npm link` fails with a permission error on macOS or Linux, npm's global prefix is a system folder. Ask the player whether to use a user-owned prefix (`npm config set prefix ~/.npm-global`, with `~/.npm-global/bin` on the PATH) rather than running `sudo`. The link points at the clone, so a later `git pull` and `pnpm build` update the CLI with no need to link again.

Done when `positrontanks --help` prints its usage from any folder.

## 3. Start the local server

The local server is where designs are tested with no one else's load or rules. Turn on its tick cost check, which shared servers leave off.

**With Docker** (preferred), from the clone, as in `docs/docker.md`:

```bash
cd ~/positrontanks
docker build -t positrontanks-server .
docker volume create positrontanks-data
docker run -d --name positrontanks -p 8080:8080 -v positrontanks-data:/data -e POSITRONTANKS_TICK_COST_CHECK=on positrontanks-server
```

`docker stop positrontanks` stops it and `docker start positrontanks` brings it back with the same data.

In WSL with Docker Desktop, `docker build` can fail with `docker-credential-desktop.exe: exec format error` when WSL cannot run Windows programs. Build with an empty Docker config instead: `mkdir -p /tmp/dockercfg && echo '{}' > /tmp/dockercfg/config.json`, then `DOCKER_CONFIG=/tmp/dockercfg docker build -t positrontanks-server .`.

**Without Docker**, run the built server from the clone, with its data in a fixed folder. The server's defaults put the data under `./data`, relative to wherever it is started. Run it in the background or in a terminal of its own, since it keeps running:

```bash
cd ~/positrontanks
POSITRONTANKS_TICK_COST_CHECK=on POSITRONTANKS_DATABASE_PATH=$HOME/positrontanks-data/positrontanks.db POSITRONTANKS_STORAGE_DIRECTORY=$HOME/positrontanks-data/objects node packages/server/dist/main.js
```

In PowerShell, set each variable first (`$env:POSITRONTANKS_TICK_COST_CHECK = "on"` and so on). It listens on `http://127.0.0.1:8080` and logs `Server listening` as one JSON line. Stop it with Ctrl+C, or by ending that process. Starting it again with the same paths keeps the data.

Either way, check it:

```bash
positrontanks server health
positrontanks server info
```

`server health` answers `ok` and `server info` shows `tickCostCheck on`. The CLI's `default` profile points at `http://localhost:8080`, so it needs no `config set server`.

Sign up and log in on the local server. Local accounts exist only on the player's own machine, so a generated password piped on stdin is fine here. Follow section 2 of the improve-by-self-play skill, which also sets up the **sparring Player** that self-play needs, in a `sparring` profile. A second account is expected on the local server, which exists for self-play.

Done when `positrontanks auth whoami` names the local Player.

## 4. Make Maps and designs

Keep the player's work in its own folder (`~/positrontanks-work`), with each Map and design as local files. Those files are what gets uploaded in step 7, because ids differ from server to server.

- `maps/<name>.map.json`: each Map file.
- `designs/<name>/build.json` and `designs/<name>/program.ptk`: each design's latest Build and Program.
- `ledger.md`: one line per Map and design, with its local id and later its remote id, such as `Map Arena: local 10e8…, remote bfde…`.

Then, using the other skills:

1. **Maps**: the create-map skill, for each Map the brief asks for. Upload each to the local server, so local Games and self-play can use it.
2. **Designs**: the create-bot-design skill, for each design, on the local server.
3. **Programs**: the write-program skill, for each design. Its offline check, `positrontanks tick-cost --entry <file>`, is also the check to rely on for the remote server, since shared servers turn the tick cost check off.

Done when each Map and design is on the local server, every Program passes `positrontanks tick-cost`, and the ledger lists them.

## 5. Test and improve by self-play

Follow the improve-by-self-play skill for each design, on the Maps, Point Budget and time limit it will play on remotely. Stop by the brief's rule, or after a few cycles with no change winning.

Then bring the work folder up to date with each design's champion, its latest Revision:

```bash
positrontanks designs show <DESIGN_ID> --program-out designs/<name>/program.ptk --build-out designs/<name>/build.json
```

It writes the latest Revision's Program and Build, and its `Ruleset:` line is the design's Ruleset, needed in step 7. Let the CLI write files rather than redirecting its output with `>`: in PowerShell, `>` adds a byte order mark (or writes UTF-16), which JSON readers reject. For a Map, `positrontanks maps show <MAP_ID> --out maps/<name>.map.json` writes the latest Revision's file.

Done when every design has beaten its earlier Revisions locally, and the work folder holds each Map's and design's latest files.

## 6. Sign in to the remote server

Give the remote server its own profile, so local commands keep going to the local server:

```bash
positrontanks config use remote
positrontanks config set server <REMOTE_URL>
positrontanks config use default
positrontanks server health --profile remote
```

`positrontanks rulesets list --profile remote` lists the Rulesets the remote hosts. Check that each design's Ruleset (printed in step 5) is among them.

The remote account is the player's own, on a shared server. There the player has exactly one account: never sign up a sparring Player there, and never play self-play Games there. **The player types the password**, not you. Do not generate, choose, store or pipe it. Ask the player to run the commands in their own terminal, where the CLI prompts for the password:

- **No account yet**: first sign up, then log in.

  ```bash
  positrontanks auth signup <USERNAME> --profile remote
  positrontanks auth login <USERNAME> --profile remote
  ```

- **Has an account**: only `auth login`. If `auth signup` refuses with `username_taken`, the player most likely has an account already. Ask before trying another name.

`auth login` stores an API key in the `remote` profile. You need no password from then on. If the player already has an API key, `positrontanks auth use-key --profile remote` stores it instead; the player pastes it at the prompt.

Both commands end with `on <server>`: check with the player that it is the remote URL. If it says `http://localhost:8080`, the player's terminal is not reading the config file you set the `remote` profile in. This happens when your commands run in a sandbox that keeps its own copy of the user's config folder (`%APPDATA%` or `~/.config`). Then run every command that needs the `remote` profile, from `config use remote` on, in a terminal the player also uses (in Claude Desktop, its Terminal panel), and have the player sign up and log in there. A Player signed up on the local server by mistake does no harm.

Done when `positrontanks auth whoami --profile remote` names the player's remote Player.

## 7. Upload

Upload from the work folder's files, with `--profile remote` on every command. Never pass local ids to the remote server: each server has its own ids.

**Maps**. A Map not on the remote yet:

```bash
positrontanks maps create --name "<name>" --map maps/<name>.map.json --notes "tested locally" --profile remote --json
```

Keep the output's `id` in the ledger. A Map uploaded before gets a new Revision: `positrontanks maps revise <REMOTE_MAP_ID> --map maps/<name>.map.json --profile remote`. The Map Format is the same on every server, so the file goes up unchanged.

**Designs**. A design's Program is part of its Revision, so it goes up together with the Build. A design not on the remote yet:

```bash
positrontanks designs create --name "<name>" --ruleset <RULESET> --build designs/<name>/build.json --program designs/<name>/program.ptk --notes "<what self-play showed, such as: beat R3 7-1-2 locally on Arena>" --profile remote --json
```

Keep the output's `id` in the ledger. A design uploaded before gets a new Revision: `positrontanks designs revise <REMOTE_DESIGN_ID> --build designs/<name>/build.json --program designs/<name>/program.ptk --notes "..." --profile remote`.

If the remote does not host the design's Ruleset, it is on a different version of the game. When the remote hosts a newer Ruleset, update the clone (`git pull`, `pnpm install`, `pnpm build`, and rebuild the Docker image), then `positrontanks designs copy <DESIGN_ID> --ruleset <VERSION> --dry-run` on the local server shows what the copy would change. Copy it, test it again (step 5), and upload the copy. When the remote hosts only older Rulesets, ask the player which to target.

Refusals are reported as in the create-map, create-bot-design and write-program skills. A remote server can have tighter limits than the local one, such as a smaller largest Map. Fix the file, check it locally again, and upload again.

Done when the ledger has a remote id for each Map and design, and `positrontanks maps list --mine --profile remote` and `positrontanks designs list --profile remote` show them all.

## 8. Report

Report:

- what was installed and where (the clone, the CLI link) and how the local server runs (Docker or from source), with how to stop and start it;
- each Map and design: what it is, its local and remote ids, its Revision on each server, and its self-play results;
- anything left undone, such as a design the remote refused or a Ruleset mismatch.

To play a Game on the remote, `positrontanks games browse --profile remote` lists Open Games, and `positrontanks games enter <GAME_ID> --bot <NAME>=<REMOTE_DESIGN_ID> --profile remote` enters one. `games create` opens a new Game for others to join.

Done when the report is given.
