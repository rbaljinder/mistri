# mistri and tablewalk

**A few lines of TypeScript. A complete App.** — [mistriwork.dev](https://mistriwork.dev) ·
**Follow the data.** — [tablewalk.dev](https://tablewalk.dev)

This repository builds two products, each a package and a command of its own:

| | |
|---|---|
| **tablewalk** — the database browser | A foreign key is a place you can go: open a row and see every row that points at it, over SQLite, PostgreSQL or MySQL, read-only until you turn editing on, and the same over MCP for a coding agent. `npx tablewalk mydata.sqlite`. Its README: `packages/tablewalk/README.md`. |
| **mistri** — the App framework | Pages, commands, policies, jobs and workflows declared in TypeScript over a database you already have, and served from it. `npm create mistri`, `npx @mistriwork/mistri dev`. Its README: `packages/mistri/README.md`. |

```bash
npx tablewalk --demo          # a sample database, opened in the browser
npm create mistri             # a starter App
```

Each refuses the other's start and names the command that runs it. Both need
Node 24 or newer. The layers beneath them (`@mistriwork/engine`, `@mistriwork/ui`,
`@mistriwork/kit`) and how they depend on one another are in `docs/boundary.md`;
what runs where is `docs/architecture.md`.

## Development

```bash
npm install
npm test          # typecheck, lint, client checks, the unit suite, the component tests
npm run demo      # build a demo database and open it in the database browser
npm run build     # emit dist/, runnable by plain node
```

The demo database is generated from source in `test/make-demo-db.ts` rather
than committed as a binary, so you can read what you are browsing. Its shape
deliberately covers the things that are easy to get wrong: a self-referencing
key, a composite key, a view, and a nullable reference.

For something with weight to it, seed bulk data:

```bash
npx tsx test/make-demo-db.ts .demo/big.db --scale 2000   # ~87,000 rows, <1s
```

Seeding is deterministic — the same scale and seed always produce the same
database, so a screenshot or a reported bug can be reproduced exactly. The
small fixture is left untouched by default because the test suite asserts
exact counts against it.

The client renders through React and imports the same TypeScript the server
runs on for the rules both sides need. Vite bundles it into `dist/` at publish
time, in the same `npm run build` that compiles the server, and serves it from
source under `npm run dev` — so the promise is still `npx tablewalk mydb.sqlite`
and nothing else, and the build is the maintainer's, never the user's.
Architecture, in one page (`docs/architecture.md`) says what runs where;
`CONTRIBUTING.md` says which constraints are load-bearing.

## License

MIT.
