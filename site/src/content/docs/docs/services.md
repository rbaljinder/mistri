---
title: Connections and services
description: Name your databases in mistri.json, then add the optional cache, webhook and email services a deployment uses.
---

Name your databases in mistri.json, then add the optional cache, webhook and email services a deployment uses.

```json title="mistri.json"
{
  "connections": [
    { "name": "crm", "url": "${DATABASE_URL}", "writable": true, "pool": { "read": 8 } },
    { "name": "shared", "kind": "cache", "url": "valkeys://cache.internal:6379",
      "auth": { "password": "${VALKEY_PASSWORD}" } },
    { "name": "mail", "kind": "email", "url": "smtps://smtp.example.com:465",
      "from": "CRM <no-reply@example.com>",
      "auth": { "username": "${SMTP_USER}", "password": "${SMTP_PASSWORD}" } }
  ],
  "apps": [{ "dir": "./crm-app", "env": ["REGION"] }]
}
```

```sh
DATABASE_URL=postgres://crm_app@db.internal/crm npx @mistriwork/mistri --config mistri.json
```

<!-- no picture: configuration; the running App looks the same with or without a service. -->

## What you'll see

- Each database is opened when it is first used, not at start.
- An unset `${VAR}` is refused, naming the variable, so a missing secret never becomes an empty password.
- A start with no services runs the same; each adds a capability, never a source of truth.

## When to use it

- Use a config file as soon as there is a password, a second database or an App to serve: it keeps credentials out of the command line.
- Use `--db postgres://…` (or `DATABASE_URL`) instead for one database you are only looking at.
- Use a [suite file](/docs/suites/) instead when several Apps each need their own connections and secrets in one process.

## Connections

Without `--config`, mistri reads `mistri.json` in the working directory, then `~/.config/mistri/connections.json`. A database connection takes:

| Key | Does | Default |
| --- | --- | --- |
| `name`, `url` | What the browser and Apps call it; `postgres://` or `sqlite:<path>`, usually `${DATABASE_URL}` | required |
| `writable` | Allows writes, checked in every route and tool that writes. Connect as a database role that may write | `false` |
| `pool` | `{ "read": n, "write": m }`, 1 to 64, PostgreSQL ([pools](/docs/performance/#postgresql-pools)) | 4 and 4 |
| `replicas` | Read replicas' URLs, PostgreSQL, up to 8: lists, dashboards and exports read them ([replicas](/docs/performance/#read-replicas)) | none |
| `schemas` | PostgreSQL schemas to read | every user schema |
| `hidden` | Columns never served: `{ "staff": ["password_hash"], "*": ["*_token"] }` ([secrets](/docs/secrets/)) | none |
| `rows` | `false` serves the shape only, never a row | `true` |
| `migrations` | `{ "dir": "./migrations" }` for [`mistri migrate`](/docs/change-your-schema/) | none |

Beside `connections`, the file may list `apps` (a directory, or `{ "dir", "env" }` naming the environment variables that App may read), `mount`, `basePath` ([where an App is served](/docs/build-and-deploy/#where-an-app-is-served)) and `analytics` ([behavior analytics](/docs/analytics/)). The file is read once, at start; a change waits for a [restart](/docs/reload-and-restart/).

## The cache (`"kind": "cache"`)

A Valkey server (or Redis) every instance of a deployment shares. It holds cached answers for an HTTP connection with `"cache": { "ttl": 60 }`, and the rate-limit windows of public forms, sign-in lockouts and the sign-in routes' request budget, so instances behind a load balancer spend one budget. Records are never cached.

`url` is `valkeys://host:6379` (TLS) or `valkey://`; `rediss://` and `redis://` too, and `/2` picks a database. `auth` takes `password` and, for an ACL user, `username`. Plain `valkey://` needs `"insecure": true`. When the cache does not answer, reads miss and rate limits fall back to the process's own count, said on stderr at most once a minute.

## Search

A `contains` filter (the list's search box, a reference picker, the palette) runs on the database. Search engines are not services: providers are packs, Typesense the first (`@mistriwork/search-typesense`), shipping after 1.0. A `"kind": "search"` entry is refused, and so is a resource's `search` while no provider is plugged in.

## Webhooks (`"kind": "webhook"`)

Where a command's [effects](/docs/commands/#starting-values-other-sources-webhooks) go after it commits. `url` is https (plain http only to loopback); redirects and link-local addresses are refused. `auth` is `{ "bearer": "${TOKEN}" }` or `{ "header": "x-signature", "value": "${SECRET}" }`.

Each delivery is a JSON `POST` with an `Idempotency-Key` that is the same on every attempt; deduplicate by it. A 2xx is delivered; anything else is retried with backoff (1 s doubling to five minutes, eight attempts), then waits for an operator ([redrive](/docs/observe/#failed-jobs-and-deliveries)). Provision the delivery store once, with the server stopped: `provisionStores({ postgres: url }, { app: { id, commands } })` from `@mistriwork/mistri/maintenance`.

## Email (`"kind": "email"`)

The one service mail goes through: `smtps://` (or `smtp://` with STARTTLS), `from`, and `auth`; or `log:` to write each message to the log instead. What an App sends, and when: [email](/docs/email/). A tenant App's mail in and out adds `inbound`, `dkim`, `domains`, `links`, `spf` and `returnPath` ([tenant mail](/docs/tenant-mail/)).

## OAuth (`"kind": "oauth"`)

Lets a person signed in to an App give an agent a token of their own, through the browser, instead of asking the operator for one:

```json
{ "name": "agents", "kind": "oauth", "apps": ["lintel"], "roles": ["sales"] }
```

`apps` names the Apps it issues for; `roles` caps what a token may carry (absent: the App's `api.roles`); `redirectHosts` limits where a client may send people back. In a tenant App each token is one membership's, never a platform-realm role's. It needs `--api-reads`, a provisioned token store and an https address, and is not served in a suite. What a client sees: [the App API](/docs/app-api/#oauth-for-agents).

## Common mistakes

- `Connection references $SMTP_PASSWORD, which is not set` → export it, or set it in the container's environment; the file never holds the value.
- A credential written in the `url` → move it to `auth` as a `${VAR}`; `auth` values are never logged.
- Two instances each enforce their own rate limit → name a cache connection so they share one budget.

## Related

- [Build and deploy](/docs/build-and-deploy/): containers, load balancers and where an App is served.
- [Performance and pools](/docs/performance/): sizing `pool` against `max_connections`.
- [Secrets and hidden columns](/docs/secrets/): what `hidden` and `env` protect.
- [Identity providers](/docs/identity-providers/): the `"kind": "oidc"` and [`"kind": "saml"`](/docs/saml/) connections, and [`"kind": "scim"` provisioning](/docs/scim/).
- [App API](/docs/app-api/#oauth-for-agents): the `"kind": "oauth"` authorization server, as an agent meets it.
