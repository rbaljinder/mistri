import { defineApp } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Tables } from './schema.ts';
import { navigation } from './navigation.ts';
import { pages } from './pages.ts';
import { resources } from './resources.ts';
import { views } from './views.ts';

export default defineApp({
  id: 'tenant-ignition',
  name: 'Ignition · Tenant proof',
  sources: { business: { connection: 'tenant-proof' } },
  resources,
  auth: {
    signUp: 'open',
    defaultRole: 'member',
    rows: 'tenant',
    // Command footprints include parent resources; field rules are unsupported.
    roles: {
      member: { read: true, write: ['lead'], commands: ['recordFollowUp'] },
      manager: { read: true, write: ['lead'], commands: ['recordFollowUp'] },
      viewer: { read: true, write: false, commands: [] },
    },
  },
  views,
  pages,
  home: 'overview',
  nav: navigation,
  ui: { theme: { preset: 'lumen' }, shell: { placement: 'side' } },
} satisfies TypedAppConfig<Tables>);
