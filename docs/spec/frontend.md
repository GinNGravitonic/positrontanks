# Frontend client

The frontend is a web client for the Positron Tanks API: a lobby for finding, creating and entering Games, read-only browsers for a Player's Garage, Maps and the Parts Catalog, and a viewer for watching Games live and rewatching Replays. It is out of v1's scope ([v1.md section 1](v1.md#1-scope)) and builds on the v1 API unchanged except where this document says otherwise. Vocabulary follows [GLOSSARY.md](../../GLOSSARY.md). The platform and hosting decision is [ADR-0006](../adr/0006-web-client-served-by-the-server.md).

Authoring stays with the CLI and the plugin's skills for now: the first version has no Bot Design, Map or Program editors.

## 1. Platform and stack

- A browser single-page app in TypeScript, in a new workspace package `packages/web`, built with React and Vite.
- Both views of the viewer draw on an HTML Canvas 2D. Artwork SVGs, once they exist, are drawn onto the canvas.
- The client may import the pure workspace packages (`ruleset-data`, `engine-r1`, `language`) for types and data handling; none of them use Node APIs.
- Desktop browsers first. Lobby, Garage, Maps and Parts Catalog screens stay usable on a phone; the viewer has no phone layout, but works on a tablet.

## 2. Hosting

- The server serves the built client as static files, from the same origin and the same Docker image as the API. No CORS, nothing new to deploy, and nothing changes in the AWS stack.
- The client lives under `/play/`. The server answers any `/play/*` path that is not a built file with the client's `index.html`, so client routes can be bookmarked and reloaded. Every existing API path is unchanged.

## 3. Rulesets

- The client can display every Game of every Ruleset the server hosts, so a Player can watch any Game they could also create or play.
- Replays are drawn through a viewer for each engine (r1 today; r2 beside it when it comes). A Game's Parts Catalog comes from `GET /rulesets/{version}/parts`.
- A test fails the build if any Ruleset the server hosts has no viewer for its engine: a new Ruleset cannot ship until it can be watched.
- When a Ruleset stops being hosted, its viewer may be removed with it; its Finished Games then show "Ruleset X is no longer supported" instead of a Replay. What the API does with those Replays is decided when a Ruleset is first dropped.

## 4. Signing in

- The client signs up (`POST /players`), logs in (`POST /sessions`) and logs out (`DELETE /sessions/current`).
- The session token is kept in `localStorage`. Sessions last 24 hours and are not refreshed: on any 401 the client returns to log-in, then back to the page the Player was on.
- Spectating stays signed-in only, as in v1: signed-out visitors see only sign-up and log-in. Opening snapshot, stream and Replay to signed-out visitors is a separate, later decision.
- API key management stays with the CLI.

## 5. Screens

- **Games**: browse Open Games with the API's filters (Ruleset, Map, player count, Point Budget range); My Games, filtered by state.
- **Game page**, by state:
  - Open: its Entries' Players and Bot Names; enter, withdraw your Entry, or cancel (Initiator only).
  - Running: watch it live (real-time Pace) or wait for it (unthrottled Pace); see section 6.
  - Finished: the Replay.
  - Cancelled: why, and when.
- **Create Game**: Map picker with a preview, player count, Point Budget, time limit, Pace and fill timeout.
- **Enter Game**: pick Bot Designs from your Garage (latest Revision), name each Bot, with a running total against the Point Budget; validation problems from the API are shown against the fields they name.
- **Garage** (read-only): your Bot Designs, each Build drawn, costs, Revision notes, and your own Program shown read-only.
- **Maps** and **Parts Catalog**: browse with previews.

## 6. Watching Games

What a Spectator can watch depends on the Game's Pace:

- **Real time, Running**: watched live from `GET /games/{id}/stream`, read with a fetch-based SSE client that sends the `Authorization` header (native `EventSource` cannot). The stream starts with a snapshot, so a live view begins at the moment of joining and cannot rewind. A stream that closes without `end` is reopened for a fresh snapshot. When `end` arrives, Game Over is shown.
- **Unthrottled, Running**: not watched live. The page says the Game is being played and that its Replay comes when it is Finished, checks the Game every few seconds, and switches to the Replay by itself once it is.
- **Finished**: the Replay (`GET /games/{id}/replay`), from Tick 0, with a "Skip to result" button. Game Over is shown when playback reaches the end.

Replay time controls: play/pause, a scrubber over the whole Game, and speeds from 0.25x to 4x. Live Games have no time controls.

## 7. The viewer

The viewer has two views of the same Game.

### Overview

A small drawing of the whole Map: its boundary, Terrain and Obstacles, each live Bot as a dot in its Entry's color, wrecks as grey dots, and a rectangle showing the main view's area. No Projectiles. Clicking or dragging on the overview moves the main view there and stops following.

### Main view

An overhead camera the Spectator pans and zooms around the Map, showing each Bot in detail: its Chassis shape, its Components at their Slots (placeholder shapes sized by `visualSize` until artwork exists; an artwork reference is used when present), a tint or outline in its Entry's color, and its Bot Name as a label.

- **Zoom limits**, measured across the view's shorter side: maximum zoom about 4 m (one large Bot), default about 15 m (two Bots at close range), minimum zoom the whole Map plus a small margin. These are presentation values, kept in the client, not in the Ruleset.
- **Motion**: Bot and Projectile positions are interpolated between Ticks at the display's frame rate, and events (shots, beams, impacts, collisions, disablements, destroyed Obstacles) are drawn as short effects. This is visual only and never changes what the Replay says.

### Entry colors

Each Entry gets a color from a fixed palette, in Entry order, used for the overview's dots, the main view's tints and labels, the Bot inset and Game Over.

### Following a Bot

The Spectator can follow a Bot, so the main view tracks it without manual panning.

- While following, the camera keeps the followed Bot in view and also fits every Bot **engaged** with it: another Bot that a hit linked to the followed Bot in the last 3 simulated seconds, in either direction. A hit is a `damage` event or an `impact` that struck a Bot, whether from a weapon or a ram, and hits between Friends count. Misses never engage a Bot, since a `fired` event names no target.
- When no Bot is engaged any more, the zoom eases back to the default. The camera never zooms out beyond minimum zoom.
- Following stops when the followed Bot becomes Disabled; the camera stays where it is, on the wreck. It also stops as soon as the Spectator pans, by dragging the main view or using the overview. Zooming by hand keeps following on.

### Bot inset

Clicking a Bot in the main view selects it and opens an inset with:

- its Bot Name, Player and Emblem;
- its Chassis and its Components by Slot;
- its Hit Points as a current/max bar, its Armor on each side, and its speed;
- its status: live, or Disabled and why;
- the damage it has dealt to Foes and taken, up to the current Tick;
- a "Follow" button.

Selecting a Bot does not follow it. The inset never shows a Program or Program logs, not even for the viewer's own Bots; those stay with the CLI.

### Game Over

Shown over the final frame when a Game ends (live) or its Replay reaches the end:

- the Winner, or a Draw, and how the Game was decided: last standing, damage dealt to Foes, or remaining Hit Points;
- one row per Entry: Emblem, Player, damage dealt to Foes, remaining Hit Points, and whether any of its Bots is still standing;
- under each Entry, its Bots: Bot Name, damage dealt and taken, and, if Disabled, the Tick and cause;
- "Watch again" (the Replay, from Tick 0, once the Game is Finished) and "Back to Games".

Per-Bot figures come from the Replay's events; per-Player figures from the Game's result.

## 8. Emblems

Emblems do not exist yet: v1 only reserved them, and image uploads are out of v1. Until they exist the client draws a placeholder Emblem, the Player's initials on a disc in their Entry color, wherever an Emblem appears (Bot inset, Game Over). Real Emblems (an API field, uploads, storage) are a separate task.

## 9. Testing

- Vitest unit tests for the logic-heavy parts: camera fitting, engagement tracking, interpolation, and per-Bot figures from events.
- One Playwright smoke test against a local server: sign in, open a Finished Game's Replay, and reach Game Over.
- The Ruleset coverage test from section 3.

## 10. Not in the first version

Bot Design, Map and Program editors · real Emblems and other image uploads · real artwork · signed-out spectating · rewinding live Games · watching unthrottled Games live · Program logs in the client · API key management · a phone layout for the viewer.
