import { defineTheme } from '@mistriwork/mistri/app';

/* Calm, confident, one thing at a time. A page asks one question and says it large: titles in Figtree, set big and
   tight, over a gray lead line; fields are soft warm-gray wells rather than outlined boxes; and one persimmon orange
   is spent only where the reader acts (the primary button, the current place). Everything else is off-white paper
   with a faint warm track behind what is raised, and room to breathe. The persimmon (#f26430) sits a few degrees
   redder and a shade softer than a highlighter orange, so it reads as a kitchen-warm hearth color, not a safety
   vest, and it takes dark words, as a bright orange must to read. It extends Lumen for its structure and recipes;
   colors, faces, corners and spacing are its own. */
export const hearth = defineTheme({
  id: 'hearth',
  label: 'Hearth',
  extends: 'lumen',
  colors: {
    light: {
      // Warm off-white paper under white working surfaces: a card, a menu, a dialog. A field is a well in the warm
      // track (#eeede7), 1.08:1 from the paper and 1.17:1 from white, with no edge: the fill is the field, the label
      // stands over it, and the focus ring draws its edge (the theme check holds a field with no edge to 1.08:1).
      ground: '#f7f6f2',
      surface: '#ffffff',
      field: '#eeede7',
      raised: '#eeede7',
      ink: '#161513',
      inkMuted: '#5e5b55',
      inkSubtle: '#6c665e',
      line: '#e6e4dd',
      lineControl: '#8a867d',
      accent: '#f26430',
      onAccent: '#161513',
      // The persimmon as text (a link, a current tab's word) is its own deeper cut, so the fill can stay bright.
      accentInk: '#a8441f',
      link: '#a8441f',
      focus: '#161513',
      // Meaning keeps clear of the persimmon: an ochre warning and a slate info, never a second bright hue.
      status: { good: '#1a7b3c', warning: '#8a5600', critical: '#bb2124', info: '#33618c' },
      nav: { ground: '#f7f6f2', line: '#e6e4dd', accent: '#a8441f' },
      chart: ['#c9521f', '#3a6ea8', '#1e8566', '#a87612'],
    },
    // Warm charcoal, written on its own: the persimmon a step lighter (still dark words on it), its text a peach that
    // reads on every ground, and meaning in softened tones so nothing outshouts the one accent.
    dark: {
      ground: '#151412',
      surface: '#1f1d1a',
      // A step lighter than the surface, 1.29:1 from the ground and 1.17:1 from the surface, so the well reads at night.
      field: '#2c2a26',
      raised: '#292723',
      ink: '#f3f1eb',
      inkMuted: '#b6b1a7',
      line: '#34312c',
      lineControl: '#857f74',
      accent: '#ff7845',
      onAccent: '#161513',
      // Lumen's night link is a periwinkle; Hearth's stays in the persimmon's family.
      accentInk: '#ff9466',
      link: '#ff9466',
      focus: '#f3f1eb',
      status: { good: '#6fcf8f', warning: '#e3ad55', critical: '#ff8a7a', info: '#93b8e0' },
      nav: { ground: '#151412', line: '#34312c', accent: '#ff9466' },
      chart: ['#ff7845', '#7fa8de', '#4cc39a', '#e0b04a'],
    },
  },
  type: {
    font: {
      ui: 'Figtree, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      heading: 'Figtree, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      data: 'Figtree, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    },
    faces: [{ family: 'Figtree', src: './fonts/figtree.woff2', weight: '300 900' }],
    base: '14px',
    roles: {
      // The idea wants 0.95 to 1.0. A name that wraps sets its descenders into the next line under 1.0, which `check`
      // warns of, so the titles stop at 1.0: tight, and clear of themselves.
      display: { size: '48px', leading: 1.0, weight: 600, tracking: '-0.025em' },
      title: { size: '34px', leading: 1.0, weight: 600, tracking: '-0.022em' },
      heading: { size: '26px', leading: 1.1, weight: 600, tracking: '-0.018em' },
      section: { size: '17px', weight: 600, tracking: '-0.01em' },
      body: { leading: 1.5 },
      label: { weight: 600 },
      figure: { weight: 600, tracking: '-0.01em' },
    },
  },
  shape: {
    radius: { control: 'round', field: '10px', panel: '16px' },
    // The ring is 3px so it still draws past 2px under the density's zoom, where a 2px ring falls below 2.
    border: { control: '0px', focus: '3px' },
    elevation: 'soft',
  },
  // Compact, as Lumen, and the house rhythm: the rent roll's eleven columns and a repair list's four tabs keep to a
  // desk. Density and rhythm reach every page alike, so the room comes from the larger base and the titles instead
  // (airy spaced the tabs a quarter wider and folded one into More).
  density: 'compact',
  // "(optional)" after the labels that may be left empty, in place of a star on the ones that may not.
  recipes: { buttons: 'accent', fields: 'open', tabs: 'underline', nav: 'pill', status: 'dot', header: 'plain', required: 'optional-word' },
});
