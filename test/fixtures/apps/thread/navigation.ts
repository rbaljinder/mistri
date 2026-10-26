import { navGroup } from '@mistriwork/mistri/app';
import type { Navigation } from './mistri-schema.d.ts';

/* The menu: arrangement only. Every entry names a view in views.ts. */
export const navigation = [
  navGroup('plan', 'Plan', ['workspace', 'issues', 'inbox', 'triage', 'board', 'planning', 'projects', 'cycles']),
  navGroup('team', 'Team', ['updates', 'people']),
] satisfies Navigation;
