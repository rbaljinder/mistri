```ts
auth: {
  providers: ['email'],
  defaultRole: 'viewer',
  roles: {
    viewer: { label: 'Viewer', read: true },
    manager: { label: 'Manager', read: true, write: ['opportunity'], commands: ['assignReviewer'], operations: ['readiness'] },
  },
},
```

Present, every request needs a session. A role takes a `label` for people,
`read` (`true` or a list), `write` (within its reads), `commands` (command
ids), `actions` (`{ pay_run: ['approve'] }`: fixed actions without write),
`operations`, `fields` and, from an identity provider, `from` (the claims that
grant it). Omitted grants deny, and every grant is enforced by the server, not
the screen. An account holding `admin` manages accounts from the account menu.
See [Sign-in](/docs/sign-in/), [Roles and field access](/docs/roles/) and
[Row access](/docs/row-access/).

`store` is where accounts and sessions live: a SQLite file in the config
directory by default, or a dedicated PostgreSQL database by its `postgres://`
URL. The manifest is committed, so name the password, or the whole URL, by a
`${NAME}` reference (`store: '${MISTRI_AUTH_STORE}'`); an unset variable
refuses at startup. Run `migratePostgresAuthStore(url)` from
`@mistriwork/mistri/maintenance` once before the first start: startup checks the store's
schema and never creates it. The store is never a business database, and a
tenant App refuses one at startup ([Tenant Apps](/docs/tenant-apps/)).
