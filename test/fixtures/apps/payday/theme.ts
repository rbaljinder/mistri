import { defineTheme } from '@mistriwork/mistri/app';

/** Payday keeps Gusto's warmth and clarity as a Tablewalk look: coral for
 * attention, teal for action, paper surfaces, and a human heading face. */
export const payday = defineTheme({
  id: 'payday',
  label: 'Payday',
  extends: 'sage',
  colors: {
    light: {
      ground: '#f8f7f4',
      surface: '#ffffff',
      ink: '#29251f',
      accent: '#08766f',
      accentSoft: '#e3f4f1',
      link: '#08766f',
      nav: {
        ground: '#fffdf9',
        accent: '#08766f',
      },
      chart: ['#e56b5d', '#3aa39c', '#c35c4d', '#7c63a8', '#4c9b91', '#a8781f', '#08766f', '#a39e92'],
    },
    dark: {
      surface: '#211f1c',
      lineControl: '#807b73',
      ink: '#fffaf2',
      accent: '#73d1c4',
      accentSoft: '#183b38',
      link: '#73d1c4',
      nav: {
        accent: '#73d1c4',
      },
      chart: ['#f28b7d', '#6fd1c8', '#e58a7d', '#b7a2de', '#8bd9d0', '#e4bf67', '#73d1c4', '#8c887f'],
    },
  },
  shape: { radius: { control: '8px', field: '6px' } },
});
