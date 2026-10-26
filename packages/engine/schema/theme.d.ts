/** Built-in structural styles. Custom themes inherit one without changing app layout. */
export type ThemeBase = 'lumen' | 'mono' | 'sage';

/**
 * One mode's colors as a compiled theme holds them: `ThemeColors` flattened, each
 * key its spec path in camel case (`nav.ground` is `navGround`, `status.critical`
 * is `statusCritical`, `chart[0]` is `chart1`) and each worn as the custom property
 * of the same name (`--nav-ground`, `--status-critical`, `--chart-1`). What each
 * color is for is said once, on `ThemeColors`.
 */
export interface ThemePalette {
  ground?: string;
  surface: string;
  field?: string;
  raised?: string;
  line?: string;
  lineStrong?: string;
  lineControl?: string;
  ink: string;
  inkMuted?: string;
  inkSubtle?: string;
  accent: string;
  onAccent?: string;
  accentInk?: string;
  primary?: string;
  onPrimary?: string;
  focus?: string;
  accentSoft?: string;
  link?: string;
  statusGood?: string;
  statusWarning?: string;
  statusCritical?: string;
  statusInfo?: string;
  navGround?: string;
  navInk?: string;
  navMuted?: string;
  navLine?: string;
  navAccent?: string;
  navCurrent?: string;
  navOnCurrent?: string;
  rulesSection?: string;
  rulesHead?: string;
  shadow?: string;
  band?: string;
  rulesWeight?: '1px' | '2px' | '3px';
  rulesControl?: '0px' | '1px' | '2px';
  chart1?: string;
  chart2?: string;
  chart3?: string;
  chart4?: string;
  chart5?: string;
  chart6?: string;
  chart7?: string;
  chart8?: string;
}

/** A color variation, independent of the theme's structure, fonts and radii. */
export interface ThemePaletteVariant {
  /** Unique within this theme; `default` is reserved for its original colors. */
  id: string;
  label: string;
  /** Omitted roles inherit this theme's original mode, then its structural base. */
  light: Partial<ThemePalette>;
  dark: Partial<ThemePalette>;
}

export interface ThemeDefinition {
  /** Unique lowercase slug, not a built-in theme name. */
  id: string;
  label: string;
  base?: ThemeBase;
  /** Opaque six-digit hex colors. Omitted roles inherit the base style. */
  light: ThemePalette;
  dark: ThemePalette;
  /** At most 20 named color variations. Existing light/dark remain the Default palette. */
  palettes?: readonly ThemePaletteVariant[];
  /** Initial palette id; omitted or `default` selects the original light/dark pair. */
  defaultPalette?: string;
  /** `dark`: worn dark until the reader picks a mode. `dark-only`: no light colors of its own — `light` is the dark
      ones, and nothing turns it light. Omitted, it follows the reader and their machine. */
  scheme?: 'dark' | 'dark-only';
  /** CSS font-family stacks, each over the machine's faces or the theme's own (`faces`). */
  fonts?: { ui?: string; data?: string; heading?: string; code?: string };
  /** The font files the theme ships, from the App's directory: each an `@font-face` the page declares. */
  faces?: readonly ThemeFaceDefinition[];
  /** Pixel lengths: a control's up to 16px, a field's and a pill's up to 12px, a panel's up to 20px; `999px` is a
      control's or a pill's `round`. */
  radius?: { control?: string; field?: string; pill?: string; panel?: string };
  /** A panel's edge and the focus ring's width; a rule's and a control's are each mode's `rulesWeight`/`rulesControl`. */
  border?: { panel?: '0px' | '1px' | '2px'; focus?: '2px' | '3px' };
  /** A control's height (`shape.height.control`), a length from 32px to 56px. */
  height?: { control?: string };
  /** Each part's treatment, from the closed menu (`ThemeRecipes`). Omitted parts take the base's. */
  recipes?: ThemeRecipes;
  /** How panels and popups stand off the page, as a look draws it. Omitted, the base's. */
  elevation?: ThemeElevation;
  /** A step for cards and one for what floats, over the elevation's own (`ThemeLifts`). Omitted, the base's. */
  lifts?: ThemeLifts;
  /** The base size and each type role's own (`ThemeTypeDefinition`). Omitted roles take the base's. */
  type?: ThemeTypeDefinition;
  /** How fast things enter: `house`, `brisk` or `still`. Omitted, the base's (house). */
  motion?: ThemeMotion;
  /** How far apart things stand: `tight`, `house` or `airy`. Omitted, the base's (house). */
  rhythm?: ThemeRhythm;
  /** The density a reader sees until they pick their own. Omitted, comfortable. */
  density?: ThemeDensity;
  /** Where the theme would draw the menu, when it is the App's own (`ui.theme.preset`); `ui.shell.placement` wins. */
  shell?: { placement: 'side' | 'top' };
  /** The patterns behind the page and the navigation (`ThemeSurface`). Omitted, none. */
  surface?: ThemeSurface;
  /** Each part's own style (`ThemePartStyle`). */
  parts?: Partial<Record<ThemePart, ThemePartStyle>>;
  /** The icons' weight. Omitted, regular. */
  icons?: ThemeIconWeight;
  /** The theme's own stylesheet, read and scoped (`ThemeSpec.stylesheet`): the file as written, and once the App is
      loaded, where the scoped sheet is served and the pictures it names, by their served names. */
  stylesheet?: { src: string; href?: string; files?: readonly string[] };
}

/**
 * A pattern drawn behind the page or the navigation, never behind a panel or a field: `paper` and `grain` a fine
 * speckle, `grid` squares, `dots` a dot grid, `lines` ruled lines, `scanlines` a screen's. Drawn in the theme's `line`
 * color at `strength` 1, 2 or 3 (omitted, 1); `check` measures text over its darkest point (theme-contrast).
 */
export interface ThemePattern {
  kind: 'paper' | 'grain' | 'grid' | 'dots' | 'lines' | 'scanlines';
  strength?: 1 | 2 | 3;
}
/** Where a theme draws a pattern: `ground`, the page behind the panels; `nav`, behind the menu. */
export interface ThemeSurface {
  ground?: ThemePattern;
  nav?: ThemePattern;
}

/** The icons' weight, from Phosphor's: `regular` (omitted), `light`, `bold` and `fill`. */
export type ThemeIconWeight = 'regular' | 'light' | 'bold' | 'fill';

/**
 * The published parts of an App's page a theme may style one by one (`parts`) and its stylesheet may name
 * (`[data-part="stat"]`). Contract 1: a 1.x release may publish another part, and withdraws none.
 */
export type ThemePart =
  | 'ground'
  | 'bar'
  | 'bar.search'
  | 'nav'
  | 'nav.item'
  | 'nav.current'
  | 'nav.group'
  | 'logo'
  | 'page.title'
  | 'tabs'
  | 'tab.current'
  | 'section'
  | 'section.title'
  | 'stat'
  | 'stat.figure'
  | 'fields'
  | 'field.label'
  | 'table'
  | 'table.head'
  | 'table.row'
  | 'status'
  | 'tag'
  | 'button.primary'
  | 'button.secondary'
  | 'button.quiet'
  | 'link'
  | 'board.lane'
  | 'board.card'
  | 'workflow.step'
  | 'banner'
  | 'steps.step'
  | 'avatar'
  | 'menu'
  | 'dialog'
  | 'chart';

/** A color role by its path in `colors`: `ink`, `nav.ground`, `status.good`, `chart[2]`. */
export type ThemeColorPath =
  | 'ground'
  | 'surface'
  | 'raised'
  | 'band'
  | 'ink'
  | 'inkMuted'
  | 'inkSubtle'
  | 'line'
  | 'lineStrong'
  | 'lineControl'
  | 'accent'
  | 'onAccent'
  | 'accentInk'
  | 'accentSoft'
  | 'link'
  | 'focus'
  | `status.${'good' | 'warning' | 'critical' | 'info'}`
  | `nav.${'ground' | 'ink' | 'muted' | 'line' | 'accent' | 'current' | 'onCurrent'}`
  | `rules.${'section' | 'head'}`
  | `chart[${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}]`;

/**
 * One part's style. Its colors are roles, never hex, so `check` measures its ink on its ground in every mode and
 * palette (theme-part); nothing here moves a box: no size, spacing, order or visibility.
 */
export interface ThemePartStyle {
  /** What it is drawn on. */
  ground?: ThemeColorPath;
  /** Its words; checked at 4.5:1 on its ground (its own, or the one it sits on). */
  ink?: ThemeColorPath;
  /** Its edge, where it draws one. */
  edge?: ThemeColorPath;
  /** Its corner, as one of the theme's: `control`, `field`, `pill`, `panel`, or `square`. */
  radius?: 'control' | 'field' | 'pill' | 'panel' | 'square';
  /** Its lift, a step drawn in the theme's `shadow`. */
  lift?: ThemeLift;
  /** Its face, one of the theme's stacks. */
  face?: 'ui' | 'heading' | 'data';
  weight?: 400 | 500 | 600 | 700;
  case?: 'none' | 'upper' | 'small-caps';
}

/**
 * A font file a theme ships: one `@font-face`. `src` is a `.woff2` or `.woff`
 * file inside the App's directory, written relative to it (`./fonts/x.woff2`);
 * the server serves it from the App's own origin, so nothing is fetched from
 * anywhere else. Name the family in a `type.font` stack to draw in it.
 */
export interface ThemeFace {
  /** The family name a `type.font` stack names it by. */
  family: string;
  /** The file, relative to the App's directory: `./fonts/workshop-mono.woff2`. */
  src: string;
  /** 100 to 900, or a variable file's range as `"100 900"`. Omitted, 400. */
  weight?: number | string;
  /** Omitted, normal. */
  style?: 'normal' | 'italic';
  /**
   * Omitted, the file is cut to Latin when the App loads — the letters, digits,
   * accents and punctuation of English and the Western European languages — so
   * a whole font's Cyrillic, Greek and Vietnamese are not fetched before a
   * heading can draw. `false` ships the file as it is, for an App written in
   * another script.
   */
  subset?: false;
}

/** A face as compiled: its weight said, and once the App is loaded the name it is served under. */
export interface ThemeFaceDefinition {
  family: string;
  src: string;
  weight: string;
  style: 'normal' | 'italic';
  /** `false`: served whole, not cut to Latin. */
  subset?: false;
  /** Set by the server when it read the file: `<name>-<hash>.woff2`. */
  file?: string;
  /** Where it is served, as the App's inside address: `/{app}/_fonts/<file>`. */
  href?: string;
}

/**
 * How panels and popups stand off the page, each as its look draws it: `flat` (Mono) no lift at all, `hairline` the
 * platform's (no card lift, a low float), `soft` (Sage) a mid card and a mid float, `raised` (Lumen) a low card and a
 * high float. `{ card, float }` says the steps instead (`ThemeLifts`).
 */
export type ThemeElevation = 'flat' | 'hairline' | 'soft' | 'raised';
/** One step of lift, each drawn in the theme's `shadow`: none, a hairline's shade, then a low fall (the platform's
    popups), a mid one (Sage's) and a high one (Lumen's). */
export type ThemeLift = 'none' | 'hairline' | 'low' | 'mid' | 'high';
/** A lift for the cards a recipe draws (a section, a field group or a stat boxed by `section`, `fields` or `stat`) and
    one for what floats (a menu, a popover and a drawer, a dialog a step above). Either omitted keeps the look's. */
export interface ThemeLifts {
  card?: ThemeLift;
  float?: ThemeLift;
}
/** How fast things enter: `house` as the platform moves, `brisk` a quarter quicker, `still` with no enter at all, as
    reduced motion draws it. A reader who asks for reduced motion gets `still` under every pace. */
export type ThemeMotion = 'house' | 'brisk' | 'still';
/** How far apart things stand: `house` as the platform spaces a page, `tight` its layout steps (16px and up, and the
    section seam) a quarter closer, `airy` a quarter wider. A control's own padding never moves. */
export type ThemeRhythm = 'tight' | 'house' | 'airy';
export type ThemeDensity = 'compact' | 'comfortable' | 'spacious';

/**
 * The closed menu of treatments a theme picks from, one per part. Every value is
 * one a built-in look wears, or one of the few an App's own theme may (a bar in
 * the navigation's colour, a printed page's rules); an App writes no CSS. The
 * first value of each is the default, the plain structure a theme that extends
 * nothing starts from.
 */
export interface ThemeRecipes {
  /** The side menu's current entry and its rows. */
  nav?: 'tint' | 'inverted' | 'wash' | 'underline' | 'pill' | 'quiet';
  /** The top bar and its search. */
  bar?: 'plain' | 'ruled' | 'dark' | 'airy' | 'soft';
  /** A record's tabs and the selected tab. */
  tabs?: 'pill' | 'inverted' | 'underline' | 'rule' | 'chosen';
  /** A dashboard's window picker (7 days, 30 days). */
  windows?: 'segmented' | 'lifted' | 'chosen';
  /** A stat card. */
  stat?: 'plain' | 'framed' | 'topline' | 'ruled' | 'icon' | 'panel' | 'divided';
  /** A page section on a dashboard. */
  section?: 'open' | 'card' | 'panel';
  /** A record's field groups and forms; `rail` also sets an aside's cards open, as captioned groups between hairlines. */
  fields?: 'open' | 'panel' | 'card' | 'rail';
  /** A table's rows, hover and selection; `banded` lays every other row on the `band` color. */
  table?: 'open' | 'tinted' | 'hairline' | 'card' | 'quiet' | 'banded';
  /** A status value. */
  status?: 'dot' | 'pill' | 'pill-dot' | 'quiet';
  /** A board's lanes and cards. */
  board?: 'ruled' | 'soft' | 'strip';
  /** A chart's areas and marks. */
  chart?: 'plain' | 'wash' | 'gradient' | 'line';
  /** The primary button. */
  buttons?: 'accent' | 'raised';
  /** Links in text. */
  links?: 'plain' | 'underline';
  /** A page section's rule: in the ink, or a hairline. */
  rules?: 'ink' | 'hairline';
  /** A record's avatar. */
  avatar?: 'plain' | 'large' | 'round';
  /** A workflow's steps. */
  workflow?: 'markers' | 'pills';
  /** A dashboard's banner note: a tint of the accent, a soft gradient across it, or plain on the ground. */
  banner?: 'tint' | 'gradient' | 'plain';
  /** A breakdown drawn as steps: cards on the surface with a hairline, each on a pale tint of its tone, or one strip of figures parted by hairlines, with no cards or marks. */
  steps?: 'flat' | 'tinted' | 'strip';
  /** A board lane's value in its head: its tone's tint, a solid tag in its tone, or its name in plain ink. */
  lanes?: 'tint' | 'tag' | 'plain';
  /** A record's head and a list's (the trail, the title, its status and facts, the verbs and a list's tabs): on the
      page's ground, on a band of the raised ground from edge to edge, or a band with the record's avatar large beside
      its title. It paints the box the page placed: it never moves a region, adds to the head or reorders it. */
  header?: 'plain' | 'band' | 'hero';
  /** A required field's mark: a red star after its label, or the word "(optional)" after the labels of the fields that
      may be left empty (`aria-required` stays either way). The words are the form's, in the reader's language. */
  required?: 'star' | 'optional-word';
  /** A checkbox: the browser's own, or drawn as a square in the field's fill with the control's edge and corner, and
      the accent with a check when on. */
  checkbox?: 'native' | 'drawn';
  /** A multi-step form's step header: plain, or ruled with a hairline under it. */
  formStep?: 'plain' | 'ruled';
  /** A form's sticky action bar: a hairline over the page, or raised on the surface with a soft lift. */
  actionBar?: 'plain' | 'raised';
}

/** A mode's colors, by what they are for. Hex `#rrggbb` only. Each is worn as the custom property of its path
    (`ink` is `--ink`, `nav.ground` is `--nav-ground`), and `check` measures the pairs named here in light, dark
    and every palette. */
export interface ThemeColors {
  /** The page. */
  ground: string;
  /** Panels and cards. */
  surface: string;
  /** A field's fill: text boxes, selects, pickers. Checked: the `ink` at 4.5:1 on it. Omitted, `surface`. A filled field
      may draw no edge (`shape.border.control: '0px'`) when this fill stands measurably apart from `ground` and
      `surface` (`check` refuses it otherwise). */
  field?: string;
  /** A row's hover, a panel inside a panel. Omitted, a step of the ink into the surface. */
  raised?: string;
  /** Text; checked at 4.5:1 on `surface`, `ground` and `raised`. */
  ink: string;
  /** Secondary text (a caption, a date), checked as the ink is. Omitted, mixed from the ink. */
  inkMuted?: string;
  /** Tertiary text (a count, a hint). Omitted, mixed from the ink. */
  inkSubtle?: string;
  /** Hairlines: decoration, not checked. */
  line?: string;
  /** Emphasized rules. */
  lineStrong?: string;
  /** A form control's edge — text boxes, selects, pickers; checked at 3:1 on `surface` and `ground`. */
  lineControl?: string;
  /** Buttons, the current item, the focus ring unless `focus` says otherwise: the accent as a fill. */
  accent: string;
  /** The words on an accent fill (a button, a selected tab); checked at 4.5:1 on `accent`. Omitted, the `ground`, or
      the `ink`, white or black when `ground` does not read on the accent: a bright brand orange takes dark words. */
  onAccent?: string;
  /** The accent as text — a link-like action, a current tab's word; checked at 4.5:1 on `surface`, `ground` and
      `raised`. Omitted, the accent, or the accent drawn toward the `ink` until it reads: a brand accent can be a
      fill that is too bright to be text. `link` follows it when `link` is omitted. */
  accentInk?: string;
  /** A form's primary action — Continue, Submit, Add — as a fill: every command form, New form and stepper presses in
      it. Omitted, the look's choice (Lumen's ink, so a form says "next" by weight rather than hue; Mono's and Sage's
      accent), following the theme's own `ink` or `accent` where the look's was that color; the `accent` for a theme
      that extends nothing. Name your accent or brand here to have forms press in it. */
  primary?: string;
  /** The words on `primary`; checked at 4.5:1 on it. Omitted, taken as `onAccent` is. Said only beside `primary`. */
  onPrimary?: string;
  /** The accent's tint, under a selected item. Omitted, 12% of the accent. */
  accentSoft?: string;
  /** Links. Omitted, the accent. */
  link?: string;
  /** The keyboard focus ring: a softer, mid-tone tint of the look's hue, drawn 2px round whatever has focus; checked
      at 3:1 on `surface`, `ground` and `raised` (WCAG 1.4.11). Omitted, the accent. */
  focus?: string;
  /** The meaning colors: done, needs attention, failed, for information; each checked at 4.5:1 on the page and a panel. */
  status?: { good?: string; warning?: string; critical?: string; info?: string };
  /** Up to eight chart series, in order. Adjacent series must stay apart for color-blind readers. */
  chart?: readonly string[];
  /**
   * The navigation — the top bar and the side menu, whichever the shell draws. Omitted parts follow the page.
   * `ground` is behind them; `ink` the entries, `muted` a group's heading, a count and an icon, each checked at
   * 4.5:1 on `ground`; `line` their rules; `accent` the current entry's mark; `current` the current entry's block
   * (omitted, the look's own mark for it — an underline, a tint, an inverted block — stands) and `onCurrent` the
   * words on it (omitted, `ink`; checked at 4.5:1 on `current`).
   */
  nav?: { ground?: string; ink?: string; muted?: string; line?: string; accent?: string; current?: string; onCurrent?: string };
  /** `section`: the rule over a page section and a board's lanes; `head`: the rule under a table's column heads (each
      omitted, the ink — near-white in dark mode). How thick they are is `shape.border.rule`. */
  rules?: { section?: string; head?: string };
  /** The ink every lift is mixed from: a card's, a menu's, a dialog's shadow. Omitted, the look's (its ink by day, its
      ground by night). Never lighter than `ground`: a shadow lighter than the page is a glow (theme-shadow). */
  shadow?: string;
  /** Every other row of a `banded` table (`recipes.table`). Omitted, `raised`. Text on it is checked as on `ground`. */
  band?: string;
}

/** A control's height in pixels, 32 to 56. */
export type ThemeControlHeight = `${32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53 | 54 | 55 | 56}px`;

/** A theme's widths (`shape.border`). */
export interface ThemeBorders {
  rule?: '1px' | '2px' | '3px';
  control?: '0px' | '1px' | '2px';
  panel?: '0px' | '1px' | '2px';
  focus?: '2px' | '3px';
}

/** Partial colors, over a base or the theme's own. */
export type ThemeColorsOver = Partial<Omit<ThemeColors, 'status' | 'nav' | 'rules' | 'chart'>> & {
  /** Series to replace, in order; `null` keeps that series as it was. */
  chart?: readonly (string | null)[];
  status?: ThemeColors['status'];
  nav?: ThemeColors['nav'];
  rules?: ThemeColors['rules'];
};

/** The size an App's text is drawn at; every size grows with it. */
export type ThemeTypeBase = '13px' | '14px' | '15px' | '16px';

/** The face a role is drawn in: one of the theme's stacks (`fonts`): `code` is its monospace (`fonts.code`, the
    platform's own when the theme names none), for figures and labels as Mono sets them. */
export type ThemeTypeFace = 'ui' | 'heading' | 'data' | 'code';
/** Capitals: as written, upper case, or the face's small capitals (all of a word, its capitals included). Either
    capital takes the look's caps tracking unless `tracking` says one. */
export type ThemeTypeCase = 'none' | 'upper' | 'small-caps';
/** What the data face sets: every value (`values`, omitted) or only figures, keys and dates (`figures`). */
export type ThemeTypeReach = 'values' | 'figures';
/** OpenType features a role turns on: figures (`tnum` tabular, `lnum` lining, `onum` old-style), a slashed `zero`,
    `case`-sensitive forms, and a face's stylistic sets and character variants (`ss01`…`ss20`, `cv01`…`cv99`). */
export type ThemeTypeFeature = 'tnum' | 'lnum' | 'onum' | 'zero' | 'case' | `ss${number}` | `cv${number}`;
type TypePx = `${number}px`;
type TypeEm = `${number}em`;
type TypeWeight = 400 | 500 | 600 | 700 | 800 | 900;

/**
 * Each kind of text, by what it is for. A role says only what differs from the look; its size is the size at the
 * 13px base, and grows with `base`. Body, data, label and navigation text has no size of its own: it follows the
 * base. A weight past 700 is for a face the theme ships at that weight (`type.faces`); `check` warns of one it does
 * not (theme-type).
 */
export interface ThemeTypeRoles {
  /** A landing's headline: 28px to 56px. Its leading may go down to 0.85; `check` warns under 1.0 (a line that wraps sets its descenders into the next). */
  display?: { face?: ThemeTypeFace; size?: TypePx; leading?: number; tracking?: TypeEm; weight?: TypeWeight; features?: readonly ThemeTypeFeature[] };
  /** A record's and a dashboard's name: 20px to 36px, its leading 0.85 to 1.8 (`check` warns under 1.0). Its weight is every title's (`--heading-weight`). */
  title?: { face?: ThemeTypeFace; size?: TypePx; leading?: number; tracking?: TypeEm; weight?: TypeWeight; case?: ThemeTypeCase; features?: readonly ThemeTypeFeature[] };
  /** A list naming itself over its rows: 16px to 28px. */
  heading?: { face?: ThemeTypeFace; size?: TypePx; leading?: number; tracking?: TypeEm; weight?: TypeWeight; case?: ThemeTypeCase; features?: readonly ThemeTypeFeature[] };
  /** A section's title, on a record and a dashboard: its face, case and features reach both; its size (12px to 20px),
   * tracking and weight reach a dashboard's section title, so a record's section heads keep the field groups' measure. */
  section?: { face?: ThemeTypeFace; size?: TypePx; tracking?: TypeEm; weight?: TypeWeight; case?: ThemeTypeCase; features?: readonly ThemeTypeFeature[] };
  /** Prose, fields and the interface: its leading, 1.35 to 1.8. */
  body?: { leading?: number; features?: readonly ThemeTypeFeature[] };
  /** The short names things are filed under: a column's head, a stat's label, a record's tabs. */
  label?: { face?: ThemeTypeFace; tracking?: TypeEm; weight?: 400 | 500 | 600 | 700; case?: ThemeTypeCase; features?: readonly ThemeTypeFeature[] };
  /** A table's cells and a record's values, in the data face; tabular figures stay. `reach: 'figures'` sets only
      the figures, keys and dates in it (a table's, a field's and a record header's facts), and leaves names and words
      in the interface face; omitted, every value is in it, and a header's figures too. */
  data?: { features?: readonly ThemeTypeFeature[]; reach?: ThemeTypeReach };
  /** A stat's figure: 18px to 40px; tabular figures stay. */
  figure?: { face?: ThemeTypeFace; size?: TypePx; tracking?: TypeEm; weight?: TypeWeight; features?: readonly ThemeTypeFeature[] };
  /** The menu's entries, in the bar and down the side: never a size of their own, at most 600. */
  nav?: { face?: ThemeTypeFace; tracking?: TypeEm; weight?: 400 | 500 | 600; case?: ThemeTypeCase };
}
export type ThemeTypeRole = keyof ThemeTypeRoles;
/** One role as compiled: every property a role may take. */
export interface ThemeTypeRoleDefinition {
  face?: ThemeTypeFace;
  size?: string;
  leading?: number;
  tracking?: string;
  weight?: number;
  case?: ThemeTypeCase;
  features?: readonly string[];
  reach?: ThemeTypeReach;
}
/** A compiled theme's type: its base and each role's own, the base look's under the theme's. */
export interface ThemeTypeDefinition {
  base?: ThemeTypeBase;
  roles?: Partial<Record<ThemeTypeRole, ThemeTypeRoleDefinition>>;
}

interface ThemeSpecCommon {
  /** Unique lowercase slug, not a built-in theme name. */
  id: string;
  label: string;
  /** Named color variations a reader may pick, each over the theme's own colors. */
  palettes?: readonly { id: string; label: string; light?: ThemeColorsOver; dark?: ThemeColorsOver }[];
  defaultPalette?: string;
  /**
   * `'dark'`: worn dark until the reader picks a mode themselves, whatever their machine is set to; it still has
   * light colors, which are held to a printed page's white paper. `'dark-only'`: no light colors at all — `colors`
   * names `dark` alone, the theme is judged as dark and not as paper, and a reader cannot turn it light. Omitted,
   * the theme follows the reader and their machine.
   */
  scheme?: 'dark' | 'dark-only';
  shape?: {
    /** Corners, each a length: a control's (0px to 16px, or `round`, a pill), a field's (0px to 12px), `pill`, a status
        pill's, a tag's and a chip's (0px to 12px, or `round`; omitted, round), and `panel`, a card's, a section's and
        a dialog's (0px to 20px; omitted, one and a half controls', at most 20px). Always the object; a single length
        is refused. */
    radius?: { control?: string; field?: string; pill?: string; panel?: string };
    /** A preset (`flat`, `hairline`, `soft`, `raised`), or a lift for cards and one for what floats over the base's:
        `{ card: 'low', float: 'mid' }`, each `none`, `hairline`, `low`, `mid` or `high`. */
    elevation?: ThemeElevation | ThemeLifts;
    /** Widths, each omitted for the look's own: `rule`, the rules over a section and under a table's heads (`1px`,
        `2px` or `3px`); `control`, a field's and a select's edge (`1px` or `2px`; `0px` draws none, and is refused unless
        `colors.field` stands measurably apart from the ground and the surface, and then the focus ring is the edge); `panel`, a card's and a section's
        edge where the look draws one (`0px` draws none); `focus`, the focus ring (`2px` or `3px`). */
    border?: ThemeBorders;
    /** Heights: `control`, a field's, a select's and a button's, `32px` to `56px` (omitted, the look's 34px). A touch
        screen keeps a 44px floor whatever this says. */
    height?: { control?: ThemeControlHeight };
  };
  type?: {
    /** CSS font-family stacks: the machine's faces, or the families `faces` ships. */
    font?: string | { ui?: string; data?: string; heading?: string; code?: string };
    /** Font files from the App's directory, each one `@font-face` (at most 12). The heading's face is preloaded. */
    faces?: readonly ThemeFace[];
    /** The size an App's text is drawn at, 13px to 16px; every size grows with it, the roles' too. Omitted, 13px. */
    base?: ThemeTypeBase;
    /** Each kind of text's face, size, leading, tracking, weight, case and OpenType features (`ThemeTypeRoles`). */
    roles?: ThemeTypeRoles;
    /** The icons' weight: `regular` (omitted), `light`, `bold` or `fill`. */
    icons?: ThemeIconWeight;
  };
  density?: ThemeDensity;
  /** How fast things enter: `house` (omitted), `brisk` a quarter quicker, or `still`, nothing entering. */
  motion?: ThemeMotion;
  /** How far apart things stand: `house` (omitted), `tight` a quarter closer, or `airy` a quarter wider. */
  rhythm?: ThemeRhythm;
  recipes?: ThemeRecipes;
  /**
   * Where the menu is drawn: beside the page or in the top bar. A suggestion: it holds when the theme is the App's
   * own (`ui.theme.preset`) and `ui.shell.placement` says nothing; a reader who picks another theme keeps the App's
   * shell.
   */
  shell?: { placement?: 'side' | 'top' };
  /** A pattern behind the page and one behind the navigation (`ThemeSurface`). */
  surface?: ThemeSurface;
  /** Each published part's own colors, corner, lift, face, weight and case (`ThemePartStyle`). */
  parts?: { readonly [P in ThemePart]?: ThemePartStyle };
  /**
   * One CSS file beside the theme (`./theme.css`, at most 8 KB), read against an allowlist: rules on published parts
   * (`[data-part="stat"]`) that say colors as roles, gradients, borders, corners, lifts, faces and letter case, and
   * nothing that moves a box. It is drawn in the `theme` layer, over the look and under the structure, only while
   * the theme is worn (theme-css).
   */
  stylesheet?: `./${string}.css`;
  /** The theme contract it was written to. A package says `1`; a newer one than this tablewalk knows is refused. */
  contract?: 1;
  /** Where its files are read from: a package's `import.meta.url`. Omitted, the App's directory. */
  from?: string;
}

/**
 * A theme as `defineTheme` takes it. Without `extends` it names every color it
 * needs and starts from the plain structure (every recipe's first value); with `extends` it starts from that
 * built-in look and says only what differs.
 */
export type ThemeSpec =
  | (ThemeSpecCommon & { extends?: undefined; colors: { light: ThemeColors; dark: ThemeColors } })
  | (ThemeSpecCommon & { extends?: undefined; scheme: 'dark-only'; colors: { light?: undefined; dark: ThemeColors } })
  | (ThemeSpecCommon & { extends: ThemeBase | Theme; colors?: { light?: ThemeColorsOver; dark?: ThemeColorsOver } });

/** What `defineTheme` returns: the spec, marked. */
export type Theme<S extends ThemeSpec = ThemeSpec> = S & { readonly kind: 'theme' };
