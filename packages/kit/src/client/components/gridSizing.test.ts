import { describe, expect, test } from 'vitest';
import { columnSizeHint, fitGridColumns, keepFitting, tagsThatFit, twoLineWidth, GRID_EXPANDER_WIDTH } from './gridSizing.js';

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
    // The dealer gives way to its head so the table need not scroll; on a phone, where it scrolls anyway, nothing is cut.
    const tight = fitGridColumns(stock, 1100, false, false, undefined, measure);
    expect(tight.width).toBe(1100);
    expect(tight.columns[9]).toBeLessThan(columnSizeHint(stock[9]!, undefined, measure).minimum);
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

describe('an App head that may wrap to two lines', () => {
  const chars = (text: string) => text.length * 7;
  test('its two-line width is the widest line at the best word break, and a single word cannot break', () => {
    expect(twoLineWidth('Listed online', chars)).toBe(6 * 7);
    expect(twoLineWidth('Available', chars)).toBe(9 * 7);
    expect(twoLineWidth('Rent per square foot', chars)).toBe(11 * 7);
  });

  test('the floor is the two-line width and the whole label stays what the column wants', () => {
    const whole = columnSizeHint({ label: 'Listed online', kind: 'text', values: [] });
    const wrapped = columnSizeHint({ label: 'Listed online', kind: 'text', values: [], wrapHead: true });
    expect(wrapped.minimum).toBeLessThan(whole.minimum);
    expect(wrapped.wanted).toBe(whole.wanted);
  });

  test('a table whose heads fit whole keeps them whole; one that would run past its room wraps them', () => {
    const columns = [
      { label: 'Listed online', kind: 'boolean', values: [], wrapHead: true },
      { label: 'Available from', kind: 'date', values: [], wrapHead: true },
      { label: 'Monthly asking rent', kind: 'text', values: ['x'], wrapHead: true },
    ];
    const whole = columns.map((column) => columnSizeHint({ ...column, wrapHead: false }).minimum);
    const roomy = fitGridColumns(columns, whole.reduce((a, b) => a + b, 0) + 50);
    roomy.columns.forEach((size, index) => expect(size).toBeGreaterThanOrEqual(whole[index]!));
    const tight = fitGridColumns(columns, whole.reduce((a, b) => a + b, 0) - 60);
    expect(tight.width).toBe(whole.reduce((a, b) => a + b, 0) - 60);
  });

  test('a word column given less than its widest value wraps it whole on two lines, rather than cutting it', () => {
    const tenant = ['Northwind Trading', 'Harbor Pine Dental', 'Ostrander Bakery'];
    const columns = [
      { label: 'Unit', kind: 'text', values: ['A-101', 'B-204'], title: true, wrapHead: true },
      { label: 'Tenant', kind: 'text', values: tenant, wrapHead: true, wrapValues: true },
      { label: 'Monthly rent', kind: 'number', values: ['$12,450.00'], wrapHead: true },
    ];
    const hint = columnSizeHint(columns[1]!);
    expect(hint.twoLines).toBeLessThan(hint.whole!);
    const plain = columns.map((column) => columnSizeHint({ ...column, wrapValues: false }));
    const needs = plain.reduce((sum, column) => sum + column.wanted, 0);
    expect(fitGridColumns(columns, needs + 40).wraps).toEqual([false, false, false]);
    /* Short of the tenant's whole width and past its two-line width: it wraps. */
    const tight = fitGridColumns(columns, plain[0]!.minimum + plain[2]!.minimum + hint.twoLines! + 24);
    expect(tight.wraps).toEqual([false, true, false]);
    expect(tight.columns[1]).toBeGreaterThanOrEqual(hint.twoLines!);
    /* Short of that too, the value is cut as before: a column is never wrapped to three lines. */
    expect(fitGridColumns(columns, plain[0]!.minimum + plain[2]!.minimum + 84).wraps).toEqual([false, false, false]);
    /* The row's name may take two lines too, but never in a room too small even for those. */
    expect(fitGridColumns([{ ...columns[0]!, wrapValues: true }], 10).wraps).toEqual([false]);
  });

  test("the row's name takes its second line before a short secondary value is given one", () => {
    const name = 'Review date boundaries across time zones';
    const columns = [
      { label: 'Name', kind: 'text', title: true, wrapValues: true, values: [name] },
      { label: 'Assignee', kind: 'text', wrapValues: true, avatar: true, values: ['Sam Rivera', 'Maya Chen'] },
      { label: 'Project', kind: 'text', wrapValues: true, values: ['Accessible authoring'] },
    ];
    const hint = columns.map((column) => columnSizeHint(column));
    const named = columnSizeHint({ ...columns[0]!, wrapValues: false });
    const secondary = columns.slice(1).map((column) => columnSizeHint({ ...column, wrapValues: false }));
    /* Room for the others' whole floors and the name on two lines, short of the name's own floor. */
    const room = secondary.reduce((sum, column) => sum + column.minimum, 0) + hint[0]!.twoLines! + 8;
    expect(room).toBeLessThan(named.minimum + secondary.reduce((sum, column) => sum + column.minimum, 0));
    const fit = fitGridColumns(columns, room);
    expect(fit.width).toBe(room);
    expect(fit.wraps[0]).toBe(true);
    expect(fit.columns[0]).toBeGreaterThanOrEqual(hint[0]!.twoLines!);
    /* The others kept their floors, not their two-line ones. */
    expect(fit.columns[1]).toBeGreaterThanOrEqual(secondary[0]!.minimum);
    expect(fit.columns[2]).toBeGreaterThanOrEqual(secondary[1]!.minimum);
  });
});
