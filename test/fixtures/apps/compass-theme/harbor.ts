import { defineTheme } from '@mistriwork/mistri/app';

/** An ordinary imported module, registered by the app without framework edits. */
export const harbor = defineTheme({
  id: 'harbor',
  label: 'Harbor',
  colors: {
    light: {
      ground: '#f3f7f7',
      surface: '#ffffff',
      raised: '#eef3f3',
      ink: '#202c30',
      inkMuted: '#475e65',
      inkSubtle: '#536b73',
      accent: '#006976',
      accentSoft: '#e0f2f3',
      line: '#ccdadd',
      lineStrong: '#849da4',
      link: '#1d4ed8',
      lineControl: '#8a8a8a',
      // A deeper red than the usual: 4.47:1 on this tinted page, and this reads on both grounds.
      status: { good: '#117a38', warning: '#a84d07', critical: '#c02d2d', info: '#0369a1' },
      nav: {
        ground: '#ffffff',
        ink: '#202c30',
        muted: '#475e65',
        line: '#e5e5e5',
        accent: '#006976',
      },
      chart: ['#0284c7', '#b64560', '#4164a5', '#907000', '#e07b39', '#7c3aed', '#0f766e', '#8a8a8a'],
    },
    dark: {
      ground: '#131b1e',
      surface: '#1a2529',
      raised: '#26363b',
      ink: '#ecf4f4',
      inkMuted: '#b9cbd0',
      inkSubtle: '#a4bdc5',
      accent: '#85d6dc',
      accentSoft: '#203e43',
      link: '#93c5fd',
      line: '#3e535b',
      lineStrong: '#758e98',
      // A control grey is 2.73:1 on this bluer panel; the startup check says so.
      lineControl: '#758e98',
      nav: {
        ground: '#131b1e',
        ink: '#ecf4f4',
        muted: '#b9cbd0',
        line: '#262626',
        accent: '#85d6dc',
      },
      chart: ['#22d3ee', '#efa2b5', '#a1bdf2', '#e3c569', '#f43f5e', '#4ade80', '#93c5fd', '#a3a3a3'],
    },
  },
  type: { font: { heading: 'Georgia, serif' } },
  shape: { radius: { control: '3px', field: '3px' } },
});
