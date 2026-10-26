A feature keeps one capability (its resources' presentation, views, pages,
menu fragment and grants) in one module, merged into the App at load.

```ts title="app.ts"
import { defineApp, defineFeature, listView, navGroup } from '@mistriwork/mistri/app';

const inventory = defineFeature({
  id: 'inventory',
  resources: { vehicle: { display: { price: { format: 'money' } } } },
  auth: { roles: { clerk: { read: ['vehicle'] } } },
  views: { vehicles: listView('Vehicles', 'vehicle', { show: ['name', 'price'] }) },
  nav: ['vehicles'],
});

export default defineApp({
  name: 'Dealership',
  resources: { lead: { access: 'write' }, vehicle: {} },
  auth: { roles: { clerk: { label: 'Clerk', read: ['lead'], write: ['lead'] } } },
  views: { leads: listView('Leads', 'lead') },
  features: [inventory],
  home: 'leads',
  nav: [navGroup('work', 'Work', ['leads', { feature: 'inventory' }])],
});
```

The App keeps `name`, `connection`, `sources`, `ui`, sign-in and which roles
exist. Ids are global; identical facts merge and conflicting ones are refused
naming both contributors; actions and validation rules concatenate; authority
only adds. Put each feature in `features/<id>.ts`, which reload watches.

## The authority lock

```sh
npx @mistriwork/mistri check --config mistri.json --app . --write-authority
```

writes `authority.lock` beside the App: every grant, ceiling, deletion
opt-in, public read, source binding and component origin, one line each,
naming who contributes it (`role clerk read vehicle — features "inventory"`).
From then on `check` fails with the difference whenever the App's authority
changes, the server refuses to start an App that differs from its lock, and a
reload that changes authority waits for a restart. Review the diff, then
rewrite the lock.
