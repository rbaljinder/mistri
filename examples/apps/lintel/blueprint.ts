import { defineTheme } from '@mistriwork/mistri/app';

/* The office's drawing set. By day the App is an ink drawing on vellum: one Prussian-blue ink for every word and
   line, a faint drafting grid under the page, square corners, and the lettering of a title block (capitals for
   names, a monospace for labels and figures, as a dimension is written). By night it is the blueprint itself,
   written on its own rather than inverted: white lines on cyanotype blue. Red is kept for what a drawing marks in
   red, a correction: the overdue and the urgent. It extends no built-in look; every color not named is derived. */
export const blueprint = defineTheme({
  id: 'blueprint',
  label: 'Blueprint',
  colors: {
    light: {
      ground: '#eff0ea',
      surface: '#fafaf6',
      raised: '#e5e7df',
      ink: '#132a4f',
      line: '#ced7e4',
      lineControl: '#66789a',
      accent: '#1d4a91',
      link: '#1d4a91',
      status: { good: '#0b7736', critical: '#b3261e' },
      nav: { ground: '#e5e7df', line: '#132a4f', accent: '#1d4a91' },
      chart: ['#1d4a91', '#b3261e', '#6c8fc4', '#8a6a12'],
    },
    dark: {
      ground: '#0e2f5e',
      surface: '#12386d',
      raised: '#18427c',
      ink: '#f3f7ff',
      line: '#46699d',
      lineControl: '#93add6',
      accent: '#f3f7ff',
      link: '#cfe0ff',
      status: { critical: '#ffb1a6' },
      nav: { ground: '#0b2850', line: '#46699d', accent: '#f3f7ff' },
      chart: ['#f3f7ff', '#ffb1a6', '#8fb8f5', '#f2cf72'],
    },
  },
  surface: { ground: { kind: 'grid' } },
  shape: { radius: { control: '0px', field: '0px', panel: '0px', pill: '0px' }, elevation: 'hairline' },
  type: {
    font: {
      heading: '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif',
      code: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    },
    roles: {
      title: { face: 'heading', size: '28px', case: 'upper', tracking: '0.04em', weight: 600 },
      heading: { face: 'heading', case: 'upper', tracking: '0.04em' },
      section: { face: 'code', case: 'upper' },
      label: { face: 'code', case: 'upper', tracking: '0.02em' },
      figure: { face: 'code', weight: 600 },
    },
  },
  // Compact, as Lumen, so the rent roll's eleven columns keep to a desk; a drawing's margins are wide, so the sections
  // stand a quarter further apart.
  density: 'compact',
  rhythm: 'airy',
  recipes: { nav: 'inverted', bar: 'ruled', tabs: 'rule', stat: 'ruled', table: 'open', status: 'dot', header: 'hero' },
  // A status is lettered as a drawing's notes are, in capitals.
  parts: { status: { case: 'upper' } },
});
