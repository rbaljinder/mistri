---
title: Build an API
description: 'Start an App that is only an API: expose reads and writes, issue a scoped token, follow its events and export its contracts.'
---

Start an App that is only an API: expose reads and writes, issue a scoped token, follow its events and export its contracts.

```sh
npx @mistriwork/mistri new --api "Field Notes"
cd field-notes && npx @mistriwork/mistri check --app . --config mistri.json
```

That writes a `task` table in a SQLite file of its own, the App with one list, a `complete` command that emits `task.completed`, and a README with the token recipe, with an `.oxfmtrc.json` and `format` scripts (oxfmt) beside the `package.json`. The schema is `db/schema.sql`, and the database is `db/migrations/V1__task.sql` applied: `npm run schema:diff -- <name>` writes the next migration from it ([Change the schema from schema.sql](/docs/schema-sql/)).

Other programs then read and change its records with scoped tokens, under the same roles as its screens.

## Expose

```ts
api: {
  version: 1, roles: ['client'],
  resources: { task: expose(['id', 'title', 'done'], { sorts: ['id'], create: true, update: true }) },
  commands: ['complete'],
  events: ['task.completed'],
},
```

`create`, `update` and `delete` are generic writes, off by default. Each runs as a command (`create-task`, `update-task`, `delete-task`) through the command journal, so it gets a receipt, a replay and the usual refusals. A token's roles get their own screen's rules: field ceilings, validation, transitions and stamps. Deleting needs every field writable, as on screen. An App with no commands of its own needs no commands module for them.

## Tokens

```sh
npx @mistriwork/mistri api-token issue --app . --config mistri.json --store-id <uuid> --commands commands.ts \
  --subject <account-id> --actor <account-id> --role client --label "Shop" --expires-at 2030-01-01T00:00:00Z \
  --operation list:task --operation command:create-task --operation event:task.completed
```

The operations are `list:`, `item:` and `view:` for reads, `command:` for commands and generic writes, and `event:` for the feed. [App API](/docs/app-api/) has the rest.

## Call it

```sh
B=http://127.0.0.1:4111/api/apps/field-notes/v1
curl -s $B/task -H "Authorization: Bearer $TOKEN"
curl -s -X POST $B/task/commands/create-task/v1 -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: create-task-000001" -H "Content-Type: application/json" -d '{"title":"Call the bank"}'
curl -s "$B/\$events?limit=50" -H "Authorization: Bearer $TOKEN"
```

To update or complete a record, first `GET …/prepare` for its `ETag`, then send it back as `If-Match`.

## The event feed

`GET …/$events` returns `{ items, next }`, oldest first. Pass `next` back as `after`; at the end, `next` stays where the feed stands, so a poller keeps it. Each item is `{ id, name, occurredAt, resource, key, payload }`. It never says who acted.

A token sees an event only when it holds `event:<name>` and its roles can read the record the event is about. Only Apps whose roles read all rows have a feed. A tenant App sends its events through webhooks.

## Contracts

`GET …/$openapi` and `GET …/$asyncapi` return the documents this token may use. `--export openapi` and `--export asyncapi` print the whole contract without a server. Add `--jobs` to include the signed inbound endpoints in the AsyncAPI document. It also lists the webhooks your commands post to.

## Related

- [App API](/docs/app-api/): every route, header and status the API answers with.
- [Commands](/docs/commands/): what `create-task` and `complete` run as.
- [Events and jobs](/docs/events-and-jobs/): the events the feed carries and the webhooks that post them.
- [Change the schema from schema.sql](/docs/schema-sql/): the next migration after `task`.
