import { defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { navigation } from './navigation.ts';
import { cyclePage } from './pages/cycle.ts';
import { issuePage } from './pages/issue.ts';
import { projectPage } from './pages/project.ts';
import { resources } from './resources.ts';
import { views } from './views.ts';

export default defineApp({
  id: 'thread',
  name: 'Thread',
  resources,
  views,
  pages: { cycle: cyclePage, issue: issuePage, project: projectPage },
  home: 'workspace',
  nav: navigation,
  // The side menu folds to a rail of the views' icons (« or ⌘B), not away.
  ui: { logo: 'kanban', theme: { preset: 'lumen' }, shell: { placement: 'side', rail: true } },
} satisfies App);
