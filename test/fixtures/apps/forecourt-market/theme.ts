import { defineTheme } from '@mistriwork/mistri/app';

/** Forecourt's look: Lumen — Inter, white cards, its tones and recipes — under
    a deep ink-navy bar, with one warm amber for the thing a buyer does next
    (Send inquiry, Save), the price and what is chosen. Bold by contrast, not
    saturation: the navy is the room, the amber the move. On white the amber is
    a deep amber-brown, since one accent both fills a button under the page's
    own light text and is read as text on a card, and both need AA; by night it
    is the bright amber, filled under navy-black text. Registered in app.ts as
    the App's look; `mistri check` names any pair below AA (docs/theming.md). */
export const midnight = defineTheme({
  id: 'midnight',
  label: 'Midnight',
  extends: 'lumen',
  colors: {
    light: {
      ground: '#f4f6f9',
      surface: '#ffffff',
      raised: '#eef1f5',
      ink: '#0e1726',
      inkMuted: '#465266',
      inkSubtle: '#5b6678',
      line: '#dfe4eb',
      lineStrong: '#8a94a6',
      lineControl: '#7f8a9c',
      accent: '#9a5800',
      accentSoft: '#fbf0dc',
      link: '#24477f',
      focus: '#24477f',
      nav: {
        ground: '#0f1a2e',
        ink: '#f3f5f9',
        muted: '#b4bfd1',
        line: '#22314d',
        accent: '#f2b14c',
        // The current room: a lifted navy block with the amber word, not a pale pill under amber.
        current: '#1e2d4a',
        onCurrent: '#f2b14c',
      },
    },
    dark: {
      /* One navy family: the page, the lifted cards, the lines and the captions together. */
      ground: '#0a1020',
      surface: '#111a2c',
      raised: '#18233a',
      ink: '#eef2f8',
      inkMuted: '#c0c9d8',
      inkSubtle: '#9da8bb',
      line: '#25314a',
      lineStrong: '#5d6b86',
      lineControl: '#6e7c97',
      accent: '#f0b04a',
      accentSoft: '#3a2c12',
      link: '#9fbdf0',
      focus: '#9fbdf0',
      nav: {
        ground: '#0c1426',
        ink: '#eef2f8',
        muted: '#a3aec2',
        line: '#22304a',
        accent: '#f0b04a',
        current: '#1a2740',
        onCurrent: '#f0b04a',
      },
    },
  },
  recipes: { bar: 'dark' },
});
