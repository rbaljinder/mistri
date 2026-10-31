/**
 * What `mistri grade` makes of a page's measurements: the codes, their levels and fixes, and the judgement of
 * each measurement — pure, so it is tested without a browser, and shared by the command (grade.ts) and the
 * browser suite that holds the probe to fixture pages (e2e/grade.spec.ts).
 */
import type { ContrastReading, Probe } from './gradeProbe.js';
import { promiseOf, type ContractPromise } from './themeContract.js';

/** The windows each page is measured in: a desk, a tablet, a phone, the narrowest phone, and a phone in the dark. */
export const WINDOWS = [
  { label: '1280', width: 1280, height: 900, dark: false },
  { label: '768', width: 768, height: 1024, dark: false },
  { label: '390', width: 390, height: 844, dark: false },
  { label: '320', width: 320, height: 640, dark: false },
  { label: '390-dark', width: 390, height: 844, dark: true },
] as const;
export type Window = (typeof WINDOWS)[number];

/* A phone is what the shell lays out as one (760px and under, structure.css): there a thumb is the pointer. */
export const PHONE = 760;
/* The smallest target a thumb is asked to hit: docs/design.md's 44px on a coarse pointer (rule 8; a pointer's 24px is
   the desk's). The rubric once drew its line at 40 for a phone, below the document that sets it. */
export const TAP = 44;
/* Core Web Vitals' line between good and needs-improvement. */
const SHIFT = 0.1;
/* The theme contract's lines (themeContract.ts): a focus ring 2px at 3:1 (C3), prose at most 80 characters a line
   (C8), no motion past 200ms (C9), and a theme's own files on a cold visit within the faces' 150 KB and a logo (C11). */
const FOCUS = { width: 2, ratio: 3 } as const;
const MEASURE = 80;
export const MOTION = 200;
const THEME_BYTES = 200 * 1024;

export type Severity = 'error' | 'warning';

/** The codes grade says, each with its level and its fix, in the order a run reports them. */
export const GRADE_CODES = {
  'page-error': { severity: 'error', fix: 'open the page and read the console; mistri check --app names most causes' },
  'failed-request': {
    severity: 'error',
    fix: "the server's log says why; a 404 is a route, a file or a record the page asks for and the App does not have",
  },
  'sideways-scroll': {
    severity: 'error',
    fix: 'something is wider than the window: show fewer columns (show: […]), let the row wrap, or draw the section full width; mistri shot --phone --width <px> to look',
  },
  'clipped-number': {
    severity: 'error',
    fix: "a figure is never cut: give its column room (fewer columns beside it, show: […]) or its section more width (width: 'full')",
  },
  overlap: { severity: 'error', fix: 'two controls share pixels: let the row wrap, or move one into the ⋯ menu' },
  'low-contrast': {
    severity: 'error',
    fix: "text reads at 4.5:1 (3:1 large): use the look's tokens (--ink, --ink-muted) rather than a color of your own",
  },
  'faint-edge': {
    severity: 'error',
    fix: "a field's, a select's and a picker's edge reads at 3:1 on what it sits on: the look's control edge (--line-control), never a hairline of your own",
  },
  'hidden-focus': {
    severity: 'error',
    fix: `a keyboard reader sees where they are: a ring of ${FOCUS.width}px at ${FOCUS.ratio}:1 (the look's --focus), never outline: none without a ring in its place`,
  },
  'print-contrast': {
    severity: 'error',
    fix: 'printed, words, links and the accent read at 4.5:1 on white paper: a light-mode accent and link that read on white',
  },
  'changed-app': {
    severity: 'error',
    fix: 'a theme changes how the App looks, never which controls a reader can reach (a control folded into a "More" menu counts where grade opened it and found the control): report the part whose control went missing under the theme',
  },
  'layout-shift': {
    severity: 'error',
    fix: 'something moves once drawn: give the late part its height before it arrives (a placeholder, a fixed size for an image or chart)',
  },
  'clipped-text': {
    severity: 'warning',
    fix: 'words are cut mid-word: let them wrap, or say less (a shorter label, values: { … } words)',
  },
  'small-target': {
    severity: 'warning',
    fix: `on a phone a control is at least ${TAP}px each way: padding, not a smaller box; where it is the platform's own control, say so in your report rather than restyling it`,
  },
  'empty-section': {
    severity: 'warning',
    fix: "a section with nothing in it says what belongs there: empty: 'No visits yet.' on the list, or hide it (hidden when empty)",
  },
  'mixed-format': {
    severity: 'warning',
    fix: "one surface says its figures one way: one format for the column (display: { col: { format: 'money' } }), not text built by hand",
  },
  'round-ticks': {
    severity: 'warning',
    fix: "an axis counts in round steps (0 / 2k / 4k): let the chart choose its scale rather than a fixed max, and say the figure's format: display: { col: { format: 'money' } }",
  },
  'color-only': {
    severity: 'warning',
    fix: 'a toned mark says its value in words too: a status as its dot and word, or an aria-label on a mark that stands alone',
  },
  'long-measure': {
    severity: 'warning',
    fix: `prose reads at most ${MEASURE} characters a line: a narrower column (a section beside it, or width: 'half'), not smaller type`,
  },
  'unsafe-motion': {
    severity: 'warning',
    fix: `nothing moves under reduced motion and nothing takes past ${MOTION}ms: the platform's motion tokens (--dur-*), and a spinner only while it waits`,
  },
  'heavy-theme': {
    severity: 'warning',
    fix: "a theme's faces and logo stay light on a cold visit: fewer weights, a variable face, a smaller or SVG logo",
  },
  'header-wrap': {
    severity: 'warning',
    fix: "a record's name keeps to two lines on a phone: a shorter recordLabel (the name, not every part of it), the rest as header facts",
  },
} as const satisfies Record<string, { severity: Severity; fix: string }>;
export type GradeCode = keyof typeof GRADE_CODES;

/** What a capture saw happen besides what the probe measured: the page's own errors and the requests that failed. */
export interface Events {
  errors: string[];
  failed: string[];
}

/** One judgement on one capture: the code, its words, and the fix. */
export interface Judged {
  code: GradeCode;
  severity: Severity;
  message: string;
  fix: string;
  /** `theme` where the theme graded (`grade --theme`) caused it rather than the App: its token, or its type and density. */
  cause?: 'theme';
  /** The theme contract's promise the code holds (themeContract.ts); absent for a code that holds none. */
  promise?: ContractPromise;
  /** The theme's first color below the rule: the token's path, the color it draws, the ground and the ratio it needs —
      what the matrix names a passing value for. */
  token?: { path: string; value: string; ground: string; need: number };
}

/**
 * The theme a page is graded in (`grade --theme`), as its findings name it: each colour it draws with, by the hex
 * the page paints, to the path the theme writes it at (`cadence.colors.light.lineControl`), in each mode.
 */
export interface GradedTheme {
  label: string;
  tokens: { light: ReadonlyMap<string, readonly string[]>; dark: ReadonlyMap<string, readonly string[]> };
  /** The colours a platform part mixes from a token (theme.ts componentInks: a category chip's ink from its series),
      by the ink and ground the page paints (`#7c7883 #fefbfd`), to the token and the part:
      `care.colors.light.chart[3] as a board card's category chip`. */
  components?: { light: ReadonlyMap<string, readonly string[]>; dark: ReadonlyMap<string, readonly string[]> };
}

/** A mixed pair as the browser rounds it (`<ink> <ground>`): the same within a step or two of a channel. */
function nearest(map: ReadonlyMap<string, readonly string[]> | undefined, fg: string | undefined, bg: string | undefined) {
  if (!map || !fg || !bg) return undefined;
  const channels = (value: string) => [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16));
  const close = (a: string, b: string) => channels(a).every((value, index) => Math.abs(value - channels(b)[index]!) <= 2);
  for (const [key, paths] of map) {
    const [ink, ground] = key.split(' ') as [string, string];
    if (close(ink, fg) && close(ground, bg)) return paths;
  }
  return undefined;
}

/** The codes a theme's type scale and density can cause where its default look does not: what grade measures again. */
export const LAYOUT_CODES: ReadonlySet<GradeCode> = new Set([
  'sideways-scroll',
  'clipped-number',
  'clipped-text',
  'overlap',
  'small-target',
  'header-wrap',
]);

/** A layout finding the App's own look does not have on the same page and window: the theme's type and density cause it. */
export function blameLayout(finding: Judged, theme: { label: string; worn: string; placement?: 'side' | 'top' }): Judged {
  /* A theme that moves the menu (its shell.placement) changes the page's width as well as its type. */
  const parts = theme.placement ? 'type scale, density or menu placement' : 'type scale or density';
  return {
    ...finding,
    cause: 'theme',
    message: `${finding.message}; not so in ${theme.worn}, so ${theme.label}'s ${parts} causes it`,
    fix: `the theme's, not the App's: a smaller type.base, type.roles title size or density in ${theme.label}${theme.placement ? `, or the menu ${theme.placement === 'top' ? 'at the side' : 'on top'}` : ''}, and say which part did not hold (the platform's parts should hold under every scale and density)`,
  };
}

const judged = (code: GradeCode, message: string): Judged => {
  const promise = promiseOf(code);
  return { code, severity: GRADE_CODES[code].severity, message, fix: GRADE_CODES[code].fix, ...(promise ? { promise } : {}) };
};
const some = <T>(items: readonly T[], say: (item: T) => string, most = 3) =>
  `${items.slice(0, most).map(say).join(', ')}${items.length > most ? `, and ${items.length - most} more` : ''}`;
export const count = (n: number, one: string, other = `${one}s`) => `${n} ${n === 1 ? one : other}`;

/** A figure as a reader reads it, or undefined where the words are not one: `$1,234.50`, `12%`, `4k`. */
export function readFigure(
  text: string,
):
  | { value: number; currency?: string; grouped: boolean; digits: number; decimals: number; compact?: string; percent: boolean }
  | undefined {
  const match = /^([-−+])?\s?([$€£¥₹])?\s?(\d[\d,  ']*)(?:\.(\d+))?\s?(%|[kKMB]|bn)?$/.exec(text.trim());
  if (!match) return undefined;
  const [, sign, currency, whole, fraction = '', suffix] = match;
  const digits = whole!.replace(/[^\d]/g, '');
  /* A separator where no group of three follows is not a thousands mark: "1,2" is a list or a decimal comma. */
  if (/[,  ']/.test(whole!) && !/^\d{1,3}([,  ']\d{3})+$/.test(whole!)) return undefined;
  const scale = { k: 1e3, K: 1e3, M: 1e6, B: 1e9, bn: 1e9 }[suffix ?? ''] ?? 1;
  const value = Number(`${digits}.${fraction || '0'}`) * scale * (sign === '-' || sign === '−' ? -1 : 1);
  return {
    value,
    ...(currency ? { currency } : {}),
    grouped: digits.length !== whole!.length,
    digits: digits.length,
    decimals: fraction.length,
    ...(suffix && suffix !== '%' ? { compact: suffix } : {}),
    percent: suffix === '%',
  };
}

/** Why one surface's figures read two ways, or undefined where they read one. A table's column is one measure; a
    section holds several — a part's quantity beside its price, a year beside a total — so there a bare figure
    beside money, or an ungrouped one beside grouped, is two measures, not one said two ways. Cents and compact
    still count there: money is money wherever it stands. */
export function mixedFormats(values: readonly string[], { column = true }: { column?: boolean } = {}): string | undefined {
  const read = values.map((text) => ({ text, figure: readFigure(text) })).filter((entry) => entry.figure);
  const big = read.filter((entry) => entry.figure!.digits >= 4 && !entry.figure!.compact);
  const grouped = big.filter((entry) => entry.figure!.grouped);
  const plain = big.filter((entry) => !entry.figure!.grouped);
  if (column && grouped.length && plain.length) return `thousands grouped and not: ${grouped[0]!.text} beside ${plain[0]!.text}`;
  const money = read.filter((entry) => entry.figure!.currency && !entry.figure!.compact);
  const cents = money.filter((entry) => entry.figure!.decimals > 0);
  const whole = money.filter((entry) => entry.figure!.decimals === 0);
  if (cents.length && whole.length) return `money with and without cents: ${whole[0]!.text} beside ${cents[0]!.text}`;
  const compact = read.filter((entry) => entry.figure!.compact);
  const full = read.filter((entry) => !entry.figure!.compact && !entry.figure!.percent && Math.abs(entry.figure!.value) >= 1000);
  if (compact.length && full.length) return `compact and full figures: ${compact[0]!.text} beside ${full[0]!.text}`;
  const currencies = new Set(read.map((entry) => entry.figure!.currency).filter(Boolean));
  const bare = read.filter((entry) => !entry.figure!.currency && !entry.figure!.percent);
  if (column && currencies.size && bare.length && money.length >= bare.length)
    return `money with and without its currency: ${money[0]!.text} beside ${bare[0]!.text}`;
  return undefined;
}

/** A step a reader counts in: 1, 2, 2.5 or 5 of a power of ten. */
const niceStep = (step: number) => {
  const power = 10 ** Math.floor(Math.log10(step));
  const lead = step / power;
  return [1, 2, 2.5, 5, 10].some((nice) => Math.abs(lead - nice) < 1e-6);
};

/** Why an axis's labels are not round steps, or undefined where they are (or are not figures: days, names). */
export function roundTicks(labels: readonly string[]): string | undefined {
  const figures = labels.map(readFigure);
  if (figures.length < 2 || figures.some((figure) => !figure)) return undefined;
  const values = [...new Set(figures.map((figure) => figure!.value))].sort((a, b) => a - b);
  if (values.length < 2) return undefined;
  const step = values[1]! - values[0]!;
  const even = values.every((value, i) => i === 0 || Math.abs(value - values[i - 1]! - step) <= step * 1e-6);
  const aligned = values.every((value) => Math.abs(value / step - Math.round(value / step)) < 1e-6);
  return even && aligned && niceStep(step) ? undefined : `ticks ${labels.join(' / ')} are not round steps`;
}

/** Every finding one capture makes, judged from what the probe measured and what happened while it was drawn. */
export function judge(
  probe: Probe,
  contrast: readonly ContrastReading[],
  events: Events,
  window: { width: number; dark: boolean },
  theme?: GradedTheme,
): Judged[] {
  const found: Judged[] = [];
  for (const error of events.errors) found.push(judged('page-error', error));
  if (events.failed.length)
    found.push(
      judged(
        'failed-request',
        some(events.failed, (line) => line),
      ),
    );
  if (probe.sideways > 1) found.push(judged('sideways-scroll', `the page scrolls ${Math.round(probe.sideways)}px sideways`));
  const numbers = probe.clipped.filter((entry) => entry.numeric);
  if (numbers.length)
    found.push(
      judged(
        'clipped-number',
        `${count(numbers.length, 'figure')} cut off: ${some(numbers, (entry) => `${entry.what}${entry.ellipsis ? ' (an ellipsis)' : ''}`)}`,
      ),
    );
  /* An ellipsis on words is the platform's way of keeping a long name to its column: said, not cut. */
  const words = probe.clipped.filter((entry) => !entry.numeric && !entry.ellipsis);
  if (words.length)
    found.push(judged('clipped-text', `${count(words.length, 'text')} cut mid-word: ${some(words, (entry) => entry.what)}`));
  if (probe.overlaps.length)
    found.push(
      judged(
        'overlap',
        `${count(probe.overlaps.length, 'pair')} of controls drawn over each other: ${some(probe.overlaps, (pair) => `${pair.a} and ${pair.b}`)}`,
      ),
    );
  if (window.width <= PHONE && probe.small.length)
    found.push(
      judged(
        'small-target',
        `${count(probe.small.length, 'control')} under ${TAP}px: ${some(probe.small, (target) => `${target.what} ${target.width}×${target.height}`)}`,
      ),
    );
  /* A control's edge is a graphic (C2), apart from words (C1): a theme that fails one passes or fails the other. */
  const below = contrast.filter((reading) => reading.ratio < reading.need);
  const edges = below.filter((reading) => reading.what.startsWith('edge of '));
  const low = below.filter((reading) => !reading.what.startsWith('edge of '));
  if (low.length) {
    const finding = judged(
      'low-contrast',
      `${count(low.length, 'reading')} below the rule: ${some(low, (reading) => `${reading.what} ${reading.ratio}:1 (needs ${reading.need}:1)`)}`,
    );
    found.push(...(theme ? blameContrast(finding, low, theme, window.dark) : [finding]));
  }
  if (edges.length) {
    const finding = judged(
      'faint-edge',
      `${count(edges.length, 'control edge')} below 3:1: ${some(edges, (reading) => `${reading.what} ${reading.ratio}:1`)}`,
    );
    found.push(...(theme ? blameContrast(finding, edges, theme, window.dark) : [finding]));
  }
  const focus = probe.focus ?? [];
  /* A ring is 2px at 3:1; a stop drawn without one is still seen where its look changes otherwise (a fill, an edge). */
  const hidden = focus.filter((stop) => !(stop.width >= FOCUS.width && (stop.ratio ?? FOCUS.ratio) >= FOCUS.ratio) && !stop.changed);
  if (hidden.length)
    found.push(
      judged(
        'hidden-focus',
        `${hidden.length} of ${count(focus.length, 'focus stop')} show no ring of ${FOCUS.width}px at ${FOCUS.ratio}:1: ${some(hidden, (stop) => `${stop.what} ${!stop.width ? 'no ring' : stop.width < FOCUS.width ? `${stop.width}px` : `${stop.ratio}:1`}`)}`,
      ),
    );
  if (probe.toned?.length)
    found.push(judged('color-only', `${count(probe.toned.length, 'mark')} said by color alone: ${some(probe.toned, (what) => what)}`));
  /* A measure is a desk's question: on a phone the window is the column. */
  const wide = window.width > PHONE ? (probe.measures ?? []).filter((block) => block.chars > MEASURE) : [];
  if (wide.length)
    found.push(
      judged(
        'long-measure',
        `${count(wide.length, 'block')} of prose past ${MEASURE} characters a line: ${some(wide, (block) => `${block.what} ${block.chars}`)}`,
      ),
    );
  /* Under reduced motion nothing moves; otherwise a move is quick, and a spinner loops only while it waits. */
  const moves = (probe.motion ?? []).filter((move) => move.reduced || (!move.loops && move.ms > MOTION));
  if (moves.length) {
    const reduced = moves.filter((move) => move.reduced);
    found.push(
      judged(
        'unsafe-motion',
        `${count(moves.length, 'part')} ${reduced.length ? 'moving under reduced motion' : `moving past ${MOTION}ms`}: ${some(reduced.length ? reduced : moves, (move) => `${move.what} ${move.ms}ms${move.loops ? ', looping' : ''}`)}`,
      ),
    );
  }
  const paper = (probe.print ?? []).filter((reading) => reading.ratio < reading.need);
  if (paper.length)
    found.push(
      judged(
        'print-contrast',
        `${count(paper.length, 'reading')} below the rule on paper: ${some(paper, (reading) => `${reading.what} ${reading.ratio}:1 (needs ${reading.need}:1)`)}`,
      ),
    );
  if (probe.themeBytes !== undefined && probe.themeBytes > THEME_BYTES)
    found.push(
      judged(
        'heavy-theme',
        `the theme's own files are ${Math.round(probe.themeBytes / 1024)} KB on a cold visit (the line is ${THEME_BYTES / 1024} KB)`,
      ),
    );
  if (probe.changed)
    found.push(judged('changed-app', `a control or part is no longer reachable in the accessibility tree: ${probe.changed}`));
  if (probe.shift > SHIFT)
    found.push(judged('layout-shift', `the page shifts ${probe.shift} after its first paint (the line is ${SHIFT})`));
  if (probe.empty.length)
    found.push(
      judged(
        'empty-section',
        `${count(probe.empty.length, 'section')} with nothing in ${probe.empty.length === 1 ? 'it' : 'them'}: ${some(probe.empty, (what) => what)}`,
      ),
    );
  for (const group of probe.figures) {
    const why = mixedFormats(group.values, { column: group.column ?? true });
    if (why) found.push(judged('mixed-format', `${group.where} says its figures two ways: ${why}`));
  }
  for (const axis of probe.axes) {
    const why = roundTicks(axis.ticks);
    if (why) found.push(judged('round-ticks', `${axis.where}: ${why}`));
  }
  if (probe.title && probe.title.lines > 2 && window.width === 390 && !window.dark)
    found.push(judged('header-wrap', `the record's name "${probe.title.text}" takes ${probe.title.lines} lines`));
  return found;
}

/**
 * A contrast finding in a theme graded by name, split by who answers for it: the readings whose colour is one of the
 * theme's tokens are the theme's, said by the token's path, the colour drawn and the ground it was drawn on, and
 * their fix is the theme's colour, not the App's tokens; the rest stay the App's, as judged.
 */
function blameContrast(finding: Judged, low: readonly ContrastReading[], theme: GradedTheme, dark: boolean): Judged[] {
  const tokens = dark ? theme.tokens.dark : theme.tokens.light;
  const components = dark ? theme.components?.dark : theme.components?.light;
  const say = (paths: readonly string[] | undefined, hex: string | undefined) => (paths ? `${paths.join(' / ')} (${hex})` : hex);
  const theirs = new Map<string, number>();
  const rest: ContrastReading[] = [];
  let token: Judged['token'];
  for (const reading of low) {
    const fg = reading.fg ? tokens.get(reading.fg) : undefined,
      bg = reading.bg ? tokens.get(reading.bg) : undefined;
    /* A part's ink mixed from a token is no token's hex: it is named by the token it is mixed from and the part. */
    const mixed = !fg && !bg ? nearest(components, reading.fg, reading.bg) : undefined;
    if (mixed) {
      const line = `${say(mixed, reading.fg)} on ${reading.bg} ${reading.ratio}:1`;
      theirs.set(line, (theirs.get(line) ?? 0) + 1);
      continue;
    }
    if (!fg && !bg) {
      rest.push(reading);
      continue;
    }
    /* The color to change is the one drawn where the theme says it; a ground only where the ink is not the theme's. */
    token ??= fg
      ? { path: fg[0]!, value: reading.fg!, ground: reading.bg ?? '#ffffff', need: reading.need }
      : { path: bg![0]!, value: reading.bg!, ground: reading.fg ?? '#000000', need: reading.need };
    const line = `${say(fg, reading.fg)} on ${say(bg, reading.bg)} ${reading.ratio}:1`;
    theirs.set(line, (theirs.get(line) ?? 0) + 1);
  }
  if (!theirs.size) return [finding];
  const blamed = [...theirs].map(([line, times]) => (times > 1 ? `${line} (${times} times)` : line));
  const own = low.length - rest.length;
  return [
    {
      ...finding,
      cause: 'theme',
      ...(token ? { token } : {}),
      message: `${count(own, 'reading')} below the rule in ${theme.label}'s colors: ${some(blamed, (line) => line)}`,
      fix: `the theme's colors, not the App's: change the token named in ${theme.label}; mistri check names a value that passes on the ground it is drawn on (check --fix writes it)`,
    },
    ...(rest.length
      ? [
          {
            ...finding,
            message: `${count(rest.length, 'reading')} below the rule: ${some(rest, (reading) => `${reading.what} ${reading.ratio}:1 (needs ${reading.need}:1)`)}`,
          },
        ]
      : []),
  ];
}

/** A finding as a run reports it: one per code and page, with every window it was seen in. */
export interface GradeFinding extends Judged {
  /** The address, as the browser shows it. */
  page: string;
  /** The windows it was seen in: 1280, 390, 320, 390-dark. */
  windows: string[];
  file?: string;
  line?: number;
}

/** One line per finding, `code file:line page@windows message — fix: …`, as `check --brief` says a problem. */
export function sayFinding(finding: GradeFinding): string {
  const place = finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ''}` : '';
  return `${finding.code}${finding.severity === 'warning' ? ' (warning)' : ''}${place} ${finding.page}@${finding.windows.join(',')} ${finding.message} — fix: ${finding.fix}`;
}

/** The share of checks that passed, out of 100: each window of each page is checked once for each code. */
export function scoreOf(findings: readonly GradeFinding[], captures: number): number {
  const total = captures * Object.keys(GRADE_CODES).length;
  /* A check is failed once per window, however many findings say so: a theme's share and the App's are one check. */
  const failed = new Set(findings.flatMap((finding) => finding.windows.map((window) => `${finding.code}\n${finding.page}\n${window}`)))
    .size;
  return total ? Math.max(0, Math.round((100 * (total - failed)) / total)) : 100;
}

/** Findings from every capture, one per code and page: the first message, and every window it was seen in. */
export function merge(seen: ReadonlyArray<{ page: string; window: string; found: readonly Judged[] }>): GradeFinding[] {
  const merged = new Map<string, GradeFinding>();
  for (const { page, window, found } of seen) {
    for (const finding of found) {
      const key = `${finding.code}\n${page}\n${finding.cause ?? ''}`;
      const had = merged.get(key);
      if (had) {
        if (!had.windows.includes(window)) had.windows.push(window);
      } else merged.set(key, { ...finding, page, windows: [window] });
    }
  }
  const order = Object.keys(GRADE_CODES);
  return [...merged.values()].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      order.indexOf(a.code) - order.indexOf(b.code) ||
      a.page.localeCompare(b.page),
  );
}

/* Roles a reader operates: where one goes missing under a theme, the App has lost something to do. */
const CONTROL_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'treeitem',
]);
/* The landmarks that name where a screen reader can jump, kept even without a name. */
const LANDMARKS = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search']);
/* A keyboard-shortcut hint on the end of a name ("Search ⌘K", "Open Ctrl+K"): decoration, not part of what the control is. */
const HINT = /\s*(?:[⌘⌃⌥⇧]\s*[\w/?]+|(?:ctrl|cmd|alt|shift|meta)\s*\+\s*[\w/?]+)\s*$/i;

type TreePart = { count: number; role: string; name: string; disclosure: boolean };

/**
 * One line of an accessibility snapshot read as a part: its role, its name as said (hint and all), and the rest. The
 * snapshot is YAML, so a name with a colon in it ("More filters: Priority, Owner") comes single-quoted, and was read as
 * no part at all.
 */
const treeLine = (line: string) => {
  const item = /^\s*- (.*)$/.exec(line)?.[1];
  if (item === undefined) return undefined;
  const quoted = /^'((?:[^']|'')*)'(.*)$/.exec(item);
  const body = quoted ? `${quoted[1]!.replace(/''/g, "'")}${quoted[2]}` : item;
  const read = /^([\w-]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(body);
  return read ? { role: read[1]!, said: (read[2] ?? '').replace(/\\(.)/g, '$1'), rest: read[3] ?? '' } : undefined;
};

/** A control that folds others away: "More filters", an overflow "…", or one that says it opens or expands. */
const folds = (role: string, name: string, rest: string): boolean =>
  CONTROL_ROLES.has(role) && (/^(?:more\b|…|\.{3}|⋯|overflow)/i.test(name) || /\[(?:expanded|haspopup)/.test(rest));

/** The named parts of an accessibility snapshot as a multiset of `role "name"`: text nodes (chart ticks, hints) are not parts. */
function treeParts(tree: string): Map<string, TreePart> {
  const parts = new Map<string, TreePart>();
  for (const line of tree.split('\n')) {
    const read = treeLine(line);
    if (!read) continue;
    const { role } = read;
    const name = read.said.replace(HINT, '').trim();
    if (!name && !LANDMARKS.has(role)) continue;
    if (role === 'text' || role === 'paragraph' || role === 'generic') continue;
    const key = name ? `${role} "${name}"` : role;
    const seen = parts.get(key);
    if (seen) seen.count++;
    else parts.set(key, { count: 1, role, name, disclosure: folds(role, name, read.rest) });
  }
  return parts;
}

/**
 * The folded disclosures of a snapshot, by role and the name a locator finds them by: grade opens each one a theme's
 * capture shows, still collapsed, and reads what it holds (C13). Bounded, since a page of row menus would open forever.
 */
export function foldedDisclosures(tree: string, most = 4): Array<{ role: string; name: string }> {
  const found: Array<{ role: string; name: string }> = [];
  for (const line of tree.split('\n')) {
    const read = treeLine(line);
    // Buttons only: a fold that is a link would leave the page it folds.
    if (read?.role !== 'button' || !read.said || /\[expanded(?:=true)?\]/.test(read.rest)) continue;
    if (folds(read.role, read.said.replace(HINT, '').trim(), read.rest) && !found.some((seen) => seen.name === read.said))
      found.push({ role: read.role, name: read.said });
    if (found.length === most) break;
  }
  return found;
}

/** A tab folded into "More" is a menu item that says its count after its name ("Documents 12"): the same tab. */
const countedAs = (held: string, name: string): boolean => held.startsWith(`${name} `) && /^[\d\s,.()+km]*$/.test(held.slice(name.length));

/**
 * Whether a control the theme's page lacks is in what its disclosures hold: there by the same part, or by the part it
 * names. The bar's "Filter by Priority" is the sheet's "Priority" group: a control's name ends in what it controls.
 */
function reachable(missing: TreePart, revealed: ReadonlyMap<string, TreePart>): boolean {
  const name = missing.name.toLowerCase();
  for (const part of revealed.values()) {
    const held = part.name.toLowerCase();
    if (held && (held === name || name.endsWith(` ${held}`) || countedAs(held, name))) return true;
  }
  return false;
}

/**
 * What a theme changed in the App's accessibility tree (C13), as `- before` or `+ after` on the first part that parted;
 * undefined where every part is still there. The tree is read as the controls a reader can reach, not word for word:
 * a control the theme's type or face folded into a disclosure ("More filters") is reachable when grade opened that
 * disclosure and found it there (`revealed`, one snapshot per disclosure opened), and a shortcut hint or a chart's
 * tick labels are decoration. A control that is gone, folded or not, and not found behind a fold, or a part the theme
 * added, is still a change. A new disclosure once excused every control missing beside it, unopened (field report T5).
 */
export function treeDifference(plain: string, themed: string, revealed: readonly string[] = []): string | undefined {
  const before = treeParts(plain),
    after = treeParts(themed);
  const gained = [...after].filter(([key, part]) => part.count > (before.get(key)?.count ?? 0));
  const folded = gained.some(([, part]) => part.disclosure);
  const held = treeParts(revealed.join('\n'));
  for (const [key, part] of before)
    if (part.count > (after.get(key)?.count ?? 0) && !(folded && CONTROL_ROLES.has(part.role) && reachable(part, held))) return `- ${key}`;
  for (const [key, part] of gained) if (!part.disclosure) return `+ ${key}`;
  return undefined;
}
