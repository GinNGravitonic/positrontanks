# Issue tracker: Beads (bd)

Issues and specs for this repo live in **beads**, a local Dolt-backed tracker driven by the `bd` CLI. There is no git remote, so do not push, pull, or run remote sync. Run `bd prime` for the full command reference.

Never track work in markdown files, TodoWrite, or `.scratch/`; beads is the only tracker.

## Conventions

- A feature or spec is an **epic**: `bd create --type=epic --title=... --description=...`. The spec body goes in `--description` (use `--design` for design decisions, `--acceptance` for acceptance criteria).
- Implementation tickets are children of the epic: `bd create --type=task|bug|feature --parent=<epic-id> ...`, one issue per ticket.
- Priority is `0`-`4` (0 = critical, 2 = medium, 4 = backlog), never "high"/"low".
- Triage state is a **label**: `bd label add <id> <label>` / `bd label remove <id> <label>` (see `triage-labels.md` for the strings).
- Conversation history goes in comments: `bd comments add <id> "..."`; read with `bd comments <id>`.
- Never use `bd edit` (it opens an interactive editor); use `bd update <id> --description/--notes/--design/...`.

## When a skill says "publish to the issue tracker"

Create the issue(s) with `bd create`, parenting tickets under the relevant epic, and add `bd dep add <issue> <depends-on>` for any ordering between them. Report the new ids.

## When a skill says "fetch the relevant ticket"

`bd show <id>` (plus `bd comments <id>` for discussion). The user will normally pass the id directly; otherwise `bd search <query>`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an epic with one **child** issue per ticket.

- **Map**: an epic whose description holds the Notes / Decisions-so-far / Fog body; update it with `bd update <epic-id> --description=...`.
- **Child ticket**: `bd create --parent=<epic-id>` with the question in the description. The ticket type (`research`/`prototype`/`grilling`/`task`) is recorded as a label `wf:<type>`.
- **Blocking**: `bd dep add <ticket> <blocker>`. A ticket is unblocked when all its dependencies are closed.
- **Frontier**: `bd ready --parent=<epic-id>`: open, unblocked, unclaimed; lowest id wins.
- **Claim**: `bd update <id> --claim` before any work.
- **Resolve**: `bd comments add <id> "## Answer ..."`, then `bd close <id>`, then append a context pointer (gist + id) to the map epic's Decisions-so-far.
