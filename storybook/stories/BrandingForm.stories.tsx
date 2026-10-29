import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { BrandingForm } from '../../packages/mistri/src/client/components/BrandingForm.js';
import { themePreset } from '../../packages/engine/src/shared/themePresets.js';
import { applicationFixture } from '../mocks/core.js';

/* A tenant's own Branding form beside the live preview of what their people will see: the bar, a record's head, a
   figure and an email. The preview is drawn in the tenant's theme (the App's themes, here Lumen, Mono and Sage), not in
   the look the toolbar picks, so a reader sees the brand they are building in either mode. */
const themes = ['workshop', 'lumen', 'mono', 'sage', 'ledger'].map((id) => themePreset(id)!);
const ALL = ['logo', 'name', 'accent', 'palette', 'radius', 'density', 'theme'];

const reply = (editor: boolean, branding: Record<string, unknown> = {}, allow = ALL) => ({
  branding,
  revision: branding.name ? 3 : 0,
  editor,
  allow,
  themes,
});

const served = (answer: ReturnType<typeof reply>) => async () => {
  await applicationFixture({
    tables: [],
    app: { id: 'desk', name: 'Service desk', ui: {}, nav: [], views: {}, resources: {} },
    answer: { '/api/branding': () => answer },
  });
};

const meta = {
  title: 'Dashboards/Branding form',
  component: BrandingForm,
  parameters: { layout: 'padded' },
  beforeEach: served(reply(true)),
} satisfies Meta<typeof BrandingForm>;
export default meta;

/* An editor with every key allowed, before anything is changed. */
export const Editor: StoryObj<typeof meta> = {};

/* A saved brand: its name and accent are in the preview from the first paint. */
export const SavedBrand: StoryObj<typeof meta> = {
  beforeEach: served(
    reply(true, {
      name: 'North Coast Outfitters',
      accent: { light: '#9a3412', dark: '#fb923c' },
      theme: 'mono',
      radius: '6px',
      density: 'compact',
    }),
  ),
};

/* The App allows only a name and an accent. */
export const FewKeys: StoryObj<typeof meta> = { beforeEach: served(reply(true, {}, ['name', 'accent'])) };

/* A member who is not one of the App's editors reads the same form, and cannot change it. */
export const ReadOnly: StoryObj<typeof meta> = {
  beforeEach: served(reply(false, { name: 'North Coast Outfitters', accent: { light: '#0e7490', dark: '#7cc7d9' } })),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('textbox', { name: /Name/ })).toBeDisabled();
  },
};
