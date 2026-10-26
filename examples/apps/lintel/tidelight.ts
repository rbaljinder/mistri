import { defineTheme } from '@mistriwork/mistri/app';

/* A brand of its own in one block. Mono's quiet structure, warmed by daylight: one deep tide-teal (#0f5e5a) for every
   action, focus ring and chosen card, set against sun-warmed neutrals — a faint warm white page, pale sand where
   something is raised, a green-black ink rather than pure black, hairlines in warm gray. Type and spacing stay Mono's;
   only the corners soften, since square black boxes read as a terminal. Every color it does not name (the field's
   edge, the soft tint, the chart's lead) is derived from these and checked like them. */
export const tidelight = defineTheme({
  id: 'tidelight',
  label: 'Tidelight',
  extends: 'mono',
  colors: {
    light: {
      ground: '#fbfaf6',
      surface: '#ffffff',
      raised: '#f2efe6',
      ink: '#10211f',
      inkMuted: '#3f4f4c',
      inkSubtle: '#5a6966',
      line: '#e3dfd3',
      lineStrong: '#10211f',
      lineControl: '#5a6966',
      accent: '#0f5e5a',
      link: '#0f5e5a',
      // White on the teal measures 7.6:1.
      primary: '#0f5e5a',
      onPrimary: '#ffffff',
      // The teal leads the charts; the rest are Mono's grays in the order the check proposes, so neighbors stay apart.
      chart: ['#0f5e5a', '#333333', '#6b6b6b', '#8e8e8e', '#505050', '#a8a8a8', '#1c1c1c', '#c8c8c8'],
      nav: { ground: '#fbfaf6', ink: '#10211f', muted: '#3f4f4c', line: '#e3dfd3', accent: '#0f5e5a' },
    },
    dark: {
      ground: '#0b1514',
      surface: '#101c1b',
      raised: '#172624',
      ink: '#eef3f1',
      inkMuted: '#c3cfcc',
      inkSubtle: '#9fb0ac',
      line: '#2b3c39',
      lineStrong: '#eef3f1',
      lineControl: '#9fb0ac',
      accent: '#6cc7bb',
      link: '#8fd8ce',
      // The green-black on the lit teal measures about 9:1.
      primary: '#6cc7bb',
      onPrimary: '#06201d',
      nav: { ground: '#0b1514', ink: '#eef3f1', muted: '#c3cfcc', line: '#2b3c39', accent: '#6cc7bb' },
    },
  },
  shape: { radius: { control: '8px', field: '8px', panel: '12px' } },
});
