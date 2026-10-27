# Specifications

- [v1.md](v1.md): the v1 specification.

The per-Ruleset prose documents are published with each Ruleset version and live with its data in `packages/ruleset-data/spec/<version>/`, their single source. The server serves them as Markdown at `GET /rulesets/{version}/docs/{engine|language|catalog}`. For r1:

- [engine-r1.md](../../packages/ruleset-data/spec/r1/engine-r1.md): simulation rules.
- [language-r1.md](../../packages/ruleset-data/spec/r1/language-r1.md): language specification.
- [catalog-r1.md](../../packages/ruleset-data/spec/r1/catalog-r1.md): Parts Catalog and balance.

Links between those documents are relative to their served paths (`catalog#7-language-limits` from `/rulesets/r1/docs/language`), so they work when served, under any version or path prefix, rather than when browsed in the repo.
