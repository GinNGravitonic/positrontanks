# Claude Code plugin

The Claude Code plugin `positron-tanks` lives in `plugin/`: its manifest is `plugin/.claude-plugin/plugin.json` and its skills are the folders under `plugin/skills/`. The repository is also a one-plugin marketplace of the same name, `.claude-plugin/marketplace.json`, whose one plugin is `./plugin`. The skills:

| Skill | What it does |
| --- | --- |
| `play-positron-tanks` | The entry point: install the game and its CLI, run a local server, make and test Maps and designs, then upload them to a remote server. |
| `create-map` | Write a Map file, check it, and upload it. |
| `create-bot-design` | Choose a Build within a Point Budget and save it as a Bot Design. |
| `write-program` | Write a design's Program, check it against the Operation Budget, and save it as a Revision. |
| `improve-by-self-play` | Make a design stronger against its own best Revision by seeded self-play. |

Installed, they are named `positron-tanks:<skill>`, such as `/positron-tanks:play-positron-tanks`.

## Install

From GitHub, in Claude Code:

```
/plugin marketplace add GinNGravitonic/positrontanks
/plugin install positron-tanks@positron-tanks
```

or from a shell:

```bash
claude plugin marketplace add GinNGravitonic/positrontanks
claude plugin install positron-tanks@positron-tanks
```

Start a new session to load the skills. `claude plugin details positron-tanks@positron-tanks` lists them. `claude plugin update positron-tanks@positron-tanks` picks up a newer version, after `claude plugin marketplace update positron-tanks`.

Installing copies only `plugin/` into Claude Code's plugin cache: the skills and the files they bundle, not the game. The game runs from the player's own clone, which the `play-positron-tanks` skill makes (see [Setup](#setup)). So a skill never links to a file elsewhere in the repository; it names the file's path in the clone instead, such as `packages/cli/examples` in `~/positrontanks`.

To try the skills from a working checkout without installing, load the plugin folder for one session:

```bash
claude --plugin-dir /path/to/positrontanks/plugin
```

## Setup

The plugin itself needs no configuration. The skills drive the `positrontanks` API CLI ([spec/cli-api.md](spec/cli-api.md)), which the plugin does not install. The `play-positron-tanks` skill does that setup, so in a new environment start there ("play Positron Tanks"). It covers:

- **CLI**: Node.js 24 or later and pnpm 12 (`npm install -g pnpm@12`, not corepack), then clone, `pnpm install`, `pnpm build`, and `npm link` in `packages/cli`, which puts `positrontanks` and `ptanks` on the PATH.
- **Local server**: the Docker image ([docker.md](docker.md)) or the built server, with `POSITRONTANKS_TICK_COST_CHECK=on`. The CLI's `default` profile points at `http://localhost:8080`.
- **Remote server URL**: a profile of its own, `positrontanks config use remote` and `positrontanks config set server <URL>`, so commands go to the local server unless given `--profile remote`.
- **API key**: `positrontanks auth login <USERNAME>` creates one and stores it in the profile; `positrontanks auth use-key` stores an existing one. On a shared server the player types the password or key at the CLI's prompt, never the agent.

The other four skills assume the CLI is on the PATH and the profile is signed in.

## Releasing

Bump `version` in `plugin/.claude-plugin/plugin.json` when the skills change, since installed copies update only to a new version. `claude plugin validate .` checks the marketplace and `claude plugin validate plugin` the plugin.
