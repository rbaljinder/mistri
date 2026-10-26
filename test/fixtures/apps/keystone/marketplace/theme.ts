import { defineTheme } from '@mistriwork/mistri/app';

/** Keystone: the plain structure — ruled tables, pill tabs — under a deep
    navy bar (`bar: 'dark'`, its current room a wash of the bar's amber), stat
    cards ruled in the first series, with one warm accent for the thing to do next (Check your
    rate, Contact the dealer). Navy is the lender speaking; the amber is the
    buyer's move. Registered in app.ts and made the App's default; startup
    names any pair that falls below AA (docs/theming.md). */
export const keystone = defineTheme({
  id: 'keystone',
  label: 'Keystone',
  colors: {
    light: {
      ground: '#f6f7fb',
      surface: '#ffffff',
      raised: '#eef1f7',
      ink: '#0d1b2e',
      inkMuted: '#44516a',
      inkSubtle: '#5d6a82',
      line: '#dde3ee',
      lineStrong: '#8a97ad',
      lineControl: '#7d8aa1',
      // The warm accent: a burnt amber that holds white text at AA.
      accent: '#b4461b',
      link: '#1c3f78',
      status: { good: '#127a55', warning: '#8a5a00', critical: '#c0284f', info: '#1e63c7' },
      nav: {
        ground: '#0f2140',
        ink: '#f4f6fb',
        muted: '#b7c2d8',
        line: '#233a63',
        accent: '#f2a766',
      },
      chart: ['#1c3f78', '#b4461b', '#3f7fb8', '#2c7a6b', '#a8680f', '#7a5bb0', '#9aa4b5', '#5d6a82'],
    },
    dark: {
      ground: '#070d18',
      surface: '#0d1628',
      raised: '#142038',
      ink: '#f2f5fa',
      inkMuted: '#c3cbdb',
      inkSubtle: '#a2adc2',
      line: '#22304c',
      lineStrong: '#5b6b8a',
      lineControl: '#6d7c99',
      accent: '#f4a46b',
      link: '#9dbcf0',
      status: { good: '#5fe0ad', warning: '#f7c665', critical: '#ff8fae', info: '#8fb8ff' },
      nav: {
        ground: '#0a1222',
        ink: '#f2f5fa',
        muted: '#a2adc2',
        line: '#22304c',
        accent: '#f4a46b',
      },
      chart: ['#9dbcf0', '#f4a46b', '#6fa6db', '#63bfae', '#e8c07a', '#b9a2e8', '#6d7c99', '#a2adc2'],
    },
  },
  shape: { radius: { control: '6px', field: '6px' } },
  type: { font: { heading: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' } },
  recipes: { nav: 'wash', bar: 'dark', stat: 'topline', table: 'tinted' },
});
