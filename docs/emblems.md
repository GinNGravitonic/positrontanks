# Taking down an Emblem

Players upload their own Emblems (`players emblem set`, [docs/spec/cli-api.md](spec/cli-api.md))
and nobody approves them first. To take one down, an operator deletes its
stored object; there is no operator endpoint yet.

## Find the object

A Player's Emblem is served at `GET /players/{playerId}/emblem/{hash}`, where
`hash` is the `emblem` field of any Player reference to them, such as
in a Game's Entries. It is stored under the object key

```text
emblems/{playerId}/{hash}.png
```

Only the Player's current Emblem is stored, so `emblems/{playerId}/` holds at
most one file.

## Delete it

With local storage (`POSITRONTANKS_STORAGE=local`, [docs/docker.md](docker.md)), the key
is a path under `POSITRONTANKS_STORAGE_DIRECTORY` (`/data/objects` in the
image):

```bash
docker exec <container> rm /data/objects/emblems/<playerId>/<hash>.png
```

On AWS ([docs/deployment.md](deployment.md)), the key is in the objects bucket
(the `objectsBucket` stack output), behind `POSITRONTANKS_S3_KEY_PREFIX` if one
is set (the Pulumi deployment sets none):

```bash
aws s3 rm "s3://$(pulumi stack output objectsBucket)/emblems/<playerId>/<hash>.png"
```

No restart is needed. Fetching the Emblem then answers 404, and clients draw
the Player's placeholder (their initials on a disc) instead.

## Limits

- Viewers who already fetched the Emblem may keep showing it for up to 24
  hours: it is served with `Cache-Control: private, max-age=86400`, and the web
  client keeps it until the page is closed.
- The API still reports the hash in the Player's `emblem` field, since only the
  object is gone.
- The Player can upload an Emblem again, the same one included. Nothing
  stops that yet: the server has no operator access to block a Player.
