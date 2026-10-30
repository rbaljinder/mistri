---
title: Move from tablewalk 0.9
description: There is no in-place upgrade from a 0.9 App database; carry your tables across, start mistri's own stores fresh, and recreate what they held.
keywords: [upgrade, migrate, 0.9, tablewalk, export, import, stores, audit key, api tokens]
---

There is no in-place upgrade from a 0.9 App database; carry your tables across, start mistri's own stores fresh, and recreate what they held.

```sh
pg_dump -Fc -n public --exclude-table='__tablewalk_*' "$OLD_URL" -f tables.dump   # your tables only
pg_restore --no-owner -d "$NEW_URL" tables.dump
npx @mistriwork/mistri migrate stores up --app . --config mistri.json   # fresh stores at layout 1
```

mistri 1.0 reads no 0.9 store. Every store starts at layout 1, the PostgreSQL runtime is one schema named `mistri` (0.9 kept seven), and the names changed: the package is `@mistriwork/mistri`, the command `mistri`, the config `mistri.json`, the variables `MISTRI_*` and the working directory `.mistri/`.

## What carries over

Your own tables are your data and are not touched. Dump them with the engine's tool (on PostgreSQL, the `public` schema; on SQLite, `.backup`, then drop the `__tablewalk_*` tables from the copy), restore them where the new App will run, and point a connection at them. The App definition is code: rename the imports, then run `mistri check --app .`, which names every key 1.0 refuses and the key that replaces it.

## What is lost, and what to do

| Held by | Lost | Do |
| --- | --- | --- |
| The sign-in store | Accounts, sessions, the account trail | Invite people again (`signUp`), or `mistri tenant grant` the first operator of a tenant App; everyone signs in anew |
| API tokens | Every token | `mistri api-token provision`, then `issue` for each account (a token is bound to a sign-in account, so make the accounts first); clients take the new value |
| Command journal | Receipts and idempotency keys | A retry of a pre-cutover request is no longer recognized: finish in-flight writes before the cutover |
| Jobs, workflows, events, deliveries, outbox | Queued and failed work | Drain them on 0.9 first: redrive what failed, then let the queues empty |
| Record history, inbox, live sync | Past changes and notices | Export what you must keep as a report before the cutover |
| Support audit (tenant Apps) | The chain, and `TABLEWALK_AUDIT_KEY` | Verify it on 0.9 and archive the store and key; set `MISTRI_AUDIT_KEY` and provision a new store. The two chains are not linked |
| Kept hashes (`keep: 'hash'`) | Nothing, they are in your tables | A hash matches only under the key that made it: set `MISTRI_FORM_KEY`, and do not count on a 0.9 hash matching |

## Steps

1. On 0.9: stop writes, drain jobs and deliveries, verify the support audit if there is one, and take a full backup of every database.
2. Archive what you may need later: the sign-in store file, the support audit store and its key.
3. Create the new database (or a new schema set), restore your tables, and write the `mistri.json` with `MISTRI_*` variables.
4. `mistri migrate stores up --app . [--policy …]` makes the stores; a tenant App then runs `mistri tenant init` and `grant`.
5. `mistri check --app . --deploy`, start, and sign in. Keep the 0.9 databases until you are satisfied.

## Related

- [Build and deploy](/docs/build-and-deploy/#back-up-and-restore): backup, restore and the audit key.
- [Compatibility](/docs/compatibility/): what 1.0 promises from here on.
- [Status](/docs/status/): what this release is.
