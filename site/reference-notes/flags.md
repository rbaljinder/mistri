## Feature flags

> **Preview.** Flags, audiences, experiments, behavior analytics and `@mistriwork/mistri/openfeature` work as documented and may change in any 1.x release. See [status](/docs/status/).

Flags are decision data. Declare defaults in the App, then operate them from
the [suite provider and Console](/docs/suites/).

```ts
flags: {
  newReview: flag.boolean(false, { owner: 'lending' }),
  reviewLayout: flag.string('standard', { owner: 'lending', variants: ['standard', 'compact'], safeValue: 'standard' }),
},
auth: { roles: { flagOperator: { label: 'Flag operator', read: ['loan'],
  flags: [{ actions: ['view', 'manage', 'killswitch'], environments: ['production'], owners: ['lending'] }] } } },
```

`flag.boolean`, `flag.string`, `flag.number` and `flag.object` take a default
and options. `owner` is required, and `variants` must include the default.
Boolean kill switches use `false`; other types need a `safeValue` to be
killed. `tenantManaged: true` permits a tenant override, and an App-wide kill
still wins. A provider failure falls back to the declared default, so choose
it deliberately.

A role's `flags` lists capabilities, each with explicit `actions`,
`environments`, `owners` and optional `ids`. `view`, `manage` and
`killswitch` are independent, and `admin` adds no flag powers. A command's
`enabledBy: { flag: 'newReview', is: true }` gates new attempts; components
read flags with `useFlags`.

An audience says who, once, and flag rules and experiments name it:

```ts
audiences: {
  partners: { roles: ['broker'], attributes: { emailDomain: ['partner.example'] } },
  beta: { rollout: 10, deny: ['acct_42'] },
},
```

Every condition given must hold: `roles`, `tenants`, a proven email's
`attributes.emailDomain`, and `rollout`, a stable share salted by the
audience's name, so every flag and experiment naming it reaches the same
people. `allow` and `deny` list account ids and decide first. A Console rule
or an experiment's `eligibility.audiences` matches a member of any one named;
neither lists roles or tenants itself.
[Experiments](/docs/experiments/) and
[behavior analytics](/docs/analytics/) build on the same declarations.
