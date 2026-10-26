import { defineApp } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Tables } from '../schema.ts';
import { navigation } from '../navigation.ts';
import { views } from '../views.ts';
import { pages } from './pages.ts';
import { resources } from './resources.ts';

export default defineApp({
  id: 'tenant-thread-notes',
  name: 'Thread · Tenant notes',
  sources: { business: { connection: 'tenant-proof' } },
  resources,
  auth: {
    signUp: 'open',
    defaultRole: 'member',
    rows: 'tenant',
    // Two people in one tenant who both change a discussion and write on it. A discussion keeps its revision in
    // `version`, which only commands move, so it is changed by `renameDiscussion` rather than edited in place
    // (tenant Apps have no field rules to keep `version` out of an edit).
    roles: {
      member: { read: true, write: ['issue'], commands: ['addDiscussion', 'addNote', 'renameDiscussion'] },
      manager: { read: true, write: ['issue'], commands: ['addDiscussion', 'addNote', 'renameDiscussion'] },
      viewer: { read: true, write: false, commands: [] },
    },
  },
  live: true,
  views,
  pages,
  home: 'overview',
  nav: navigation,
  ui: { theme: { preset: 'lumen' }, shell: { placement: 'side' } },
} satisfies TypedAppConfig<Tables>);
