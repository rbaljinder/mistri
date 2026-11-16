/**
 * The recipe families: two words a theme may say in `recipes`, each choosing several parts at once.
 *
 * The menu (themeRecipes.ts) is one choice a part, twenty-four of them, and a page is drawn by several parts side by
 * side: a record's field groups beside its tables, a dashboard's stats over its sections. Chosen one by one they
 * disagree easily, a panel beside a block left open on the page. A family is the choice made once: `blocks` says how
 * a page's blocks are held, `current` how the current one of several is shown, and each names the value of every
 * part it covers, values that are drawn together in a built-in look and so are known to agree.
 *
 * A family sets a part's DEFAULT. What a theme says of a part itself wins over its family, and a family the theme
 * says wins over the parts of the look it extends. Families are resolved when a theme is built (themeBuild.ts); a
 * compiled theme carries the parts only, so the first paint, which sets one attribute a part, knows nothing of them
 * and this module stays out of it.
 */
import type { ThemeRecipeFamilies, ThemeRecipes } from '../../schema/theme.js';

type Families = {
  readonly [Family in keyof ThemeRecipeFamilies]-?: Readonly<Record<NonNullable<ThemeRecipeFamilies[Family]>, ThemeRecipes>>;
};

export const RECIPE_FAMILIES = {
  /* How a block is held. Each row is a built-in look's own pairing: `open` is Workshop's, `ruled` Atelier's, `card`
     Graphite's (its steps apart), `panel` Sage's and `tile` Bloom's. */
  blocks: {
    open: { section: 'open', fields: 'open', stat: 'divided', table: 'open', steps: 'strip' },
    ruled: { section: 'open', fields: 'rail', stat: 'ruled', table: 'hairline', steps: 'strip' },
    card: { section: 'card', fields: 'card', stat: 'panel', table: 'card', steps: 'flat' },
    panel: { section: 'panel', fields: 'panel', stat: 'panel', table: 'hairline', steps: 'flat' },
    tile: { section: 'panel', fields: 'panel', stat: 'bento', table: 'rows', steps: 'tinted' },
  },
  /* How the current one is shown. `inverted` is Mono's pairing, `tint` Sage's (its menu apart), `pill` Bloom's and
     Lumen's (a menu apart, a record's tabs apart). An underlined menu entry is the top bar's; beside the page the
     menu keeps its tint, so `underline` leaves no menu unmarked. */
  current: {
    tint: { nav: 'tint', tabs: 'tint', windows: 'tint' },
    inverted: { nav: 'inverted', tabs: 'inverted', windows: 'segmented' },
    underline: { nav: 'underline', tabs: 'underline', windows: 'tint' },
    pill: { nav: 'pill', tabs: 'pill', windows: 'lifted' },
    lifted: { nav: 'tint', tabs: 'lifted', windows: 'lifted' },
  },
} as const satisfies Families;

export const RECIPE_FAMILY_NAMES = Object.keys(RECIPE_FAMILIES) as (keyof ThemeRecipeFamilies)[];

/** Each family's values said in a sentence, for the schema and the reference: what the page looks like, not the parts. */
export const RECIPE_FAMILY_WORDS: {
  readonly [Family in keyof ThemeRecipeFamilies]-?: Readonly<Record<NonNullable<ThemeRecipeFamilies[Family]>, string>>;
} = {
  blocks: {
    open: 'Every block stands open on the page: sections and tables under a rule, and the stats in one ruled strip, the only box.',
    ruled:
      'A printed page: blocks open under rules, each stat under a rule of its own, a record’s side groups captioned between hairlines.',
    card: 'Every block is a card with a hairline and the card shadow: sections, field groups, stats and tables.',
    panel: 'Every block is a panel on the surface with a hairline: sections, field groups and stats; a table stays open inside its panel.',
    tile: 'Every block is a soft tile: stats as tiles with a large figure, a list as one tile with its rows ruled apart, steps tinted with their tone.',
  },
  current: {
    tint: 'The current entry, tab and window each sit on a soft tint of the accent.',
    inverted: 'The current entry and tab are inverted to the ink, and the chosen window is a filled segment: square, high-contrast.',
    underline:
      'The current tab, and the current entry in a top bar, are underlined in the accent with no fill; a chosen window sits on a tint.',
    pill: 'The current entry and tab are pills, and the chosen window is a raised key on a tray.',
    lifted: 'The tabs and the windows stand in sunken tracks, the chosen one a raised key lifted out; the menu’s entry sits on a tint.',
  },
};

/** One family's values said, in order: the schema's description of the family. */
export function familyDescription(family: keyof ThemeRecipeFamilies): string {
  return Object.entries(RECIPE_FAMILY_WORDS[family] as Record<string, string>)
    .map(([value, words]) => `\`${value}\`: ${words}`)
    .join(' ');
}

/** The parts a theme's families pick, `blocks` then `current`: no part is in both. Empty where it says neither. */
export function familyRecipes(recipes: (ThemeRecipes & ThemeRecipeFamilies) | undefined): ThemeRecipes {
  const picked: ThemeRecipes = {};
  for (const family of RECIPE_FAMILY_NAMES) {
    const value = recipes?.[family];
    if (value !== undefined) Object.assign(picked, (RECIPE_FAMILIES[family] as Record<string, ThemeRecipes>)[value]);
  }
  return picked;
}

/** A theme's recipes without its families: the parts it says itself. */
export function recipeParts(recipes: (ThemeRecipes & ThemeRecipeFamilies) | undefined): ThemeRecipes {
  const { blocks: _blocks, current: _current, ...parts } = recipes ?? {};
  return parts;
}
