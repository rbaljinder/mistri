import { defineTheme } from '@mistriwork/mistri/app';

/** Forecourt's look: the plain structure, neutral greys and near-black ink, with
    a deep racing green for the accent and the links, and chart series led by
    it and spaced for colour-blind readers (green, brass, grey, olive, blue). Registered in app.ts and
    made the App's default; `docs/theming.md` is the contract, and startup
    names any pair that falls below AA. */
export const showroom = defineTheme({
  id: 'showroom',
  label: 'Showroom',
  colors: {
    light: {
      ground: '#ffffff',
      surface: '#ffffff',
      raised: '#fafafa',
      ink: '#0a0a0a',
      inkMuted: '#404040',
      inkSubtle: '#525252',
      line: '#d9d9d9',
      lineStrong: '#737373',
      lineControl: '#8e8e8e',
      accent: '#1f5e3b',
      accentSoft: '#e6f0e9',
      link: '#1f5e3b',
      status: { good: '#15803d', warning: '#b45309', critical: '#c81e1e', info: '#0369a1' },
      nav: { muted: '#525252', line: '#e5e5e5', accent: '#1f5e3b' },
      chart: ['#1f5e3b', '#a8761a', '#737373', '#6f8f2e', '#2c6e9a', '#b0502e', '#7c63a8', '#3d8b5a'],
    },
    dark: {
      ground: '#0a0a0a',
      surface: '#0a0a0a',
      raised: '#171717',
      ink: '#fafafa',
      inkMuted: '#c7c7c7',
      inkSubtle: '#a8a8a8',
      line: '#303030',
      lineStrong: '#737373',
      lineControl: '#666666',
      accent: '#86d0a0',
      accentSoft: '#17301f',
      link: '#86d0a0',
      status: { good: '#4ade80', warning: '#fbbf24', critical: '#f87171', info: '#7dd3fc' },
      nav: { muted: '#a3a3a3', line: '#262626', accent: '#86d0a0' },
      chart: ['#86d0a0', '#e0b35a', '#a3a3a3', '#b5cf6b', '#7fb8e0', '#e0906e', '#b7a2de', '#5fb87f'],
    },
  },
});

/** Marketplace: the same App dressed as a consumer car-finance listing site
    rather than a dealer's back office — Sage's soft cards and shadows, a
    confident blue that reads as "apply" rather than "inventory", rounder
    controls, and a heading face with more presence over the price. Registered
    beside Showroom and never the default: it is a second look the reader can
    pick, and the point of having two is that an App's structure carries a
    different trade's feel without being rebuilt. Its own values throughout —
    a marketplace's conventions are worth learning from, a brand's colours are
    not ours to wear. */
export const marketplace = defineTheme({
  id: 'marketplace',
  label: 'Marketplace',
  extends: 'sage',
  colors: {
    light: {
      surface: '#ffffff',
      ink: '#0b1220',
      accent: '#14509b',
      accentSoft: '#e6eef8',
      link: '#14509b',
      nav: {
        accent: '#14509b',
      },
      chart: ['#14509b', '#c08a1e', '#4a6480', '#b05a3c', '#6b5bbd', '#2c7a6b', '#3d7fc4', '#737373'],
    },
    dark: {
      /* One dark family: the ground, hairlines and captions follow the navy
         surface. Inheriting Sage's own dark (a green-grey charcoal) drew the bar
         and the cards navy on a page that was not. */
      ground: '#070b14',
      surface: '#0b1220',
      raised: '#131c2e',
      ink: '#f5f7fa',
      inkMuted: '#c6cedb',
      inkSubtle: '#a3aec0',
      line: '#233049',
      lineStrong: '#5d6d88',
      lineControl: '#6e7e99',
      accent: '#8fbdf0',
      accentSoft: '#152741',
      link: '#8fbdf0',
      nav: {
        ground: '#0b1220',
        ink: '#f5f7fa',
        muted: '#a3aec0',
        line: '#233049',
        accent: '#8fbdf0',
      },
      chart: ['#8fbdf0', '#e2b95f', '#9db4cc', '#e09173', '#a396e0', '#63bfae', '#5f9ad6', '#a3a3a3'],
    },
  },
  shape: { radius: { control: '8px', field: '6px' } },
});
