/**
 * `mistri grade`'s judgement, without a browser: a figure read as a reader
 * reads it, two formats in one surface, an axis in round steps, each
 * measurement turned into its finding, and the findings of every window
 * merged, scored and said as `check --brief` says a problem. The probe that
 * measures is held to fixture pages in e2e/grade.spec.ts.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRADE_CODES,
  blameLayout,
  judge,
  merge,
  mixedFormats,
  readFigure,
  roundTicks,
  sayFinding,
  scoreOf,
  type GradedTheme,
  type Judged,
} from '../packages/mistri/src/server/build/gradeJudge.js';
import { foldedDisclosures, treeDifference } from '../packages/mistri/src/server/build/gradeJudge.js';
import { matrixLines, matrixTable, type MatrixRow } from '../packages/mistri/src/server/build/gradeMatrix.js';
import { promiseOf } from '../packages/mistri/src/server/build/themeContract.js';
import { codeRows } from '../packages/mistri/src/server/build/checkCodes.js';
import type { Probe } from '../packages/mistri/src/server/build/gradeProbe.js';
import { widestRole } from '../packages/mistri/src/server/build/shot.js';
import { asRoleRefusal, shotsFor } from '../packages/mistri/src/server/build/shotRoles.js';

const clean: Probe = { sideways: 0, clipped: [], overlaps: [], small: [], empty: [], figures: [], axes: [], shift: 0 };
const desk = { width: 1280, dark: false };
const phone = { width: 390, dark: false };
const codes = (probe: Partial<Probe>, window = desk) =>
  judge({ ...clean, ...probe }, [], { errors: [], failed: [] }, window).map((found) => found.code);

describe('a figure, as a reader reads it', () => {
  test('money, groups, decimals, percent and compact suffixes', () => {
    assert.deepEqual(readFigure('$1,234.50'), { value: 1234.5, currency: '$', grouped: true, digits: 4, decimals: 2, percent: false });
    assert.equal(readFigure('-12%')?.value, -12);
    assert.equal(readFigure('12%')?.percent, true);
    assert.equal(readFigure('$2k')?.value, 2000);
    assert.equal(readFigure('4M')?.compact, 'M');
  });
  test('words, dates and a comma that groups nothing are not figures', () => {
    for (const text of ['Open', '2026-10-10', '10/10/2026', '14:03', '1,2', 'Q3', '']) assert.equal(readFigure(text), undefined, text);
  });
});

describe('one surface, one format', () => {
  test('one way of saying figures is clean', () => {
    assert.equal(mixedFormats(['$1,234.00', '$0.00', '$12.50']), undefined);
    assert.equal(mixedFormats(['1,204', '980', '12']), undefined);
    assert.equal(mixedFormats(['12%', '4.5%']), undefined);
  });
  test('money with and without cents: the field report\'s "$24" beside "$0.00"', () => {
    assert.match(mixedFormats(['$24', '$0.00', '$29'])!, /with and without cents/);
  });
  test('thousands grouped beside thousands not', () => {
    assert.match(mixedFormats(['1,204', '3400'])!, /grouped and not/);
  });
  test('compact beside full', () => {
    assert.match(mixedFormats(['$2k', '$4,079'])!, /compact and full/);
  });
  test("a section's quantity beside its price is two measures, not money said two ways", () => {
    /* A record's related parts drawn as cards on a phone: one section, "1" the quantity and "$45.45" the price. */
    assert.equal(mixedFormats(['$45.45', '1', '$12.00', '2'], { column: false }), undefined);
    assert.equal(mixedFormats(['$1,204.00', '2024'], { column: false }), undefined);
    assert.match(mixedFormats(['$45.45', '1', '$12.00', '2'])!, /without its currency/);
    assert.match(mixedFormats(['$24', '$0.00'], { column: false })!, /with and without cents/);
  });
});

describe('an axis in round steps', () => {
  test('round steps are clean, words are not judged', () => {
    for (const ticks of [
      ['$0', '$2k', '$4k'],
      ['0', '25', '50', '75', '100'],
      ['0', '0.5', '1'],
      ['$0', '$2,000', '$4,000'],
      ['Jan', 'Feb'],
    ])
      assert.equal(roundTicks(ticks), undefined, ticks.join(' / '));
  });
  test("the field report's $0 / $2,039.50 / $4,079 is not round", () => {
    assert.match(roundTicks(['$0', '$2,039.50', '$4,079'])!, /not round steps/);
    assert.match(roundTicks(['0', '3', '6'])!, /not round steps/);
    assert.match(roundTicks(['1', '3', '5'])!, /not round steps/);
  });
});

describe('each measurement is its finding', () => {
  test('a clean page judges clean, at a desk and on a phone', () => {
    assert.deepEqual(codes({}), []);
    assert.deepEqual(codes({}, phone), []);
  });
  test('sideways scroll, a cut figure, cut words, overlapping controls, a shift and an empty section', () => {
    assert.deepEqual(codes({ sideways: 120 }), ['sideways-scroll']);
    assert.deepEqual(codes({ clipped: [{ what: 'td "$12,3…"', text: '$12,345.00', numeric: true, ellipsis: true }] }), ['clipped-number']);
    assert.deepEqual(
      codes({ clipped: [{ what: 'span.tone "Ready for pic"', text: 'Ready for pickup', numeric: false, ellipsis: false }] }),
      ['clipped-text'],
    );
    // A long name ellipsized to its column is the platform keeping it there, said, not cut.
    assert.deepEqual(codes({ clipped: [{ what: 'td "Electra Lo…"', text: 'Electra Loft 7D', numeric: false, ellipsis: true }] }), []);
    assert.deepEqual(codes({ overlaps: [{ a: 'button "Save"', b: 'a "Back"' }] }), ['overlap']);
    assert.deepEqual(codes({ shift: 0.25 }), ['layout-shift']);
    assert.deepEqual(codes({ shift: 0.05 }), []);
    assert.deepEqual(codes({ empty: ['"Visits"'] }), ['empty-section']);
  });
  test('two vertical scroll containers in one room are a finding; one is the room itself', () => {
    assert.deepEqual(codes({ scrolls: ['div.content'] }), []);
    assert.deepEqual(codes({ scrolls: ['div.content', 'div.related'] }), ['double-scroll']);
    assert.deepEqual(codes({ scrolls: [] }), []);
  });
  test('a small target is a finding on a phone only', () => {
    const small = [{ what: 'button "⋯"', width: 28, height: 28 }];
    assert.deepEqual(codes({ small }, desk), []);
    assert.deepEqual(codes({ small }, phone), ['small-target']);
  });
  test('a figure format, an axis and a wrapped name', () => {
    assert.deepEqual(codes({ figures: [{ where: 'the "Total" column', values: ['$24', '$0.00'] }] }), ['mixed-format']);
    assert.deepEqual(codes({ axes: [{ where: 'chart 1 y axis', ticks: ['$0', '$2,039.50', '$4,079'] }] }), ['round-ticks']);
    const title = { text: 'Electra Loft 7D for Rafael Rossi, rear brake rub', lines: 3 };
    assert.deepEqual(codes({ title }, phone), ['header-wrap']);
    assert.deepEqual(codes({ title }, desk), [], 'only a phone 390 wide is held to two lines');
    assert.deepEqual(codes({ title: { ...title, lines: 2 } }, phone), []);
  });
  test('contrast below its rule, a page error and a failed request', () => {
    const found = judge(
      clean,
      [
        { what: 'span "Due"', ratio: 2.9, need: 4.5 },
        { what: 'edge of input', ratio: 3.2, need: 3 },
      ],
      { errors: ['the page threw: x is not defined'], failed: ['GET /api/rows answered 500'] },
      desk,
    );
    assert.deepEqual(
      found.map((finding) => finding.code),
      ['page-error', 'failed-request', 'low-contrast'],
    );
    assert.match(found[2]!.message, /span "Due" 2\.9:1 \(needs 4\.5:1\)/);
    assert.ok(found.every((finding) => finding.severity === 'error'));
  });
});

describe('a run: merged, scored and said', () => {
  const seen = [
    {
      page: '/tasks',
      window: '390',
      found: judge({ ...clean, small: [{ what: 'button', width: 30, height: 30 }] }, [], { errors: [], failed: [] }, phone),
    },
    {
      page: '/tasks',
      window: '320',
      found: judge(
        { ...clean, small: [{ what: 'button', width: 30, height: 30 }] },
        [],
        { errors: [], failed: [] },
        { width: 320, dark: false },
      ),
    },
    { page: '/tasks/1', window: '1280', found: judge({ ...clean, sideways: 40 }, [], { errors: [], failed: [] }, desk) },
  ];
  test('one finding per code and page, with every window it was seen in, errors first', () => {
    const findings = merge(seen);
    assert.deepEqual(
      findings.map((finding) => [finding.code, finding.page, finding.windows]),
      [
        ['sideways-scroll', '/tasks/1', ['1280']],
        ['small-target', '/tasks', ['390', '320']],
      ],
    );
  });
  test('the score is the share of checks passed; a clean run is 100', () => {
    assert.equal(scoreOf([], 8), 100);
    const total = 8 * Object.keys(GRADE_CODES).length;
    assert.equal(scoreOf(merge(seen), 8), Math.round((100 * (total - 3)) / total));
  });
  test('said as check --brief says a problem: code, place, page@windows, message — fix', () => {
    const [sideways, small] = merge(seen);
    assert.match(
      sayFinding({ ...sideways!, file: 'app.ts', line: 48 }),
      /^sideways-scroll app\.ts:48 \/tasks\/1@1280 the page scrolls 40px sideways — fix: .+/,
    );
    assert.match(sayFinding(small!), /^small-target \(warning\) \/tasks@390,320 1 control under 44px: button 30×30 — fix: /);
  });
  test('every code grade says is documented, so mistri explain says it', () => {
    const documented = new Set(codeRows().map((row) => row.code));
    for (const code of Object.keys(GRADE_CODES)) assert.ok(documented.has(code), `${code} has no row in the docs`);
  });
});

/* TC15: grade --theme gates the theme and blames it. A theme whose captions read 3.1:1 graded as the App's tokens
   ("the look's tokens, not a color of your own"), and its type scale's overlaps as the App's layout. */
describe('a theme graded by name answers for what it causes', () => {
  const faint: GradedTheme = {
    label: 'Faint',
    tokens: {
      light: new Map([
        ['#aaa49c', ['faint.colors.light.inkMuted', 'faint.colors.light.inkSubtle']],
        ['#ffffff', ['faint.colors.light.surface']],
      ]),
      dark: new Map(),
    },
  };
  const low = [
    { what: 'caption "Due"', ratio: 2.4, need: 4.5, fg: '#aaa49c', bg: '#ffffff' },
    { what: 'caption "Owner"', ratio: 2.4, need: 4.5, fg: '#aaa49c', bg: '#ffffff' },
    { what: 'chip "issues 4"', ratio: 4.41, need: 4.5, fg: '#b45309', bg: '#fdf3e7' },
  ];
  test("a reading in the theme's colors is the theme's, by token path, color and ground; the rest stay the App's", () => {
    const found = judge(clean, low, { errors: [], failed: [] }, desk, faint).filter((finding) => finding.code === 'low-contrast');
    assert.equal(found.length, 2);
    const [theirs, ours] = found;
    assert.equal(theirs!.cause, 'theme');
    assert.match(
      theirs!.message,
      /^2 readings below the rule in Faint's colors: faint\.colors\.light\.inkMuted \/ faint\.colors\.light\.inkSubtle \(#aaa49c\) on faint\.colors\.light\.surface \(#ffffff\) 2\.4:1 \(2 times\)/,
    );
    assert.match(theirs!.fix, /^the theme's colors, not the App's/);
    assert.equal(ours!.cause, undefined);
    assert.match(ours!.message, /^1 reading below the rule: chip "issues 4" 4\.41:1/);
  });
  /* T-2: a board card's category chip read 4.28:1 under a custom theme and grade named only app.ts; its ink is no
     token's hex but a mix of a series into the ink, so it is named by the series and the part. */
  test("a part's ink mixed from a token is named by the token and the part, within the browser's rounding", () => {
    const chip: GradedTheme = {
      ...faint,
      components: {
        light: new Map([['#7c7883 #fefbfd', ["care.colors.light.chart[4] as a board card's category chip"]]]),
        dark: new Map(),
      },
    };
    const reading = { what: 'span.triage-card-category "Urgent"', ratio: 4.19, need: 4.5, fg: '#7d7883', bg: '#fefbfd' };
    const [found] = judge(clean, [reading], { errors: [], failed: [] }, desk, chip).filter((finding) => finding.code === 'low-contrast');
    assert.equal(found!.cause, 'theme');
    assert.match(found!.message, /care\.colors\.light\.chart\[4\] as a board card's category chip \(#7d7883\) on #fefbfd 4\.19:1/);
  });
  test("without a theme graded by name, every reading is the App's, as before", () => {
    const found = judge(clean, low, { errors: [], failed: [] }, desk).filter((finding) => finding.code === 'low-contrast');
    assert.deepEqual(
      found.map((finding) => finding.cause),
      [undefined],
    );
  });
  test("a layout finding the App's own look does not have is the theme's type scale or density", () => {
    const [overlap] = judge({ ...clean, overlaps: [{ a: 'button "Save"', b: 'a "Back"' }] }, [], { errors: [], failed: [] }, phone);
    const blamed = blameLayout(overlap!, { label: 'Faint', worn: 'Lumen' });
    assert.equal(blamed.cause, 'theme');
    assert.equal(blamed.severity, 'error');
    assert.match(blamed.message, /; not so in Lumen, so Faint's type scale or density causes it$/);
    assert.match(blamed.fix, /type\.base, type\.roles title size or density in Faint/);
  });
  test("the theme's share and the App's are kept apart in a run, and failed once in the score", () => {
    const found = judge(clean, low, { errors: [], failed: [] }, desk, faint);
    const findings = merge([{ page: '/tasks', window: '1280', found }]);
    assert.deepEqual(
      findings.map((finding) => [finding.code, finding.cause]),
      [
        ['low-contrast', 'theme'],
        ['low-contrast', undefined],
      ],
    );
    const total = 1 * Object.keys(GRADE_CODES).length;
    assert.equal(scoreOf(findings, 1), Math.round((100 * (total - 1)) / total));
  });
});

/* An App with sign-in, graded with no --as, measured its sign-in card on every page: a run signs in as the role
   whose screens hold the most. */
describe('the role grade signs in as without --as', () => {
  const resources = { work_order: {}, part: {}, mechanic: {}, service: {} };
  test('the role that reads the most, the first declared on a tie; read: true is every resource', () => {
    const roles = {
      mechanic: { read: ['work_order', 'part'], write: [] },
      manager: { read: true, write: true },
      clerk: { read: ['work_order', 'part', 'mechanic', 'service'], write: [] },
    };
    assert.equal(widestRole({ resources, auth: { roles } } as never), 'manager');
    assert.equal(
      widestRole({ resources, auth: { roles: { a: { read: ['part'], write: [] }, b: { read: ['work_order'], write: [] } } } } as never),
      'a',
    );
  });
  test('no roles: the bootstrapped administrator', () => {
    assert.equal(widestRole({ resources, auth: {} } as never), 'admin');
  });
  /* A service role is one a job or a policy acts as; nobody signs in as it, so shot never offers or picks it (AG6). */
  test('a service role is never chosen, offered or signed in as', () => {
    const roles = {
      rent_poster: { read: true, write: [], service: true },
      clerk: { read: ['work_order'], write: [] },
      manager: { read: ['work_order', 'part'], write: [] },
    };
    assert.equal(widestRole({ resources, auth: { roles } } as never), 'manager');
    assert.match(
      asRoleRefusal('Lintel', roles as never, 'rent_poster') ?? '',
      /^--as "rent_poster" is a service role of "Lintel", which a job or a policy acts as and no person signs in as: admin, clerk, manager\.$/,
    );
    assert.equal(asRoleRefusal('Lintel', roles as never, 'nobody'), '--as "nobody" is not a role of "Lintel": admin, clerk, manager.');
    assert.equal(asRoleRefusal('Lintel', roles as never, 'clerk'), undefined);
    assert.equal(asRoleRefusal('Lintel', roles as never, 'admin'), undefined);
    // A tenant App has no admin of its own.
    assert.equal(
      asRoleRefusal('Lintel', roles as never, 'admin', false),
      '--as "admin" is not a role of "Lintel": clerk, manager. A tenant App has no admin of its own.',
    );
  });
});

/* The theme contract (themeContract.ts): every finding of a contract code says the promise it holds, and the
   promises only a drawn page shows are measured — a control's edge apart from text, the focus ring, a mark said by
   color alone, a measure too wide, motion, paper, a theme's own files and the tree a screen reader hears. */
describe('each finding says the promise it holds', () => {
  test("a field's edge is C2 faint-edge, apart from text, which stays C1 low-contrast", () => {
    const found = judge(
      clean,
      [
        { what: 'span "Due"', ratio: 2.9, need: 4.5 },
        { what: 'edge of input', ratio: 2.1, need: 3 },
      ],
      { errors: [], failed: [] },
      desk,
    );
    assert.deepEqual(
      found.map((finding) => [finding.code, finding.promise]),
      [
        ['low-contrast', 'C1'],
        ['faint-edge', 'C2'],
      ],
    );
    assert.match(found[1]!.message, /^1 control edge below 3:1: edge of input 2\.1:1$/);
  });
  test('a code outside the contract says no promise; every contract code grade says is one of its promises', () => {
    const [error] = judge(clean, [], { errors: ['the page threw'], failed: [] }, desk);
    assert.equal(error!.promise, undefined);
    for (const code of Object.keys(GRADE_CODES)) {
      const promise = promiseOf(code);
      if (promise) assert.match(promise, /^C(?:[1-9]|1[0-3])$/, code);
    }
    for (const code of [
      'faint-edge',
      'hidden-focus',
      'color-only',
      'long-measure',
      'unsafe-motion',
      'heavy-theme',
      'print-contrast',
      'changed-app',
    ])
      assert.ok(code in GRADE_CODES, code);
  });
  test('a focus ring under 2px or 3:1 with nothing else changed is C3 hidden-focus; a ring that holds, or a stop that changes otherwise, is clean', () => {
    const focus = [
      { what: 'button "Save"', width: 2, ratio: 4.1, changed: false },
      { what: 'a "Leads"', width: 0, changed: false },
      { what: 'input#search', width: 1, ratio: 5, changed: false },
      { what: 'button "⋯"', width: 2, ratio: 1.6, changed: false },
      { what: 'tab "Open"', width: 0, changed: true },
    ];
    const [hidden] = judge({ ...clean, focus }, [], { errors: [], failed: [] }, desk);
    assert.equal(hidden!.code, 'hidden-focus');
    assert.equal(hidden!.promise, 'C3');
    assert.match(
      hidden!.message,
      /^3 of 5 focus stops show no ring of 2px at 3:1: a "Leads" no ring, input#search 1px, button "⋯" 1\.6:1$/,
    );
  });
  test('a mark said by color alone is C6, prose past 80 characters a line C8 (a desk only), motion C9', () => {
    assert.deepEqual(codes({ toned: ['span.dot in td'] }), ['color-only']);
    const measures = [
      { what: 'p "Lorem…"', chars: 104 },
      { what: 'p "Short"', chars: 62 },
    ];
    assert.deepEqual(codes({ measures }), ['long-measure']);
    assert.deepEqual(codes({ measures }, phone), []);
    assert.deepEqual(codes({ motion: [{ what: 'div.toast', ms: 160, loops: false, reduced: false }] }), []);
    assert.deepEqual(codes({ motion: [{ what: 'div.toast', ms: 320, loops: false, reduced: false }] }), ['unsafe-motion']);
    assert.deepEqual(
      codes({ motion: [{ what: 'span.spinner', ms: 800, loops: true, reduced: false }] }),
      [],
      'a spinner loops while it waits',
    );
    const [moved] = judge(
      { ...clean, motion: [{ what: 'span.spinner', ms: 120, loops: true, reduced: true }] },
      [],
      { errors: [], failed: [] },
      desk,
    );
    assert.equal(moved!.code, 'unsafe-motion');
    assert.match(moved!.message, /under reduced motion: span\.spinner 120ms, looping/);
  });
  test("print below 4.5:1 is C12, a theme's files past the budget C11, a changed accessibility tree C13", () => {
    assert.deepEqual(codes({ print: [{ what: 'a "Open"', ratio: 2.8, need: 4.5 }] }), ['print-contrast']);
    assert.deepEqual(codes({ themeBytes: 120 * 1024 }), []);
    const [heavy] = judge({ ...clean, themeBytes: 310 * 1024 }, [], { errors: [], failed: [] }, desk);
    assert.equal(heavy!.code, 'heavy-theme');
    assert.match(heavy!.message, /^the theme's own files are 310 KB on a cold visit \(the line is 200 KB\)$/);
    const [changed] = judge({ ...clean, changed: '- button "Save"' }, [], { errors: [], failed: [] }, desk);
    assert.deepEqual([changed!.code, changed!.promise, changed!.severity], ['changed-app', 'C13', 'error']);
  });
  test('C13 compares the controls a reader can reach: a filter folded into "More filters" and found there, and a dropped shortcut hint, pass; a control that is gone, and a part added, fail', () => {
    const plain = [
      '- main:',
      '  - heading "Work orders" [level=1]',
      '  - button "Search ⌘K"',
      '  - combobox "Status"',
      '  - combobox "Priority"',
      '  - img "Revenue":',
      '    - text: $0',
      '    - text: $2k',
      '    - text: $4k',
    ].join('\n');
    // type.base 16px: Priority folds into a disclosure, the hint drops, the axis thins to two ticks.
    const folded = [
      '- main:',
      '  - heading "Work orders" [level=1]',
      '  - button "Search"',
      '  - combobox "Status"',
      '  - button "More filters" [expanded=false]',
      '  - img "Revenue":',
      '    - text: $0',
      '    - text: $4k',
    ].join('\n');
    const quoted = folded.replace('  - button "More filters" [expanded=false]', `  - 'button "More filters: Priority"': Filter`);
    // Grade opened "More filters": the sheet holds Priority as a group, which is the control the bar named.
    const sheet = ['- dialog "Filters":', '  - group "Priority":', '    - checkbox "High"'].join('\n');
    assert.equal(treeDifference(plain, folded, [sheet]), undefined);
    assert.equal(treeDifference(plain.replace('combobox "Priority"', 'button "Filter by Priority"'), folded, [sheet]), undefined);
    assert.equal(treeDifference(plain, quoted, [sheet]), undefined);
    // A fold that was not opened, or that holds something else, does not excuse what is missing beside it.
    assert.equal(treeDifference(plain, folded), '- combobox "Priority"');
    assert.equal(treeDifference(plain, folded, ['- dialog "Filters":\n  - group "Assignee"']), '- combobox "Priority"');
    // The same theme hiding Priority outright, with no disclosure to hold it, is a control gone.
    const hidden = folded.replace('  - button "More filters" [expanded=false]\n', '');
    assert.equal(treeDifference(plain, hidden), '- combobox "Priority"');
    // A disclosure that was already there does not stand in for a control that vanished.
    const alreadyMore = '  - button "More filters"\n';
    assert.equal(
      treeDifference(
        plain.replace('  - combobox "Status"\n', `  - combobox "Status"\n${alreadyMore}`),
        hidden.replace('  - combobox "Status"\n', `  - combobox "Status"\n${alreadyMore}`),
        [sheet],
      ),
      '- combobox "Priority"',
    );
    // A tab folded into "More" is reachable: the menu item carries the tab's count after its name.
    const tabs = (more: string) => ['- tablist:', '  - tab "Overview"', '  - tab "Documents"', more].join('\n');
    const menu = ['- menu "More":', '  - menuitem "Documents 12"'].join('\n');
    assert.equal(
      treeDifference(tabs(''), tabs('').replace('  - tab "Documents"\n', '') + '\n  - button "More" [expanded=false]', [menu]),
      undefined,
    );
    assert.equal(
      treeDifference(tabs(''), tabs('').replace('  - tab "Documents"\n', '') + '\n  - button "More" [expanded=false]', [
        '- menu "More":\n  - menuitem "Documentsheet"',
      ]),
      '- tab "Documents"',
    );
    // A heading the theme removes, and a part it adds, are changes of the App.
    assert.equal(treeDifference(plain, folded.replace('  - heading "Work orders" [level=1]\n', ''), [sheet]), '- heading "Work orders"');
    assert.equal(treeDifference(plain, `${plain}\n  - link "Promo"`), '+ link "Promo"');
    assert.equal(treeDifference(plain, plain), undefined);
  });
  test('the folds grade opens are the collapsed disclosure buttons, never a link and never one already open', () => {
    const tree = [
      // As Playwright writes it: a name with a colon comes single-quoted, YAML, and says no state.
      `- 'button "More filters: Priority, Assignee"': Filter`,
      '- button "Account" [haspopup=menu]',
      '- button "Menu" [expanded]',
      '- link "More news"',
      '- button "Save"',
    ].join('\n');
    assert.deepEqual(
      foldedDisclosures(tree).map((fold) => fold.name),
      ['More filters: Priority, Assignee', 'Account'],
    );
  });
  test("a theme's own contrast reading names its token, its color and its ground, for the matrix's passing value", () => {
    const theme: GradedTheme = {
      label: 'Cadence',
      tokens: { light: new Map([['#c9c1d6', ['cadence.colors.light.lineControl']]]), dark: new Map() },
    };
    const [edge] = judge(
      clean,
      [{ what: 'edge of select', ratio: 1.6, need: 3, fg: '#c9c1d6', bg: '#ffffff' }],
      { errors: [], failed: [] },
      desk,
      theme,
    );
    assert.equal(edge!.code, 'faint-edge');
    assert.equal(edge!.cause, 'theme');
    assert.deepEqual(edge!.token, { path: 'cadence.colors.light.lineControl', value: '#c9c1d6', ground: '#ffffff', need: 3 });
  });
});

describe('the grade matrix: every theme, palette and role', () => {
  const finding = (code: keyof typeof GRADE_CODES, page: string, windows: string[], more: Partial<Judged> = {}) => ({
    ...judge(clean, [], { errors: [], failed: [] }, desk)[0],
    code,
    severity: GRADE_CODES[code].severity,
    message: `${code} on ${page}`,
    fix: GRADE_CODES[code].fix,
    ...(promiseOf(code) ? { promise: promiseOf(code)! } : {}),
    page,
    windows,
    ...more,
  });
  const rows: MatrixRow[] = [
    { theme: 'lumen', palette: 'default', role: 'manager', windows: ['1280', '390', '320', '390-dark'], findings: [] },
    {
      theme: 'cadence',
      palette: 'default',
      role: 'manager',
      windows: ['1280', '390', '320', '390-dark'],
      findings: [
        finding('faint-edge', '/parts', ['390', '1280'], {
          cause: 'theme',
          token: { path: 'cadence.colors.light.lineControl', value: '#c9c1d6', ground: '#ffffff', need: 3 },
        }),
        finding('overlap', '/parts', ['320']),
        finding('small-target', '/leads', ['320']),
      ],
    },
    { theme: 'cadence', palette: 'dusk', role: 'manager', windows: ['390', '390-dark'], findings: [] },
  ];
  test('a row per theme, palette and role, a column per window: ✓ or the count, and a palette row only where it was graded', () => {
    assert.deepEqual(matrixTable(rows), [
      '                          1280  768  390  320  390-dark',
      'lumen/default/manager        ✓    ·    ✓    ✓         ✓',
      'cadence/default/manager      1    ·    1    2         ✓',
      'cadence/dusk/manager         ·    ·    ✓    ·         ✓',
    ]);
  });
  test("each failing cell's first finding: promise, code, row, window, page, and the token with a value that passes", () => {
    assert.deepEqual(
      matrixLines(rows, (token) => (token.path.endsWith('lineControl') ? '#8a7fa0' : undefined)),
      [
        'C2 faint-edge cadence/default/manager 1280 /parts — colors.light.lineControl #c9c1d6 → #8a7fa0',
        'C2 faint-edge cadence/default/manager 390 /parts — colors.light.lineControl #c9c1d6 → #8a7fa0',
        'C5 overlap cadence/default/manager 320 /parts — overlap on /parts',
      ],
    );
  });
});

describe('grade --as all: what each role reads', () => {
  const app = {
    resources: { work_order: { physical: 'work_orders' }, part: {} },
    views: { orders: { table: 'work_orders' }, parts: { table: 'part' }, board: { table: 'part', roles: ['manager'] } },
    auth: { roles: { mechanic: { read: ['work_order'] }, manager: { read: true as const } } },
  };
  const shots = [{ view: 'orders' }, { view: 'parts' }, { view: 'board' }, { table: 'part' }, { page: 'today' }];
  test('a role reads the views and records of its resources, and every page; signed out, the address a visitor lands on', () => {
    assert.deepEqual(shotsFor(app, 'mechanic', shots), [{ view: 'orders' }, { page: 'today' }]);
    assert.deepEqual(shotsFor(app, 'manager', shots), shots);
    assert.deepEqual(shotsFor(app, 'signed-out', shots), [{ view: 'orders' }]);
  });
});
