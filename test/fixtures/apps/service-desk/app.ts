import { defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { navigation } from './navigation.ts';
import { pages } from './pages/index.ts';
import { resources } from './resources.ts';
import { views } from './views.ts';

export default defineApp({
  id: 'service-desk',
  name: 'Service Atlas',
  resources,
  views,
  pages,
  home: 'operations',
  nav: navigation,
  ui: {
    shell: { placement: 'top' },
    theme: {
      preset: 'lumen',
    },
  },
} satisfies App);
