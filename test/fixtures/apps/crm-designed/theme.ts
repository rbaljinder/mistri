import { defineTheme } from '@mistriwork/mistri/app';

/** A registered custom theme: ordinary data, imported by app.ts and offered
    to readers beside the built-in presets. It extends no built-in look, so it
    stands on the plain structure — ruled tables, pill tabs, a status as a dot
    and its word — and names its own colour, faces and radii; every colour it
    leaves out is derived from its paper and ink. `docs/theming.md` is the
    contract. */
export const quarry = defineTheme({
  id: 'quarry',
  label: 'Quarry',
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
  // A status is a soft pill of its tone: the designed pages draw it through `Value`, with no badge of their own.
  recipes: { status: 'pill' },
});

const INTER = 'Inter, "Inter Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** Compass's own look for its designed pages: Lumen's structure in zinc
    neutrals — white cards on a near-white ground, one hairline, an 8px
    corner, no lift — and Inter everywhere, figures included, with tabular
    numerals so columns of money line up. The face is the one the platform
    already ships for Lumen; nothing new is fetched. */
export const slate = defineTheme({
  id: 'compass-slate',
  label: 'Compass',
  extends: 'lumen',
  colors: {
    light: {
      ground: '#fafafa',
      surface: '#ffffff',
      raised: '#f4f4f5',
      ink: '#09090b',
      inkMuted: '#52525b',
      inkSubtle: '#6f6f78',
      line: '#e4e4e7',
      lineStrong: '#d4d4d8',
      lineControl: '#8c8c96',
      accent: '#2563eb',
      accentSoft: '#eff4ff',
      accentInk: '#1d4ed8',
      primary: '#18181b',
      onPrimary: '#ffffff',
      status: { good: '#15803d', warning: '#b45309', critical: '#d3191d', info: '#2563eb' },
      chart: ['#2563eb', '#5397eb', '#0d9488', '#d08400', '#ec4899', '#a855f7', '#64748b', '#94a3b8'],
      nav: { ground: '#ffffff', ink: '#09090b', muted: '#52525b', line: '#e4e4e7', accent: '#2563eb' },
    },
    dark: {
      ground: '#09090b',
      surface: '#111113',
      raised: '#1c1c1f',
      ink: '#fafafa',
      inkMuted: '#a1a1aa',
      inkSubtle: '#8e8e97',
      line: '#27272a',
      lineStrong: '#3f3f46',
      lineControl: '#6b6b74',
      accent: '#3b82f6',
      accentSoft: '#172554',
      accentInk: '#93b4fd',
      primary: '#fafafa',
      onPrimary: '#09090b',
      nav: { ground: '#09090b', ink: '#fafafa', muted: '#a1a1aa', line: '#27272a', accent: '#3b82f6' },
    },
  },
  type: {
    font: { ui: INTER, data: INTER, heading: INTER, figures: INTER },
    base: '14px',
    roles: {
      title: { size: '24px', weight: 600, tracking: '-0.02em' },
      heading: { size: '20px', weight: 600, tracking: '-0.015em' },
      section: { size: '15px', weight: 600, tracking: '-0.01em' },
      data: { features: ['tnum'] },
    },
  },
  shape: { radius: { control: '8px', field: '8px', panel: '10px' }, elevation: 'hairline' },
  density: 'comfortable',
  recipes: { blocks: 'card', current: 'underline', header: 'plain', status: 'pill', table: 'hairline', chart: 'plain' },
});
