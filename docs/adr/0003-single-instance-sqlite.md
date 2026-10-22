# Single server instance, SQLite with Litestream, object storage for blobs

The server runs as exactly one instance. Structured data (Players, Bot Designs, Revisions, Maps, Games, Entries) lives in an embedded SQLite file, continuously replicated to S3 by Litestream and restored on startup; locally it is just a file. Images, Game Records, and recorded timelines go in object storage (a local directory, or S3). All database access goes through a single module so a later move to Postgres stays contained.

We chose this because it is the simplest option that is still crash-safe: plain files cannot update several records atomically, and Postgres (RDS locally emulated by PGlite) adds a managed service we don't need at this scale. Document stores and DynamoDB were rejected for lack of a good embedded local mode and, for DynamoDB, AWS lock-in.

## Consequences

- **Never run two instances against the same database.** Deployments must stop the old task before starting the new one (brief downtime); horizontal scaling requires migrating off SQLite first.
- In-progress Games are interrupted by deploys and crashes; they are resumed on startup by replaying their Game Record to the last persisted Tick (possible because of ADR-0001).
