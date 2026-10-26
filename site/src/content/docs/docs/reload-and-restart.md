---
title: Reload and restart
description: What a save reloads while the server runs, what needs a restart, and what the App answers in between.
---

What a save reloads while the server runs, what needs a restart, and what the App answers in between.

```sh
npx @mistriwork/mistri --config mistri.json --app .   # watches the App directory
# edit views.ts → reloaded; edit a grant or mistri.json → restart
```

## A save reloads

- `app.ts` and every module it imports, `pages/`, `features/`, and the
  modules and stylesheets of its custom components; the whole module graph is
  read again.
- A save that does not load keeps the last good App serving; the log says why.
- A row-policy App (`auth.rows: 'policy'`) reloads too, but its data is
  refused until its policy has started again for the new App, so the old
  policy never serves it.

## The browser follows

A page open on the App redraws itself after each save, keeping its address,
its open record and its scroll. A save that does not load is shown over the
last good App, placed in its file:

```text
The last save did not load
resources.ts:3   invalid-app
Expected ',', got 'ident'
  2 |   labels: { status: 'Stage' }
> 3 |   access: 'write',
```

- The next good save clears it; Dismiss hides it until a save fails again.
  The terminal prints the same place under `App error:`.
- A record's unsent edits are not kept: its room is drawn again for the
  new App.
- Only a watched App is followed: not a `mistri build` output, a tenant
  platform, or a handler mounted in your server.
- Only the author's page follows. In an App with roles or hidden fields,
  readers get neither the stream nor the error; they see the new App on
  their next page.

## A restart is needed for

| Change | While it waits |
| --- | --- |
| What the App grants: resources' `access`, `fields`, `delete`, roles, public reads, command grants, `ui.csp` | Every App request answers 503 until a restart; neither the old nor the new authority is served. |
| Its sources, `connection` or sign-in: providers, sign-up, default role, the session store, the App's `id` | The same: bindings are authority. |
| mistri.json: connections, `writable`, `apps` and their `env` | Unseen until a restart: the file is read once, at start. |
| `--commands`, `--jobs`, `--policy` modules | Handlers keep the code they started with. A row-policy App whose policy or commands file changes refuses data, and says to restart, until you do. |
| A tenant App's files, but for its look | Data requests stop until a restart. A save that changes only its themes (`ui.theme`, `customThemes`, their faces) is worn in place, on the next page. |

With `--api-reads` the App API is restart-only: a save retires its reads
until the server restarts. An App with an authority.lock starts only when the
lock agrees with what it grants, so accept a reviewed change with
`mistri check --app <dir> --write-authority` before restarting.

## Common mistakes

- Every request answers 503 after a save → the save changed a grant, a source
  or sign-in; restart the server.
- A new connection or a changed command handler is not seen → mistri.json
  and `--commands`, `--jobs`, `--policy` modules load at start; restart.

## Related

- [Build and deploy](/docs/build-and-deploy/): a build is restarted, never reloaded.
- [Connections and services](/docs/services/): what mistri.json holds.
- [Observe and operate](/docs/observe/): `/readyz` while a row policy restarts.
