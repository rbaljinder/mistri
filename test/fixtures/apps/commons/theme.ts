import { defineTheme } from '@mistriwork/mistri/app';

/** Commons' look: a printed page — warm paper, near-black ink, a serif over
    the headlines and figures, capitals over the columns, rules instead of
    boxes, and one red for what is current. A forum is read more than it is
    operated, long posts and long threads, so it dresses like reading. It
    extends no built-in look: every colour not named here is derived from the
    paper and the ink, and the recipes are the printed page's
    (docs/theming.md). */
export const commons = defineTheme({
  id: 'commons',
  label: 'Commons',
  colors: {
    light: {
      ground: '#f6f3ec',
      surface: '#fbf9f4',
      raised: '#efebe1',
      ink: '#1c1a17',
      line: '#ddd6c7',
      lineControl: '#7a7263',
      accent: '#1c1a17',
      link: '#9b2a1d',
      nav: { ground: '#f6f3ec', line: '#1c1a17', accent: '#9b2a1d' },
    },
    dark: {
      ground: '#14120f',
      surface: '#1b1915',
      raised: '#23201b',
      ink: '#f1ece1',
      line: '#38342c',
      lineControl: '#8b8475',
      accent: '#f1ece1',
      link: '#e8826d',
      nav: { ground: '#14120f', line: '#f1ece1', accent: '#e8826d' },
    },
  },
  shape: { radius: { control: '2px', field: '2px' } },
  type: {
    font: { heading: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' },
    roles: {
      title: { size: '30px' },
      label: { case: 'small-caps' },
      figure: { face: 'heading', weight: 600, features: ['lnum'] },
    },
  },
  recipes: { nav: 'underline', bar: 'ruled', tabs: 'rule', stat: 'ruled' },
});
