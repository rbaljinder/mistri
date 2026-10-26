import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppLanding } from '../../packages/mistri/src/client/components/AppLanding.js';
import type { DashboardDef } from '../../packages/kit/src/client/components/dashboardModel.js';
import { fixture } from '../mocks/core.js';

/* A neutral operations app keeps this public dashboard affordance separate
 * from Payday's authored home. It uses the real landing heading path. */
const dashboard = {
  id: 'operations',
  label: 'Operations',
  description: 'See what needs attention before the day gets away from you.',
  sections: [{ kind: 'note' as const, text: 'Keep this week’s commitments moving.' }],
} satisfies DashboardDef;
const app = {
  name: 'Studio',
  ui: {},
  resources: {},
  views: { operations: dashboard },
  nav: [],
};

const meta = {
  title: 'Dashboards/Description',
  component: AppLanding,
  args: {
    app,
    firstDash: dashboard,
    loadError: '',
    pages: [],
    dashboardEntry: (view: DashboardDef) => ({ kind: 'page', pageId: view.id }),
  },
  beforeEach: () => {
    fixture({ tables: [] });
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AppLanding>;
export default meta;

/* Optional prose remains part of the standard dashboard heading, not a bespoke screen. */
export const WithDescription: StoryObj<typeof meta> = {};
export const WithoutDescription: StoryObj<typeof meta> = {
  args: { firstDash: { ...dashboard, description: undefined } },
};
