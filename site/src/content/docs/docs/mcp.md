---
title: MCP for coding agents
description: Give a coding agent your database's schema, rows and relationships as MCP tools, read-only unless a connection says otherwise.
---

Give a coding agent your database's schema, rows and relationships as MCP
tools, read-only unless a connection says otherwise.

```json title=".mcp.json"
{
  "mcpServers": {
    "tablewalk": {
      "command": "npx",
      "args": ["tablewalk", "--mcp", "--config", "/absolute/path/tablewalk.json"]
    }
  }
}
```

The config file is the same one the browser reads
([connections](/docs/services/#connections)); `npx tablewalk --mcp <url or file>`
works for one database.

<!-- no picture: the agent's side is text; each answer carries a link a person opens in the browser. -->

## What you'll see

- The agent calls `schema_summary` first, then `table`, `query` and `record`
  as it needs them.
- Every answer carries a `link`: open it and you are on the same rows in the
  browser.
- 23 tools: 17 that only read, and 6 writes listed only when a connection is
  `"writable": true`.

## When to use it

- Use database MCP when an agent should read your schema and data: to write a
  migration, a query, a fixture or a first App.
- Use [App MCP](/docs/app-api/) instead when the agent should act through an
  App's grants and commands, as a signed-in role would.
- Use the [agent skill](/docs/build-with-an-agent/) beside either one when the
  agent is building an App: the skill says how; MCP shows what is there.

## The tools

| Task | Tools |
| --- | --- |
| Orient | `connections`, `schema_summary`, `tables`, `table` |
| Locate and inspect | `find`, `query`, `record`, `profile` |
| Summarize | `breakdown` |
| Diagnose | `sql`, `explain`, `lint`, `change_impact`, `diff` |
| Prepare fixtures | `order`, `fixture` |
| Refresh | `refresh` |
| Write (writable only) | `insert`, `update`, `delete`, `insert_graph`, `delete_graph`, `revert` |

A destructive tool (`delete`, `delete_graph`) shows its impact first and, in a client that supports elicitation, asks the person every time; a `confirm: true` the model supplies does not stand in for the answer. The graph tools are not journaled: they return no `undoId`, and `revert` cannot undo them.

`query` and `breakdown` take the [query language](/docs/query/) verbatim.

## Options

| Flag | Does | Default |
| --- | --- | --- |
| `--tools <profile>` | Offers one job's worth: `explore`, `migrate` or `seed`. A profile never grants writes. | `full` |
| `--output-schema` | Advertises each tool's output shape in `tools/list`. | off |
| `--config <path>` | The connections, each read-only unless `"writable": true`. | `tablewalk.json` in the working directory, then `~/.config/tablewalk/connections.json` |

Every statement stops at 30 seconds (`sql` takes a lower `timeout_ms`) and
when the client cancels. Counts stop at 10,000 and say so. `sql` and
`explain` refuse the runtime's own tables (`__mistri_`) and, on PostgreSQL, the `mistri` schema.

## Common mistakes

- The agent sees no `insert` or `update` → the connection is read-only; add
  `"writable": true` to it, and connect as a database role that may write.
- `No config file at …` → a relative `--config` path resolved against the
  agent's working directory, not yours; give an absolute path.
- An App that signs people in, or names its sources, is refused → database
  MCP serves no App; use [App MCP](/docs/app-api/) (`--app-mcp`) under a token.

## Related

- [Query language](/docs/query/): what `query` and `breakdown` accept.
- [Build with a coding agent](/docs/build-with-an-agent/): the skill, the loop and the prompt.
- [App API](/docs/app-api/): an App's reads and commands as MCP tools, under a token.
- [tablewalk, the database browser](/docs/database-browser/): where a tool's `link` lands.
