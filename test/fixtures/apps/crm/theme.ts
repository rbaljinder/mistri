import { defineTheme } from '@mistriwork/mistri/app';

/** A registered custom theme: ordinary data, imported by app.ts and offered
    to readers beside the built-in presets. It extends no built-in look, so it
    stands on the plain structure — ruled tables, pill tabs, a status as a dot
    and its word — and names its own colour, faces and radii; every colour it
    leaves out is derived from its paper and ink. `docs/theming.md` is the
    contract. */
export const meridian = defineTheme({
  id: 'meridian',
  label: 'Meridian',
  colors: {
    light: {
      ground: '#f6f5f1',
      surface: '#ffffff',
      raised: '#efede6',
      ink: '#1f2a24',
      inkMuted: '#4f5e56',
      inkSubtle: '#5f6e66',
      accent: '#1d6a5a',
      accentSoft: '#dff0ea',
      link: '#1d4ed8',
      line: '#d5d9d0',
      lineStrong: '#8f9a90',
      // A field's edge in the paper's own green-grey, at 3.3:1 on the paper (WCAG 1.4.11).
      lineControl: '#7e8980',
      status: { good: '#117a38', warning: '#a84d07', critical: '#c81e1e', info: '#0369a1' },
      nav: {
        ground: '#ffffff',
        ink: '#1f2a24',
        muted: '#4f5e56',
        line: '#e5e5e5',
        accent: '#1d6a5a',
      },
      chart: ['#0284c7', '#b8621b', '#3d5fa8', '#9c2f6b', '#e07b39', '#7c3aed', '#0f766e', '#8a8a8a'],
    },
    dark: {
      ground: '#141a17',
      surface: '#1b2420',
      raised: '#25302b',
      ink: '#eef2ee',
      inkMuted: '#b5c2ba',
      inkSubtle: '#a3b1a9',
      accent: '#7fd1b9',
      accentSoft: '#213d35',
      link: '#93c5fd',
      line: '#3a4741',
      lineStrong: '#6f8078',
      // A grey edge is 2.8:1 on this greener panel; the strong border already clears 3:1.
      lineControl: '#6f8078',
      nav: {
        ground: '#141a17',
        ink: '#eef2ee',
        muted: '#b5c2ba',
        line: '#262626',
        accent: '#7fd1b9',
      },
      chart: ['#22d3ee', '#e8a468', '#9fb6ee', '#e07ab0', '#f43f5e', '#4ade80', '#93c5fd', '#a3a3a3'],
    },
  },
  type: { font: { heading: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' } },
  shape: { radius: { control: '6px', field: '6px' } },
});
