# API CLI

The API CLI extends the `positrontanks` binary (`packages/cli`; `ptanks` is a short alias for it) with commands that talk to a Positron Tanks server over its HTTP API ([v1.md section 9](v1.md#9-api)). It is meant for humans and LLM agents alike: every command has a human output and a JSON output, and the JSON output is the server's own response body, so the OpenAPI document (`GET /openapi.json`) describes it. The local commands `positrontanks run` and `positrontanks tick-cost` ([cli-runner.md](cli-runner.md)) are unchanged and still need no server. Vocabulary follows [GLOSSARY.md](../../GLOSSARY.md).

## Command tree

```
positrontanks <group> <command> [arguments] [options]
```

One group per API area, then a verb. Positional arguments are the ids a command acts on; everything else is an option. Ids are the server's ids (UUIDs); the CLI does not resolve names.

### server

| Command | Endpoint |
| --- | --- |
| `server info` | `GET /server` (features, such as `tickCostCheck`) |
| `server health` | `GET /health` |
| `server openapi [--out FILE]` | `GET /openapi.json` |

### auth: accounts and sessions

| Command | Endpoint |
| --- | --- |
| `auth signup USERNAME [--password-stdin]` | `POST /players` |
| `auth login USERNAME [--password-stdin] [--key-name NAME]` | `POST /sessions`, `POST /api-keys`, `DELETE /sessions/current` (see [Credentials](#credentials)) |
| `auth use-key [--api-key-stdin]` | none; stores an existing API key in the profile, then checks it with `GET /players/me` |
| `auth logout` | `DELETE /api-keys/{id}` for the profile's own key, then forgets it |
| `auth whoami` | `GET /players/me` |

A password is never taken as an option (it would show in the process list and shell history). Without `--password-stdin` the CLI prompts on the terminal without echo; with no terminal and no `--password-stdin`, it is a usage error. `signup` does not log in; follow it with `login`.

### keys: API keys

| Command | Endpoint |
| --- | --- |
| `keys create NAME` | `POST /api-keys`; prints the key once, does not store it |
| `keys list` | `GET /api-keys` |
| `keys revoke KEY_ID` | `DELETE /api-keys/{apiKeyId}` |

### players: your Player

| Command | Endpoint |
| --- | --- |
| `players emblem set FILE` | `PUT /players/me/emblem`, with the file as a raw `image/png` body |
| `players emblem clear` | `DELETE /players/me/emblem` |

The server checks the Emblem (a square PNG, 32 to 256 pixels a side, at most 64 KB) and answers `validation_failed` for any other file; the CLI sends the file as is. Clearing an Emblem you do not have is not an error.

### rulesets

| Command | Endpoint |
| --- | --- |
| `rulesets list` | `GET /rulesets` |
| `rulesets show VERSION` | `GET /rulesets/{version}` |
| `rulesets rules VERSION` | `GET /rulesets/{version}/rules` |
| `rulesets language VERSION` | `GET /rulesets/{version}/language` |
| `rulesets parts VERSION` | `GET /rulesets/{version}/parts` |
| `rulesets terrains VERSION` | `GET /rulesets/{version}/terrains` |
| `rulesets docs VERSION [DOC]` | `GET /rulesets/{version}/docs`, or `.../docs/{engine\|language\|catalog}` |

`rulesets docs VERSION DOC` prints the Markdown as is, in both output modes (it is not JSON). It is the way for an agent to read the rules it plays under.

### designs: the Garage

| Command | Endpoint |
| --- | --- |
| `designs create --name NAME --build FILE --program FILE [--ruleset VERSION] [--description TEXT] [--notes TEXT]` | `POST /bot-designs` |
| `designs list [--include-archived]` | `GET /bot-designs` |
| `designs show DESIGN_ID [--program-out FILE]` | `GET /bot-designs/{designId}` |
| `designs update DESIGN_ID [--name NAME] [--description TEXT]` | `PATCH /bot-designs/{designId}` |
| `designs revise DESIGN_ID [--build FILE] [--program FILE] [--notes TEXT]` | `POST /bot-designs/{designId}/revisions` |
| `designs revisions DESIGN_ID` | `GET /bot-designs/{designId}/revisions` |
| `designs revision DESIGN_ID N [--program-out FILE]` | `GET /bot-designs/{designId}/revisions/{revision}` |
| `designs delete-revision DESIGN_ID N` | `DELETE /bot-designs/{designId}/revisions/{revision}` |
| `designs copy DESIGN_ID --ruleset VERSION [--revision N] [--name NAME] [--notes TEXT] [--dry-run]` | `POST /bot-designs/{designId}/copies` |
| `designs archive DESIGN_ID` | `DELETE /bot-designs/{designId}` |
| `designs tick-cost DESIGN_ID [--revision N] [--ticks N] [--seed N]` | `POST /bot-designs/{designId}/tick-cost-checks` |
| `designs icon set DESIGN_ID FILE` | `PUT /bot-designs/{designId}/icon`, with the file as a raw `image/png` body |
| `designs icon clear DESIGN_ID` | `DELETE /bot-designs/{designId}/icon` |

- `--build FILE` is a Build as JSON, the shape the server takes (and an [Entry file](cli-runner.md#entry-file)'s `bots[].build`). `--program FILE` is Program source, conventionally `.ptk`. Either may be `-` for stdin (at most one per command).
- `designs revise` sends the latest Revision's Build or Program for the half not given, so changing only the Program is `designs revise ID --program hunter.ptk`. Giving neither is a usage error.
- `--ruleset` defaults to the latest Ruleset the server hosts (the last of `GET /rulesets`).
- `--program-out FILE` writes the Program source to a file, so a design can be pulled, edited and revised. Human output otherwise shows the Build and the Program's length, not its source.
- `designs icon set` sends the file as is; the server checks it (the same limits as an Emblem: a square PNG, 32 to 256 pixels a side, at most 64 KB) and answers `validation_failed` for any other file. The Icon belongs to the design, not a Revision, so setting it adds no Revision, and archived designs can be changed too. Clearing an Icon the design does not have is not an error.
- `designs tick-cost` answers `410 feature_disabled` on servers without the feature; the error message points to `positrontanks tick-cost --entry FILE`, the offline equivalent.

The ad hoc check `POST /tick-cost-checks` (a Build and Program that are not a design) is `positrontanks tick-cost --entry FILE --remote`: the same input and output as the offline command, run on the server instead. Without `--remote`, `tick-cost` stays offline.

### maps

| Command | Endpoint |
| --- | --- |
| `maps create --name NAME --map FILE [--description TEXT] [--notes TEXT]` | `POST /maps` |
| `maps list [--creator USERNAME] [--mine] [--include-archived]` | `GET /maps` (`--mine` is `--creator` set to yourself) |
| `maps show MAP_ID [--out FILE]` | `GET /maps/{mapId}` |
| `maps update MAP_ID [--name NAME] [--description TEXT]` | `PATCH /maps/{mapId}` |
| `maps revise MAP_ID --map FILE [--notes TEXT]` | `POST /maps/{mapId}/revisions` |
| `maps revisions MAP_ID` | `GET /maps/{mapId}/revisions` |
| `maps revision MAP_ID N [--out FILE]` | `GET /maps/{mapId}/revisions/{revision}` |
| `maps delete-revision MAP_ID N` | `DELETE /maps/{mapId}/revisions/{revision}` |
| `maps archive MAP_ID` | `DELETE /maps/{mapId}` |

`--map FILE` is Map Format JSON, the same file `positrontanks run --map` reads, so a Map tried locally is uploaded unchanged. `--out FILE` writes the Map Format JSON of the Revision shown. Map reads need no credentials.

### games: Games, Entries and spectating

| Command | Endpoint |
| --- | --- |
| `games create --map MAP_ID [options]` | `POST /games` |
| `games browse [--ruleset VERSION] [--map MAP_ID] [--players N] [--min-budget N] [--max-budget N]` | `GET /games` (Open Games) |
| `games mine [--state open,running,...]` | `GET /players/me/games` |
| `games show GAME_ID` | `GET /games/{gameId}` |
| `games cancel GAME_ID` | `POST /games/{gameId}/cancel` |
| `games enter GAME_ID --bot NAME=DESIGN_ID[@REV] [--bot ...]` | `POST /games/{gameId}/entries` |
| `games withdraw GAME_ID ENTRY_ID` | `DELETE /games/{gameId}/entries/{entryId}` |
| `games snapshot GAME_ID` | `GET /games/{gameId}/snapshot` |
| `games watch GAME_ID` | `GET /games/{gameId}/stream` (SSE) |
| `games replay GAME_ID [--out FILE]` | `GET /games/{gameId}/replay` |
| `games logs GAME_ID [--from-tick N] [--to-tick N] [--out FILE]` | `GET /games/{gameId}/program-logs` |

`games create` options and defaults. The defaults match `positrontanks run` where the two overlap, so a Game tried locally can be created with the same settings:

| Option | Default |
| --- | --- |
| `--map MAP_ID` | Required. |
| `--map-revision N` | The latest (the server's default). |
| `--ruleset VERSION` | The latest Ruleset the server hosts. |
| `--players N` | `2` |
| `--point-budget N` | The Ruleset's maximum Point Budget (read from `GET /rulesets/{version}`). |
| `--time-limit SECONDS` | `120` |
| `--unthrottled` | Real-time Pace. |
| `--fill-timeout SECONDS` | `3600` |

`--bot NAME=DESIGN_ID[@REV]` is one Bot of the Entry, in order: its Bot Name, its design and optionally a Revision (else the latest). Give one per Bot. A Bot Name containing `=` cannot be given this way; `--entry-json FILE` sends a whole `NewGameEntry` body instead, for that case and for agents that build the body themselves.

`games watch` follows the stream until `end`, then prints the result and exits 0. When the stream closes without `end` (a server restart, or the client fell behind), it reconnects for a fresh snapshot, up to 5 times in a row with backoff (1, 2, 4, 8, 16 s), resetting the count whenever an event arrives. The human output is the Tick-by-Tick Disabled announcements and the result, as `positrontanks run` prints them. `--out FILE` writes the Replay assembled from the stream (the snapshot plus its `tick`s, as v1.md describes), which for a Game watched from the start is the full Replay. A Game that is not yet Running is an error (`game_not_started`) unless `--wait` is given, which polls `GET /games/{gameId}` every 5 s until it starts or ends.

`games replay` and `games logs` write compact JSON to `--out` (as `positrontanks run` writes `replay.json` and `program-logs.json`), or print it to stdout without `--out`.

### api: the escape hatch

```
positrontanks api METHOD PATH [--body FILE] [--query KEY=VALUE ...]
```

Sends one request with the profile's server and credentials and prints the response body as is. It covers any endpoint a later server adds before the CLI has a command for it, and lets an agent use the OpenAPI document directly.

## Configuration

### Profiles

A profile is a server URL plus, optionally, a credential. The config file holds named profiles and which one is current:

```json
{
  "currentProfile": "local",
  "profiles": {
    "local": { "server": "http://localhost:8080", "apiKey": "...", "apiKeyId": "...", "username": "alice" },
    "hosted": { "server": "https://positrontanks.example.com" }
  }
}
```

| Command | Effect |
| --- | --- |
| `config show` | The current profile and its settings, with the API key masked. |
| `config profiles` | Every profile, marking the current one. |
| `config use PROFILE` | Makes PROFILE current, creating it if missing. |
| `config set server URL` | Sets the current profile's server. |
| `config remove PROFILE` | Deletes a profile (does not revoke its key; `auth logout` does). |

The file is `$XDG_CONFIG_HOME/positrontanks/config.json` (default `~/.config/positrontanks/config.json`) on Linux and macOS and `%APPDATA%\positrontanks\config.json` on Windows. It is written with mode 0600 where the platform has modes, since it holds API keys. There is no OS keychain integration: it would need a native dependency, and agents in containers rarely have a keychain.

With no config file the CLI behaves as if there were one profile, `default`, with server `http://localhost:8080` (the Docker image's default port, [docker.md](../docker.md)) and no credential.

### Precedence

Each setting is taken from the first of:

1. Options: `--server URL`, `--profile NAME`, `--api-key-stdin` (any command).
2. Environment: `POSITRONTANKS_SERVER`, `POSITRONTANKS_API_KEY`, `POSITRONTANKS_PROFILE`.
3. The chosen profile in the config file.
4. The built-in default above.

`POSITRONTANKS_API_KEY` lets an agent or CI job run with no config file at all. A key given by option or environment is never written to the config file.

### Credentials

The CLI stores API keys, not session tokens: a session token expires after hours, and an agent should not have to log in again mid-task. `auth login` therefore logs in for a session, creates an API key named `--key-name` (default `positrontanks-cli on <hostname>`), stores the key and its id in the profile, and ends the session. `auth use-key` stores a key the Player already has, and finds its id by matching the key's start against each `prefix` in `GET /api-keys`. `auth logout` revokes the profile's key by that id and removes it from the profile. A key given only by option or environment is never revoked by the CLI; `keys revoke` does that explicitly.

Commands that need a credential and have none fail with exit code 3 before sending anything.

## Output

### Human and JSON

Human output is the default. `--json` (on any command, or `POSITRONTANKS_OUTPUT=json` in the environment) switches to JSON. The CLI does not switch by itself when stdout is not a terminal: an agent asks for JSON explicitly, and a human piping to `less` keeps the tables.

- **Human**: a table for lists (id, name and the few fields that matter, with ids in full so they can be copied), `key: value` lines for single items, a one-line confirmation for actions (`Archived Bot Design 3f2c...`). Times are local and relative where it helps (`2 min ago`). Nothing in human output is a stable interface.
- **JSON**: stdout is exactly the server's response body, pretty-printed, so the OpenAPI document is its schema. A `204 No Content` response prints `{}`. Commands that combine requests print the last one's body (`auth login`: the created API key, with its secret masked; `games create`: the Game). `games watch --json` prints NDJSON, one object per SSE event: `{"event": "snapshot" | "tick" | "end", "id": ..., "data": ...}`, plus `{"event": "reconnect", "attempt": N}` when it reconnects.

Text that is not JSON (`rulesets docs VERSION DOC`, `server openapi` with `--out`) prints as is in both modes.

### Paging

List commands take `--limit N` and `--cursor CURSOR`, passed to the server. By default a list command fetches one page (the server's 50); `--all` follows `nextCursor` to the end and prints one merged list, with `nextCursor` null in JSON. In human output, a list with more pages ends with a hint on stderr: `More: --cursor <cursor> (or --all)`.

### Errors

Errors go to stderr; stdout stays empty, so an agent never mistakes an error for a result.

- **Human**: `positrontanks: <code>: <message>`, then one line per `details` entry: `  <path>: <message>`, with `line:column` for Program problems. For a Program given as a file, the path is shown as `hunter.ptk:12:5`, matching the local runner.
- **JSON**: stderr is the server's error body as is (`{"error": {"code", "message", "details"?}}`). Errors the CLI raises itself use the same shape with its own codes: `usage`, `not_authenticated`, `config`, `network`, `bad_response`, `input` (an unreadable or malformed local file).

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | The request was refused: a 4xx response other than 401 (validation, not found, conflict, `feature_disabled`), or a bad local input file. |
| 2 | Bad usage: unknown command or option, missing argument. As for `run`. |
| 3 | Not authenticated: no credential, or a 401 response. |
| 4 | Server or network failure: unreachable server, timeout, 5xx, or a response that is not the expected JSON. Worth retrying; codes 1 to 3 are not. |

Codes 0 to 2 keep their meaning for `run` and `tick-cost`.

## HTTP client

The client is hand-written over Node's `fetch`, with no runtime dependency, and typed from the OpenAPI document:

- The CLI's request and response types are generated from the OpenAPI document by `openapi-typescript` (a dev dependency; types only, no generated runtime code). The generator reads a committed snapshot, `packages/cli/src/api/openapi.json`, so building the CLI does not need a running server.
- A test builds the document from the server's `apiModules` (`@positrontanks/server`, a dev dependency of the CLI, served in-process) and fails if the snapshot, or the types generated from it (`src/api/schema.ts`), differ, so neither can drift from the server. Regenerating both is one script, `pnpm --filter @positrontanks/cli gen:api` (after `pnpm build`). The dependency runs one way, CLI to server: tests that compare the CLI with the server live in the CLI.
- One function, `request(method, path, { query, body })`, sets the base URL, `Authorization: Bearer <key>`, a 30 s timeout (none for the stream), and turns non-2xx responses into the shared error format. The SSE stream is read with `fetch` and a small line parser, as the `streamGame` operation's description recommends for browsers, rather than `EventSource`, which cannot send an `Authorization` header.

A full generated client (`openapi-generator` and the like) is not used: it adds a large runtime surface for some forty plain JSON endpoints, and the commands, not the client, are where the work is. Arguments are parsed with `node:util` `parseArgs`, as `run` and `tick-cost` already are.

## Testing

Command tests run the CLI's `main` (as `cli.test.ts` does) against an in-process server: `createApp` from `@positrontanks/server` over a temporary SQLite database and storage directory, on an ephemeral port. They check both output modes and the exit codes. Tick cost tests start that server with the tick cost check on, and one test with it off checks the `feature_disabled` path.

## Out of scope

- Resolving designs, Maps or Games by name or id prefix. Ids are copied from list output; a later version may add name lookup.
- Interactive prompts beyond the password prompt. Every command can run unattended.
- Watching more than one Game, or `games mine --watch`. An agent runs several `games watch` processes.
- Shell completion.
- Webhooks, which the v1 server does not have.
