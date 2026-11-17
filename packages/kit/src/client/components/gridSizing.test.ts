import { describe, expect, test } from 'vitest';
import {
  columnFloor,
  columnSizeHint,
  fitGridColumns,
  holdFold,
  keepFitting,
  tagsThatFit,
  isGroupedNumber,
  GRID_EXPANDER_WIDTH,
} from './gridSizing.js';

const catalog = [
  { label: 'Name', kind: 'text', values: ['Managed laptop'] },
  { label: 'Description', kind: 'text', values: ['A long service description '.repeat(20)] },
  { label: 'Price', kind: 'number', values: ['$1,249'] },
  { label: 'Fulfillment', kind: 'text', values: ['3 days'] },
];

describe('fit table allocation', () => {
  test.each([620, 960, 1240])('fits %ipx panels without giving prose half the table', (width) => {
    const result = fitGridColumns(catalog, width);
    expect(result.width).toBe(width);
    expect(result.columns.reduce((a, b) => a + b, 0)).toBe(width);
    expect(result.columns[1]).toBeLessThan(width / 2);
    result.columns.forEach((size, index) => expect(size).toBeGreaterThanOrEqual(columnSizeHint(catalog[index]).minimum));
  });

  test('keeps genuine wide data scrollable at readable minima', () => {
    const result = fitGridColumns(catalog, 280, true);
    expect(result.width).toBeGreaterThan(280);
    expect(result.columns.reduce((a, b) => a + b, GRID_EXPANDER_WIDTH)).toBe(result.width);
  });

  test('allocates formatted numeric and timestamp room, including header controls', () => {
    expect(columnSizeHint({ label: 'Total', kind: 'number', values: ['9,223,372,036,854,775,807'] }).minimum).toBeGreaterThan(200);
    expect(columnSizeHint({ label: 'Date', kind: 'date', showTime: true, values: [] }).minimum).toBe(176);
    // A head's menu caret stands over its label's end under a pointer (style.css): the head keeps its sort's room only.
    expect(columnSizeHint({ label: 'Assigned to', kind: 'text', controls: true, values: [] }).minimum).toBe(11 * 7 + 34);
  });

  test('a bar or ring beside the words is room the words do not measure', () => {
    // Compass's probability column held 88px and cut "100%" to "10…" beside its 52px bar.
    const measure = (text: string) => text.length * 7;
    const pct = { label: 'Probability', kind: 'number', dressed: true, values: ['100%', '40%'] };
    const bare = columnSizeHint(pct, undefined, measure);
    const withBar = columnSizeHint({ ...pct, beside: 60 }, undefined, measure);
    expect(withBar.least).toBeGreaterThan(bare.least);
    expect(withBar.least).toBeGreaterThanOrEqual(measure('100%') + 60);
    // Counted, with no canvas: the bar still counts.
    const counted = { label: 'Probability', kind: 'number', values: ['100%'] };
    expect(columnSizeHint({ ...counted, beside: 60 }).minimum).toBeGreaterThan(columnSizeHint(counted).minimum);
  });

  test('the totals row sizes its column: a sum is wider than any row it adds up and is never cut', () => {
    const rent = { label: 'Rent', kind: 'number', dressed: true, values: ['$2,450', '$1,980', '$3,100'] };
    // Seven pixels a character, as the cells' font measures here; the total is set a tenth wider, in its heavier weight.
    const measure = (text: string) => text.length * 7;
    const rows = columnSizeHint(rent, undefined, measure);
    const withTotal = columnSizeHint({ ...rent, total: '$102,795.00' }, undefined, measure);
    expect(withTotal.minimum).toBeGreaterThan(rows.minimum);
    expect(withTotal.minimum).toBeGreaterThanOrEqual(Math.ceil(measure('$102,795.00') * 1.1) + 24);
    // Counted, where there is no canvas to measure with: its characters are room too.
    const counted = { label: 'Rent', kind: 'number', values: ['2,450'] };
    expect(columnSizeHint({ ...counted, total: '102,795,000.00' }).minimum).toBeGreaterThan(columnSizeHint(counted).minimum);
    // A column with no total, or one that is shorter than its rows, is as it was.
    expect(columnSizeHint({ ...rent, total: '$9' }, undefined, measure).minimum).toBe(rows.minimum);
  });

  test('a clipped title fills before short columns grow', () => {
    const issues = [
      { label: 'Name', kind: 'text', values: ['Preserve filters when opening an issue from a list'] },
      { label: 'Status', kind: 'text', values: ['In progress'] },
      { label: 'Project', kind: 'text', values: ['Workspace foundations'] },
      { label: 'Cycle', kind: 'text', values: ['Cycle 18'] },
    ];
    const result = fitGridColumns(issues, 900);
    expect(result.columns[0]).toBeGreaterThanOrEqual(360);
    expect(result.columns[3]).toBeLessThan(result.columns[0] / 2);
    expect(result.columns.reduce((a, b) => a + b, 0)).toBe(900);
  });

  test('a second line asks for room without lowering the floor', () => {
    const plain = columnSizeHint({ label: 'Name', kind: 'text', values: ['Margot Fontaine'] });
    const stacked = columnSizeHint({
      label: 'Name',
      kind: 'text',
      values: ['Margot Fontaine'],
      subValues: ['margot.fontaine@example.org'],
    });
    expect(stacked.minimum).toBe(plain.minimum);
    expect(stacked.wanted).toBeGreaterThan(plain.wanted);
  });

  test('a look whose heads are capitals sizes a head for its wider characters', () => {
    const cycle = { label: 'Cycle name', kind: 'text', controls: true, values: ['C 18'] };
    expect(columnSizeHint(cycle).minimum).toBe(10 * 7 + 34);
    // Ink's capitals set about 8.8px a character, and sized at 7 its last head clipped.
    expect(columnSizeHint(cycle, 9).minimum).toBeGreaterThanOrEqual(10 * 8.8 + 34);
    const narrow = fitGridColumns([cycle], 0).columns[0]!;
    expect(fitGridColumns([cycle], 0, false, false, 9).columns[0]).toBeGreaterThan(narrow);
  });

  test('a chip column is sized for the chip, not its bare words', () => {
    const words = columnSizeHint({ label: 'Status', kind: 'text', values: ['In progress'] });
    const chip = columnSizeHint({ label: 'Status', kind: 'text', values: ['In progress'], chip: true });
    expect(chip.minimum - words.minimum).toBeGreaterThanOrEqual(28);
  });

  test('samples no more than forty rows', () => {
    const values = Array(40).fill('short');
    Object.defineProperty(values, 40, {
      get() {
        throw new Error('unbounded sample');
      },
    });
    expect(columnSizeHint({ label: 'Name', kind: 'text', values }).minimum).toBe(80);
  });

  test('measured text sizes short columns to their words, so a title gets the room', () => {
    // A 14px sans sets about 6.6px a character; counted at 8 the short columns held the slack.
    const measure = (text: string) => text.length * 6.6;
    const issues = [
      { label: 'Name', kind: 'text', values: ['Preserve filters when opening an issue from a list'] },
      { label: 'Status', kind: 'text', chip: true, values: ['In progress'] },
      { label: 'Assignee', kind: 'text', values: ['Theo Laurent'] },
      { label: 'Project', kind: 'text', values: ['Workspace foundations'] },
      { label: 'Cycle', kind: 'text', values: ['Cycle 18'] },
    ];
    const counted = fitGridColumns(issues, 940);
    const measured = fitGridColumns(issues, 940, false, false, undefined, measure);
    expect(measured.columns[0]).toBeGreaterThan(counted.columns[0]!);
    expect(columnSizeHint(issues[3]!, undefined, measure).wanted).toBeLessThan(columnSizeHint(issues[3]!).wanted);
    // A chip still counts its dot and padding.
    expect(columnSizeHint(issues[1]!, undefined, measure).minimum).toBeGreaterThanOrEqual(Math.ceil(11 * 6.6) + 22 + 24);
    expect(measured.columns.reduce((a, b) => a + b, 0)).toBe(940);
  });

  test("the row's name keeps its room before the other text columns keep theirs", () => {
    const measure = (text: string) => text.length * 6.6;
    const issues = [
      { label: 'Name', kind: 'text', title: true, values: ['Preserve filters when opening an issue from a list'] },
      { label: 'Status', kind: 'text', chip: true, values: ['In progress'] },
      { label: 'Assignee', kind: 'text', avatar: true, values: ['Theo Laurent'] },
      { label: 'Project', kind: 'text', values: ['Workspace foundations'] },
      { label: 'Cycle', kind: 'text', values: ['Cycle 18'] },
    ];
    const hints = issues.map((column) => columnSizeHint(column, undefined, measure));
    // The name holds 240px as its floor; a secondary text column at most 120px, asking for the rest.
    expect(hints[0]!.minimum).toBe(240);
    expect(hints[3]!.minimum).toBe(120);
    expect(hints[3]!.wanted).toBeGreaterThan(120);
    // A chip is never cut, and an avatar's disc is width.
    expect(hints[1]!.minimum).toBeGreaterThanOrEqual(Math.ceil(11 * 6.6) + 22 + 24);
    expect(hints[2]!.wanted).toBe(columnSizeHint({ ...issues[2]!, avatar: false }, undefined, measure).wanted + 32);
    // A tight table cuts Project before the name: the name keeps 240px.
    const tight = fitGridColumns(issues, 720, false, false, undefined, measure);
    expect(tight.columns[0]).toBeGreaterThanOrEqual(240);
    expect(tight.columns[3]).toBeLessThan(Math.ceil(21 * 6.6) + 24);
    // Where even the minima do not fit, the name keeps its floor and the table scrolls: it is never cut for a scroll.
    const narrow = fitGridColumns(issues, 560, false, false, undefined, measure);
    expect(narrow.columns[0]).toBe(240);
    expect(narrow.width).toBeGreaterThan(560);
  });

  test("a number measured as drawn gives its slack to the row's name before the table scrolls", () => {
    // Forecourt's stock: the car's name was cut to "2024 Toyota C…" while price and miles held 56px of air each.
    const measure = (text: string) => text.length * 7.4;
    const stock = [
      { label: 'Stock number', kind: 'text', values: ['FC-1001'] },
      { label: 'Car', kind: 'text', title: true, values: ['2024 Volkswagen Jetta SE', '2024 Toyota Camry LE'] },
      { label: 'Status', kind: 'text', chip: true, status: true, values: ['For sale'] },
      { label: 'Price', kind: 'number', dressed: true, controls: true, values: ['$22,495'] },
      { label: 'Was', kind: 'number', dressed: true, controls: true, values: [null] },
      { label: 'Miles', kind: 'number', dressed: true, controls: true, values: ['118,340 mi'] },
      { label: 'On the lot', kind: 'number', dressed: true, controls: true, values: ['35 days'] },
      { label: 'Featured', kind: 'boolean', controls: true, values: [true] },
      { label: 'Badge', kind: 'text', controls: true, values: ['One owner'] },
      { label: 'Dealer', kind: 'text', controls: true, values: ['Kingsway Auto Center'] },
    ];
    const fit = fitGridColumns(stock, 1176, false, false, undefined, measure);
    expect(fit.width).toBe(1176);
    expect(fit.columns[1]).toBeGreaterThanOrEqual(Math.ceil('2024 Volkswagen Jetta SE'.length * 7.4) + 24);
    // The heads wider than their figures give way, and then the dealer, so the table need not scroll; on a phone,
    // where it scrolls anyway, nothing is cut.
    const tight = fitGridColumns(stock, 1100, false, false, undefined, measure);
    expect(tight.width).toBe(1100);
    const tighter = fitGridColumns(stock, 1000, false, false, undefined, measure);
    expect(tighter.width).toBe(1000);
    expect(tighter.columns[9]).toBeLessThan(columnSizeHint(stock[9]!, undefined, measure).minimum);
    expect(tighter.columns[1]).toBe(columnSizeHint(stock[1]!, undefined, measure).minimum);
    const phone = fitGridColumns(stock, 358, false, false, undefined, measure);
    phone.columns.forEach((size, index) => expect(size).toBe(columnSizeHint(stock[index]!, undefined, measure).minimum));
    // A drawn figure is as wide as itself, or its head; a figure counted from its raw value keeps its spare.
    expect(columnSizeHint(stock[3]!, undefined, measure).minimum).toBe(76);
    expect(columnSizeHint({ ...stock[3]!, dressed: false }, undefined, measure).minimum).toBe(112);
  });

  test('an embedded grid leaves out the columns past its width, from the end, never its name', () => {
    const columns = [
      { label: 'Received by', kind: 'text', values: ['—'] },
      { label: 'Status', kind: 'text', chip: true, values: ['Cancelled'] },
      { label: 'Supplier', kind: 'text', title: true, values: ['Supplier 6'] },
      { label: 'Ordered on', kind: 'date', values: ['2026-09-22'] },
      { label: 'Received on', kind: 'date', values: ['2026-09-22'] },
    ];
    expect(keepFitting(columns, 2000)).toBeNull();
    // Not measured yet: nothing is left out on a guess.
    expect(keepFitting(columns, 0)).toBeNull();
    const kept = keepFitting(columns, 460)!;
    expect(kept[0]).toBe(true);
    expect(kept[2]).toBe(true);
    expect(kept.at(-1)).toBe(false);
    // In order: once one does not fit, none after it is kept.
    const first = kept.findIndex((keep, index) => !keep && !columns[index]!.title);
    expect(kept.slice(first).every((keep, index) => !keep || columns[first + index]!.title)).toBe(true);
  });

  test('a related list beside an aside keeps its name and its status, and leaves out what sits between', () => {
    const visits = [
      { label: 'When', kind: 'date', values: ['2026-06-06'], showTime: true },
      { label: 'Kind', kind: 'text', values: ['Annual physical'] },
      { label: 'Provider', kind: 'text', values: ['Dr. Helena Park'], title: true },
      { label: 'Reason', kind: 'text', values: ['Blood pressure check and a long note'] },
      { label: 'Status', kind: 'text', values: ['Completed'], chip: true, status: true },
    ];
    const kept = keepFitting(visits, 545)!;
    expect(kept).not.toBeNull();
    expect(kept[0]).toBe(true);
    expect(kept[2]).toBe(true);
    expect(kept[4]).toBe(true);
    expect(kept.filter(Boolean).length).toBeLessThan(visits.length);
    // What is kept fits: the status is never drawn cut at the edge.
    const drawn = visits.filter((_, index) => kept[index]);
    const fit = fitGridColumns(drawn, 545);
    expect(fit.width).toBeLessThanOrEqual(545);
  });

  test("a relative date and a number's chip are as wide as their words, so the name and the owner keep theirs", () => {
    const measure = (text: string) => text.length * 7;
    const tasks = [
      { label: 'Task', kind: 'text', title: true, values: ['Schedule the demo environment with their security team'] },
      { label: 'Due', kind: 'date', dressed: true, values: ['4 weeks ago'] },
      { label: 'Owner', kind: 'text', avatar: true, values: ['Arjun Hansen'] },
      { label: 'Priority', kind: 'number', chip: true, values: ['3', '2'] },
    ];
    const was = fitGridColumns(
      tasks.map(({ dressed: _, chip: __, ...column }) => column),
      630,
      false,
      true,
      undefined,
      measure,
    );
    const now = fitGridColumns(tasks, 630, false, true, undefined, measure);
    expect(now.columns[1]).toBeLessThan(was.columns[1]!);
    expect(now.columns[3]).toBeLessThan(was.columns[3]!);
    // The room the date and the chip gave back is the owner's: its disc and its name whole.
    expect(now.columns[2]).toBeGreaterThanOrEqual(32 + 'Arjun Hansen'.length * 7 + 24);
    // A date the cell formats itself is not measured from its raw value, which is not what is drawn.
    expect(columnSizeHint({ label: 'Due', kind: 'date', values: ['2026-08-23'] }, undefined, measure).minimum).toBe(112);
    expect(columnSizeHint({ label: 'Total', kind: 'number', values: ['3'] }, undefined, measure).minimum).toBe(88);
  });

  test('a date drawn in a face wider than the sans is as wide as it measures, never cut to "Aug 22, 20…"', () => {
    // The data face: ten pixels a character, so "Aug 22, 2026" is 120 and the usual 112 cut it.
    const mono = (text: string) => text.length * 10;
    const created = { label: 'Created', kind: 'date', drawnDate: true, values: ['Sep 2, 2026', 'Aug 22, 2026'] };
    expect(columnSizeHint(created, undefined, mono).minimum).toBe(120 + 24);
    // A narrow face gives the room back, down to a floor sixteen under the usual width; and without a measure the
    // usual width is all there is.
    expect(columnSizeHint(created, undefined, (text) => text.length * 7).minimum).toBe(12 * 7 + 24);
    expect(columnSizeHint(created, undefined, (text) => text.length * 5).minimum).toBe(96);
    expect(columnSizeHint(created).minimum).toBe(112);
    expect(columnSizeHint({ ...created, showTime: true, values: ['Aug 22, 2026, 3:45 PM'] }, undefined, mono).minimum).toBe(234);
  });

  test('columns are folded before the secondary text is cut to its head, so an owner is never left a letter', () => {
    const measure = (text: string) => text.length * 7;
    const leads = [
      { label: 'Name', kind: 'text', title: true, values: ['Margot Fontaine'], subValues: ['margot.fontaine@example.org'] },
      { label: 'Company', kind: 'text', values: ['Stonebridge Marine Inc'] },
      { label: 'Status', kind: 'text', chip: true, status: true, values: ['New'] },
      { label: 'Source', kind: 'text', values: ['Referral'] },
      { label: 'Owner', kind: 'text', avatar: true, values: ['Tariq Andersen'] },
      { label: 'Created', kind: 'date', drawnDate: true, values: ['Aug 22, 2026'] },
    ];
    // 612px: the table fits only by cutting Company and Owner to their heads, which cut an owner to "T…".
    const kept = keepFitting(leads, 612, false, true, undefined, measure);
    expect(kept).not.toBeNull();
    expect(kept![5]).toBe(false);
    expect(kept![0]).toBe(true);
    // Room for all of them whole folds nothing.
    expect(keepFitting(leads, 1400, false, true, undefined, measure)).toBeNull();
  });

  test('a yes-or-no said in words is as wide as its chip; one drawn as a mark keeps the mark width (G187)', () => {
    const measure = (text: string) => text.length * 7;
    // An SLA's computed yes-or-no, its display's words in tone chips: "On track" and the chip's dot and padding.
    const sla = columnSizeHint({ label: 'SLA', kind: 'boolean', chip: true, values: ['On track', 'Breached'] }, undefined, measure);
    expect(sla.minimum).toBe('On track'.length * 7 + 40 + 24);
    expect(columnSizeHint({ label: 'SLA', kind: 'boolean', dressed: true, values: ['Late'] }, undefined, measure).minimum).toBe(
      'Late'.length * 7 + 24,
    );
    expect(columnSizeHint({ label: 'Done', kind: 'boolean', values: [true, false] }, undefined, measure).minimum).toBe(64);
  });

  test('a tags cell draws whole chips and counts the rest, never a cut chip', () => {
    // Thread's issues: "accessibility" and "performance" in 134px read "accessibility perfo".
    const more = (rest: number) => `+${rest}`.length * 7;
    expect(tagsThatFit([96, 98], 2, 4, 134, more)).toBe(1);
    expect(tagsThatFit([96, 98], 2, 4, 210, more)).toBe(2);
    // Three of five fit beside their "+2"; the fourth and fifth are only counted.
    expect(tagsThatFit([40, 40, 40], 5, 4, 150, more)).toBe(3);
    expect(tagsThatFit([40, 40, 40], 5, 4, 120, more)).toBe(2);
    // The first is kept even where it alone is too wide: the column is sized to hold it.
    expect(tagsThatFit([200], 3, 4, 120, more)).toBe(1);
  });

  test("the row's name fills before the others, after the ones a few pixels short", () => {
    const measure = (text: string) => text.length * 7;
    const issues = [
      { label: 'Name', kind: 'text', title: true, values: ['Preserve filters when opening an issue from a list'] },
      { label: 'Owner', kind: 'text', values: ['Theo Laurent Smith'] },
      { label: 'Project', kind: 'text', values: ['Workspace foundations and the long tail of polish'] },
    ];
    const hints = issues.map((column) => columnSizeHint(column, undefined, measure));
    const room = hints.reduce((sum, hint) => sum + hint.minimum, 0) + 140;
    const fit = fitGridColumns(issues, room, false, false, undefined, measure);
    // The owner is short by under 40px and made whole; the name takes the rest before the project grows.
    expect(fit.columns[1]).toBe(hints[1]!.wanted);
    expect(fit.columns[0]).toBe(hints[0]!.minimum + 140 - (hints[1]!.wanted - hints[1]!.minimum));
    expect(fit.columns[2]).toBe(hints[2]!.minimum);
  });

  test("a column of its own gives the name way before the table scrolls, and a table of the page's width never does", () => {
    const receipts = [
      { label: 'Reference', kind: 'text', title: true, values: ['RCPT-2026-0001'] },
      { label: 'Status', kind: 'text', chip: true, status: true, values: ['Cleared', 'Pending'] },
    ];
    const needs = receipts.map((column) => columnSizeHint(column).minimum).reduce((a, b) => a + b, 0);
    // The room is a little short of the name and the status together, as an aside at its narrowest is.
    expect(fitGridColumns(receipts, needs - 16).width).toBe(needs);
    const squeezed = fitGridColumns(receipts, needs - 16, false, false, undefined, undefined, true);
    expect(squeezed.width).toBe(needs - 16);
    expect(squeezed.columns[1]).toBe(columnSizeHint(receipts[1]!).minimum);
  });
});

describe('a row is one line, and so is a head', () => {
  test('a head never breaks onto a second line: with room it is whole, and short of it the head wider than its values is cut first', () => {
    const columns = [
      { label: 'Listed online', kind: 'boolean', values: [true] },
      { label: 'Available from', kind: 'date', values: ['2026-09-12'] },
      { label: 'Monthly asking rent', kind: 'text', values: ['x'] },
    ];
    const hints = columns.map((column) => columnSizeHint(column));
    const whole = hints.map((hint) => hint.minimum);
    const roomy = fitGridColumns(columns, whole.reduce((a, b) => a + b, 0) + 50);
    roomy.columns.forEach((size, index) => expect(size).toBeGreaterThanOrEqual(whole[index]!));
    /* Each head here is wider than what stands under it, so each may give: the last first, and no further than its
       values' own width (a tick's 64px, a date's 112). */
    hints.forEach((hint) => expect(hint.head).toBeGreaterThan(0));
    const tight = fitGridColumns(columns, whole.reduce((a, b) => a + b, 0) - 60);
    expect(tight.width).toBe(whole.reduce((a, b) => a + b, 0) - 60);
    expect(tight.columns.slice(0, 2)).toEqual(whole.slice(0, 2));
    expect(tight.columns[2]).toBe(whole[2]! - 60);
    expect(hints[0]!.least).toBe(64);
    expect(hints[1]!.least).toBe(112);
  });

  test('short of its room, the secondary text is cut from the last column first; the name and the figures keep their width', () => {
    const measure = (text: string) => text.length * 7;
    const columns = [
      { label: 'Unit', kind: 'text', values: ['A-101', 'B-204'], title: true },
      { label: 'Tenant', kind: 'text', values: ['Northwind Trading', 'Harbor Pine Dental'] },
      { label: 'Agent', kind: 'text', values: ['Margot Fontaine'] },
      { label: 'Rent', kind: 'number', dressed: true, values: ['$12,450.00'] },
    ];
    const hints = columns.map((column) => columnSizeHint(column, undefined, measure));
    // No head here is wider than its values, so none has anything to give.
    hints.forEach((hint) => expect(hint.head).toBe(0));
    const floors = hints.reduce((sum, hint) => sum + hint.minimum, 0);
    const tight = fitGridColumns(columns, floors - 20, false, false, undefined, (text) => measure(text));
    expect(tight.width).toBe(floors - 20);
    expect(tight.columns[0]).toBe(hints[0]!.minimum);
    expect(tight.columns[1]).toBe(hints[1]!.minimum);
    expect(tight.columns[2]).toBe(hints[2]!.minimum - 20);
    expect(tight.columns[3]).toBe(hints[3]!.minimum);
  });

  test("an App's own list cuts its secondary text to its floor before it folds a column; an embedded grid leaves one out first", () => {
    const measure = (text: string) => text.length * 7;
    const leads = [
      { label: 'Name', kind: 'text', title: true, values: ['Margot Fontaine'] },
      { label: 'Company', kind: 'text', values: ['Stonebridge Marine Inc'] },
      { label: 'Owner', kind: 'text', avatar: true, values: ['Tariq Andersen'] },
      { label: 'Created', kind: 'date', drawnDate: true, values: ['Aug 22, 2026'] },
    ];
    const hints = leads.map((column) => columnSizeHint(column, undefined, measure));
    const floors = hints.reduce((sum, hint) => sum + hint.minimum, 0);
    const least = hints.reduce((sum, hint) => sum + hint.least, 0);
    expect(least).toBeLessThan(floors);
    expect(keepFitting(leads, floors - 10, false, false, undefined, measure)).not.toBeNull();
    expect(keepFitting(leads, floors - 10, false, false, undefined, measure, true)).toBeNull();
    /* Past the floors there is nothing left to give: the list folds, from the end. */
    const folded = keepFitting(leads, least - 10, false, false, undefined, measure, true);
    expect(folded).not.toBeNull();
    expect(folded![0]).toBe(true);
    /* A name beside an initials disc keeps the disc and a word of the name: its floor is its own, not a bare text's. */
    expect(hints[2]!.least).toBe(hints[2]!.minimum);
    expect(hints[1]!.least).toBe(96);
  });
});

describe('holdFold', () => {
  const of = ['name\u0000status\u0000owner', []];
  const folded = [true, true, false];
  test('a scrollbar given back does not unfold what its taller rows folded', () => {
    // Folded at 985 (the scrollbar there), the room back at 1000 would draw every column again: held.
    const first = holdFold(null, folded, 985, of);
    expect(first.kept).toBe(folded);
    const back = holdFold(first.held, null, 1000, of);
    expect(back.kept).toBe(folded);
    // And so it stays, measure after measure.
    expect(holdFold(back.held, null, 985, of).kept).toBe(folded);
  });
  test('a real widening unfolds, a narrowing folds at once, other rows are sized afresh', () => {
    const { held } = holdFold(null, folded, 985, of);
    expect(holdFold(held, null, 1100, of).kept).toBeNull();
    const narrower = [true, false, false];
    expect(holdFold(held, narrower, 990, of).kept).toBe(narrower);
    expect(holdFold(held, null, 1000, [of[0], []]).kept).toBeNull();
  });
});

describe('a column of numbers set in groups', () => {
  const chars = (text: string) => text.length * 7;
  test('a telephone number is a number: its column is as wide as the widest, so it is neither cut nor broken at a space', () => {
    expect(isGroupedNumber(['(720) 555-4381', '+1 720 555 2387'])).toBe(true);
    expect(isGroupedNumber(['Cedar Row #4'])).toBe(false);
    expect(isGroupedNumber([])).toBe(false);
    const hint = columnSizeHint({ label: 'Phone', kind: 'text', values: ['(720) 555-4381', '(720) 555-2387'] }, 7, chars);
    expect(hint.minimum).toBe(14 * 7 + 24);
    expect(hint.least).toBe(hint.minimum);
  });
});

describe('heads that give their room to a value', () => {
  /* A rent roll in a monospace look at a 1280 desk, as it measured: the minima run three pixels past the room, and
     two names are each fifteen short of whole. */
  const widths = [46.8, 117, 46.8, 85.8, 46.8, 39, 62.4, 117, 93.6, 7.8];
  const roll = [
    { label: 'Code', kind: 'text', headWidth: 28.16, title: true },
    { label: 'Building', kind: 'text', headWidth: 56.32 },
    { label: 'Beds', kind: 'number', headWidth: 28.16, dressed: true },
    { label: 'Size', kind: 'number', headWidth: 28.16, dressed: true },
    { label: 'Asking rent', kind: 'number', headWidth: 77.44, dressed: true },
    { label: 'Per ft²', kind: 'number', headWidth: 49.28, dressed: true },
    { label: 'Status', kind: 'text', headWidth: 42.24, chip: true, chipExtra: 14, dressed: true },
    { label: 'Resident', kind: 'text', headWidth: 56.32 },
    { label: 'Available', kind: 'date', headWidth: 63.36, drawnDate: true },
    { label: 'Listed', kind: 'boolean', headWidth: 42.24, pad: 24 },
  ].map((column) => ({ pad: 17, controls: true, values: ['x'], ...column }));
  const measure = (_text: string, column: number) => widths[column]!;

  test('what a head gave or lent is the value’s: it is not handed back to the head as the column least short', () => {
    const { width, columns } = fitGridColumns(roll, 978, true, false, 8, measure);
    expect(width).toBe(978);
    // Both names whole: their widest value and the cell's padding.
    expect(columns[1]).toBe(117 + 17);
    expect(columns[7]).toBe(117 + 17);
    // The heads over a short figure and a tick paid for it, the last first, none below its floor.
    expect(columns[4]).toBeLessThan(columnSizeHint(roll[4]!, 8, (text) => measure(text, 4)).minimum);
    expect(columns[9]).toBeGreaterThanOrEqual(columnSizeHint(roll[9]!, 8, (text) => measure(text, 9)).least);
    expect(columns.reduce((sum, size) => sum + size, GRID_EXPANDER_WIDTH)).toBe(978);
  });
});

describe('columnFloor', () => {
  const base = { label: 'Created', values: ['Aug 22, 2026'] };
  test('holds a date, a figure and a chip to the width of their values, and lets text give way', () => {
    expect(columnFloor({ ...base, kind: 'date' })).toBeGreaterThanOrEqual(112);
    expect(columnFloor({ ...base, label: 'Price', kind: 'number', values: ['$22,495'] })).toBeGreaterThanOrEqual(88);
    expect(columnFloor({ ...base, label: 'Status', kind: 'text', chip: true, values: ['In review'] })).toBeGreaterThan(60);
    expect(columnFloor({ ...base, label: 'Notes', kind: 'text', values: ['A long sentence of free text that may be cut'] })).toBe(0);
  });
});
