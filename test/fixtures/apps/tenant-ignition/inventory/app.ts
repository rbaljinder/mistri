import { defineApp } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Tables } from './schema.ts';
import { navigation } from './navigation.ts';
import { pages } from './pages.ts';
import { resources } from './resources.ts';
import { views } from './views.ts';

export default defineApp({
  id: 'tenant-ignition-inventory',
  name: 'Ignition · Tenant inventory',
  sources: { business: { connection: 'tenant-proof' } },
  resources,
  auth: {
    signUp: 'open',
    defaultRole: 'member',
    rows: 'tenant',
    // Root ceilings admit command effects; generic writes remain lead-only.
    roles: {
      member: { read: true, write: ['lead'], commands: ['recordFollowUp'] },
      manager: { read: true, write: ['lead'], commands: ['recordFollowUp', 'assignReviewer', 'reserveVehicle', 'releaseReservation'] },
      viewer: { read: true, write: false, commands: [] },
    },
  },
  views,
  pages,
  home: 'overview',
  nav: navigation,
  ui: { theme: { preset: 'lumen' }, shell: { placement: 'side' } },
} satisfies TypedAppConfig<Tables>);
