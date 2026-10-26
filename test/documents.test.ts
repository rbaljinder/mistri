/*
 * Documents (shared/appDocuments.ts): a record on paper is an App page with a
 * `document`, read by the record page's own routes. Here, what an author may
 * write and what they are told when they may not, the check code each refusal
 * carries, the paper a locale buys, the address a document is said at, and
 * that a document is never a page a record opens through.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentProblems, documentSections, paperSize, parseDocument } from '../packages/engine/src/shared/appDocuments.js';
import { parseAppPages } from '../packages/mistri/src/shared/appPages.js';
import { appAddressBook, readAppSegments } from '../packages/mistri/src/shared/appAddress.js';
import { tabWord } from '../packages/engine/src/shared/addressParams.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import type { PageSection } from '../packages/engine/src/shared/pageModel.js';

const where = 'app.ts: pages "invoice"';

/** A manifest's pages, parsed as an App's are. */
const pagesOf = (pages: Record<string, unknown>) => parseAppPages({ pages }, 'app.ts');
const invoice = (extra: Record<string, unknown> = {}, sections: unknown[] = [{ kind: 'fields', show: ['total'] }]) => ({
  base: 'sales_order',
  sections,
  document: { label: 'Invoice', number: 'invoice_no', ...extra },
});

/** The refusal an App's pages meet, and the check code `mistri check --json` gives it. */
function refusal(pages: Record<string, unknown>): { message: string; code: string } {
  try {
    pagesOf(pages);
  } catch (error) {
    const message = (error as Error).message;
    return { message, code: validationCode(message) };
  }
  assert.fail('the pages were accepted');
}

test("a document is a page with a label, a number field, a size and the sender's lines", () => {
  const [page] = pagesOf({ invoice: invoice({ size: 'letter', description: 'Atelier\n214 Alder Street' }) });
  assert.deepEqual(page.document, { label: 'Invoice', number: 'invoice_no', size: 'letter', description: 'Atelier\n214 Alder Street' });
  assert.equal(page.base, 'sales_order');
  assert.deepEqual(parseDocument({ label: ' Payslip ' }, where), { label: 'Payslip' });
});

test('what a document refuses, each said and each with the document check code', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ invoice: { ...invoice(), document: { number: 'invoice_no' } } }, /has no "label"/],
    [{ invoice: { ...invoice(), document: 'Invoice' } }, /"document" is an object/],
    [{ invoice: invoice({ size: 'a5' }) }, /"size" is "a4" or "letter"/],
    [{ invoice: invoice({ number: 'total amount' }) }, /"number" is a field of the record/],
    [{ invoice: { ...invoice(), path: 'bills' } }, /a document is addressed under its record \(\/<record>\/invoice\), so it has no "path"/],
    [
      { invoice: invoice({}, [{ kind: 'metric', title: 'Owed', from: 'order_line', whose: 'sales_order_id' }]) },
      /draws fields, related lists and notes on paper/,
    ],
    [{ invoice: invoice({}, [{ kind: 'fields', show: ['total'], region: 'aside' }]) }, /a document is one sheet wide/],
    [
      {
        invoice: invoice({}, [
          { kind: 'fields', show: ['total'], tab: 'Money' },
          { kind: 'fields', show: ['note'], tab: 'Notes' },
        ]),
      },
      /paper has no tabs/,
    ],
    [{ invoice: invoice({}, [{ kind: 'card', show: ['customer_id', 'total'] }]) }, /on paper fields are a summary/],
    [
      { invoice: invoice({}, [{ kind: 'list', from: 'order_line', whose: 'sales_order_id', rowActions: true }]) },
      /is a list of the record's lines on paper/,
    ],
  ];
  for (const [pages, said] of cases) {
    const { message, code } = refusal(pages);
    assert.match(message, said);
    assert.equal(code, 'document', message);
  }
  // A key paper does not take is the vocabulary's own refusal, with its own code and the keys it does take.
  const unknown = refusal({ invoice: invoice({ colour: 'red' }) });
  assert.match(unknown.message, /colour/);
  assert.equal(unknown.code, 'unknown-key');
});

test("a document's lines are every line, up to the most a list reads at once, unless it says fewer", () => {
  const lines: PageSection = { kind: 'list', from: 'order_line', path: 'sales_order_id' } as PageSection;
  assert.equal((documentSections([lines], where)[0] as { limit?: number }).limit, 500);
  assert.equal((documentSections([{ ...lines, limit: 20 } as PageSection], where)[0] as { limit?: number }).limit, 20);
});

test("a document's lines may be matched on the record's own values, read by the page's one match parser", () => {
  const [page] = pagesOf({
    slip: invoice({}, [{ kind: 'list', from: 'order_line', same: ['sales_order_id'], totals: ['quantity'], empty: 'hide' }]),
  });
  const list = page.sections[0] as { similar?: unknown; limit?: number; emptyMode?: string };
  assert.deepEqual(list.similar, { same: ['sales_order_id'] });
  assert.equal(list.limit, 500);
  assert.equal(list.emptyMode, 'hide');
  // The same refusals as on a screen, in the same words: a match is not a child list.
  assert.match(
    refusal({ slip: invoice({}, [{ kind: 'list', from: 'order_line', same: ['sales_order_id'], create: 'Add' }]) }).message,
    /has "create" beside "same"/,
  );
});

test('paper is the size the document says, else the one its locale buys', () => {
  assert.equal(paperSize({ size: 'a4' }, 'en-US'), 'a4');
  assert.equal(paperSize({}, 'en-US'), 'letter');
  assert.equal(paperSize({}, 'es-MX'), 'letter');
  assert.equal(paperSize({}, 'en-CA'), 'letter');
  assert.equal(paperSize({}, 'en-GB'), 'a4');
  assert.equal(paperSize({}, 'de'), 'a4');
  assert.equal(paperSize({}, 'en'), 'letter', 'English alone is said in the United States');
  assert.equal(paperSize({}, undefined), 'a4');
  assert.equal(paperSize({}, 'not a locale!'), 'a4');
});

const tables = [
  { id: 'sales_order', name: 'sales_order', columns: [{ name: 'id', primaryKey: true }] },
  {
    id: 'order_line',
    name: 'order_line',
    columns: [
      { name: 'id', primaryKey: true },
      { name: 'sales_order_id', primaryKey: false },
    ],
  },
];
const bookOf = (pages: Array<{ id: string; base: string; document?: unknown }>) =>
  appAddressBook({ views: { orders: { table: 'sales_order' } } as never, order: ['orders'], resources: {}, pages, tables });

test("a document is said where a record's tab is, and is never the page its record opens through", () => {
  const pages = pagesOf({
    invoice: invoice(),
    order: { base: 'sales_order', sections: [{ kind: 'fields', show: ['total'] }] },
  });
  const book = bookOf(pages);
  assert.equal(book.defaultPage.get('sales_order'), 'order', 'the record opens on its page, though the document came first');
  assert.equal(book.pages.has('invoice'), false, 'a document has no route of its own');
  const read = readAppSegments(book, ['orders', '12', 'invoice']);
  assert.deepEqual(read && { kind: read.kind, tab: (read as { tab?: string }).tab, key: (read as { key?: unknown }).key }, {
    kind: 'record',
    tab: 'invoice',
    key: { id: '12' },
  });
});

test("a document whose key is a tab of its record's page, or the page its record is said to open on, is refused", () => {
  const pages = pagesOf({
    invoice: invoice(),
    order: {
      base: 'sales_order',
      sections: [
        { kind: 'fields', show: ['total'] },
        { kind: 'list', title: 'Invoice', from: 'order_line', whose: 'sales_order_id' },
      ],
    },
  });
  const [clash, opens] = documentProblems(pages, { sales_order: 'invoice' }, tabWord, 'app.ts');
  assert.match(clash, /pages "invoice" is a document at \/<record>\/invoice, which the page "order" already answers to as a tab/);
  assert.match(opens, /resources "sales_order", "page" names "invoice", which is a document/);
  assert.equal(validationCode(clash), 'document');
  assert.equal(validationCode(opens), 'document');
});
