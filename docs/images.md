# Taking down an Emblem or Icon

Players upload their own Emblems (`players emblem set`) and Bot Design Icons
(`designs icon set`, both in [docs/spec/cli-api.md](spec/cli-api.md)), and
nobody approves them first. To take one down, an operator deletes its stored
object; there is no operator endpoint yet.

## Find the object

A Player's Emblem is served at `GET /players/{playerId}/emblem/{hash}`, where
`hash` is the `emblem` field of any Player reference to them, such as
in a Game's Entries. It is stored under the object key

```text
emblems/{playerId}/{hash}.png
```

Only the Player's current Emblem is stored, so `emblems/{playerId}/` holds at
most one file.

A Bot Design's Icon is served at `GET /icons/{hash}`, where `hash` is the
`icon` field of the design, or of a Bot built from it in a Game's Entries. The
same hash is in the `icon` column of the `bot_designs` table, so any SQLite
client on the database (`POSITRONTANKS_DATABASE_PATH`, or a copy of it) finds
the designs that use it:

```bash
sqlite3 <database> "SELECT id, player_id, name FROM bot_designs WHERE icon = '<hash>'"
```

It is stored under the object key

```text
icons/{hash}.png
```

Icons are stored once per image, not per design: every design whose Icon is
the same image shares that one object.

## Delete it

With local storage (`POSITRONTANKS_STORAGE=local`, [docs/docker.md](docker.md)), the key
is a path under `POSITRONTANKS_STORAGE_DIRECTORY` (`/data/objects` in the
image):

```bash
docker exec <container> rm /data/objects/emblems/<playerId>/<hash>.png
docker exec <container> rm /data/objects/icons/<hash>.png
```

On AWS ([docs/deployment.md](deployment.md)), the key is in the objects bucket
(the `objectsBucket` stack output), behind `POSITRONTANKS_S3_KEY_PREFIX` if one
is set (the Pulumi deployment sets none):

```bash
aws s3 rm "s3://$(pulumi stack output objectsBucket)/emblems/<playerId>/<hash>.png"
aws s3 rm "s3://$(pulumi stack output objectsBucket)/icons/<hash>.png"
```

No restart is needed. Fetching the image then answers 404. Clients draw the
Player's placeholder (their initials on a disc) in place of an Emblem, and
nothing in place of an Icon. Taking down an Icon takes it down for every
design that uses that image.

## Limits

- Viewers who already fetched the image may keep showing it for up to 24
  hours: it is served with `Cache-Control: private, max-age=86400`, and the web
  client keeps it until the page is closed.
- The API still reports the hash in the Player's `emblem` field or the
  design's `icon` field, since only the object is gone.
- The Player can upload the image again, the same one included, and an Icon
  re-uploaded to any design brings the image back for every design that still
  has its hash. Nothing stops that yet: the server has no operator access to
  block a Player.
