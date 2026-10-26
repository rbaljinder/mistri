/**
 * A record on paper: an invoice, a packing slip, a payslip
 * (shared/appDocuments.ts). The sheet is the page the App declared with
 * `document`, planned and composed by the same routes as the record's own
 * page and read through the same requests, so a reader is shown on paper
 * exactly what the record's page would show them — the same grants, the same
 * rows, the same tenant — and nothing is rendered on the server: the
 * browser's print engine is the renderer, and its "Save as PDF" the PDF.
 *
 * It is drawn as the paper will be, at the paper's width, so what the screen
 * shows is the proof. Its dress is the platform's and needs no author: a
 * letterhead (the App's mark, its name, the sender's lines) across from the
 * document's name and number; the record's fields in the presentation each
 * section asks, said for paper — a summary is label over value, `facts` an
 * address, `properties` caption beside value, `table` the totals, `headline`
 * the one figure; and each related list as every line, in a table whose
 * header repeats on each sheet, figures right-aligned in tabular numerals.
 * Ink on white in every look and mode: the sheet is paper, not the room.
 *
 * A part loaded on demand (Content.tsx): no first page carries it.
 */
import { useContext, useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  columnDisplay,
  columnLabel,
  currentEntry,
  findTable,
  labelPath,
  renderCrumbs,
  rowLabel,
  state,
} from '@mistriwork/kit/client/core.js';
import { activeApp } from '../appState.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { paperSize, SHEET_SPAN, type DocumentSize, type PageDocument } from '@mistriwork/engine/shared/appDocuments.js';
import { fieldsColumns, listView, rowBody } from '@mistriwork/engine/shared/recordReads.js';
import type { AppPayloadDocument } from '../../shared/appPayload.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { composeRecordPage } from '@mistriwork/kit/client/recordCompose.js';
import { defaultCurrency, formatDate, formatLocale, formatMoney } from '@mistriwork/kit/client/locale.js';
import { minorFigure, rowCurrency } from '@mistriwork/engine/shared/money.js';
import { dressFor, maskedText, sayValue, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { sumTerms } from './totalTerms.js';
import { planColumn } from '@mistriwork/kit/client/columns.js';
import { brandMark } from '../appBrand.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Value } from '@mistriwork/kit/client/components/Value.js';
import { presentationColumns } from '@mistriwork/kit/client/components/columnPresentation.js';
import { PageRenderContext, recordReadNames, usePageApi } from '@mistriwork/kit/client/components/pageContext.js';
import {
  rootMatches,
  type PageDef,
  type PageEntry,
  type PageSection,
  type SectionPlan,
} from '@mistriwork/kit/client/components/pageModel.js';
import type { RowEntry } from '@mistriwork/kit/client/components/Record.js';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { say } from '../copy/record/components/Document.js';
import './Document.css';

type Row = Record<string, unknown>;
/* The client's one section shape, by the kind each part draws. */
type Fields = PageSection;
type List = PageSection & { labels?: Record<string, string> };
type Note = PageSection;
type Column = ColumnMeta & { references?: { table: string; column: string } };
interface ViewReply {
  columns: string[];
  rows: Row[];
  more?: boolean;
}

const OFFSET_SPAN = { quarter: 3, third: 4, half: 6, 'two-thirds': 8 } as const;
/* The sheet's margins: the screen's proof draws them as padding, and paper is given them by @page. */
/* The sheet as CSS names it in @page. */
const PAGE: Record<DocumentSize, string> = { a4: 'A4', letter: 'letter' };
const MARGIN: Record<DocumentSize, string> = { a4: '16mm 16mm 18mm', letter: '0.6in 0.65in 0.7in' };

/** The document an address asked for, on paper. */
export function DocumentRoom({ entry, document }: { entry: PageEntry | RowEntry; document: AppPayloadDocument }) {
  useMessageLanguage();
  const connection = (state as { activeConnection?: string }).activeConnection ?? '';
  const base = findTable(document.base) as TableMeta | undefined;
  const key = entry.key as Record<string, unknown>;
  const planned = useQuery({
    queryKey: ['document', connection, document.id, key],
    queryFn: () => composeRecordPage(connection, document.id, key),
    staleTime: 0,
  });
  const page = planned.data?.page as (PageDef & { document?: PageDocument; error?: string }) | undefined;
  const size = paperSize({ size: page?.document?.size ?? document.size }, formatLocale());
  const broken = planned.isError
    ? (planned.error as Error).message
    : planned.data && (!page || page.error || !base)
      ? (page?.error ?? say('couldNotBeRead', { document: document.label.toLocaleLowerCase() }))
      : undefined;
  const context = useMemo(() => ({ connection, isCurrent: () => currentEntry() === entry }), [connection, entry]);
  return (
    <div className="panel-pad doc-room">
      <div className="doc-bar">
        <span className="doc-bar-paper">{say('paper', { size: size === 'a4' ? say('a4') : say('letter') })}</span>
        <Button
          intent="primary"
          disabled={!page || Boolean(broken)}
          title={say('printTitle', { document: document.label.toLocaleLowerCase() })}
          onClick={() => window.print()}
        >
          {say('print')}
        </Button>
      </div>
      {/* Paper is given its size and margins here, by the document, since a stylesheet cannot know which sheet it is. */}
      <style>{`@page { size: ${PAGE[size]}; margin: ${MARGIN[size]}; }`}</style>
      <article
        className={`doc-sheet doc-sheet--${size}`}
        style={{ '--doc-margin': MARGIN[size] } as CSSProperties}
        aria-busy={!page && !broken}
      >
        {broken ? (
          <p className="doc-broken">{broken}</p>
        ) : page && base && planned.data?.plans ? (
          <PageRenderContext.Provider value={context}>
            <Sheet entry={entry} page={page} paper={page.document!} base={base} plans={planned.data.plans} recordKey={key} />
          </PageRenderContext.Provider>
        ) : null}
      </article>
    </div>
  );
}

/** The letterhead and every section, once the record's row is here. */
function Sheet({
  entry,
  page,
  paper,
  base,
  plans,
  recordKey,
}: {
  entry: PageEntry | RowEntry;
  page: PageDef;
  paper: PageDocument;
  base: TableMeta;
  plans: SectionPlan[];
  recordKey: Record<string, unknown>;
}) {
  const api = usePageApi();
  const names = recordReadNames();
  const shown = page.sections.map((section, index) => ({ section, index })).filter(({ section }) => !section.hidden);
  /* Every fields section's columns, the number and the record's name, as one read of the row. */
  const read = useMemo(() => {
    const labels = new Map<string, string>();
    const columns = new Set<string>();
    for (const { section } of shown) {
      if (section.kind !== 'fields') continue;
      const own = fieldsColumns(names, base, section);
      own.fetched.forEach((column) => columns.add(column));
      own.labels.forEach((label, path) => labels.set(path, label));
    }
    if (paper.number) columns.add(paper.number);
    const named = labelPath(base) as string | undefined;
    if (named) columns.add(named);
    return { columns: [...columns], labels };
  }, [page, base]); // eslint-disable-line react-hooks/exhaustive-deps
  const record = useQuery({
    queryKey: ['document-row', page.id, base.id, recordKey, read.columns],
    queryFn: () => api('/api/view/run', rowBody(page.id, base, recordKey, read.columns, 'fields') as never),
    staleTime: 0,
  });
  /* A section behind a `when` is drawn where the record matches it, as on its page. */
  const conditions = shown.flatMap(({ section }) => (section.when ? [section.when] : []));
  const { connection } = useContext(PageRenderContext);
  const matched = useQuery({
    queryKey: ['document-when', page.id, recordKey, conditions],
    queryFn: async () =>
      new Set(
        (await Promise.all(conditions.map(async (when) => ((await rootMatches(base, recordKey, when, connection)) ? when : '')))).filter(
          Boolean,
        ),
      ),
    enabled: conditions.length > 0,
    staleTime: 0,
  });
  const reply = record.data as { rows?: Row[]; errors?: Array<{ message: string }> } | undefined;
  const row = reply?.rows?.[0];
  const number = row ? numberOf(paper, base, row) : undefined;
  useEffect(() => {
    if (!row || currentEntry() !== entry) return;
    const said = number ? `${paper.label} ${number}` : paper.label;
    if (entry.label !== said) {
      entry.label = said;
      renderCrumbs();
    }
  }, [row, number]); // eslint-disable-line react-hooks/exhaustive-deps
  if (record.isError || reply?.errors?.length)
    return <p className="doc-broken">{(record.error as Error | null)?.message ?? reply?.errors?.[0]?.message}</p>;
  if (!row || (conditions.length && !matched.data)) return null;
  const drawn = shown.filter(({ section }) => !section.when || matched.data!.has(section.when));
  return (
    <>
      <Letterhead paper={paper} number={number} />
      <div className="doc-body">
        {rowsOf(drawn).map((line, i) => (
          <div key={i} className="doc-row">
            {line.map(({ section, index, column, span }) => (
              <div
                key={index}
                className={`doc-cell doc-cell--${section.kind}`}
                style={{ gridColumn: `${column + 1} / span ${span}` } as CSSProperties}
              >
                {section.kind === 'fields' ? (
                  <PaperFields section={section} base={base} row={row} labels={read.labels} />
                ) : section.kind === 'list' ? (
                  <PaperList section={section} plan={plans.find((plan) => plan.index === index)} label={paper.label} />
                ) : section.kind === 'note' ? (
                  <PaperNote section={section} />
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * A value as paper says it: as the App dresses it, except a date it says
 * relatively. "3 days ago" is true the day it is read on screen and false on
 * every day after the sheet is printed, so paper says the day.
 */
function PaperValue({ col, value, tableId, row }: { col: Column | undefined; value: unknown; tableId: string; row?: Row }) {
  const rule = columnDisplay(tableId, col?.name ?? '') as DisplayRule | null;
  if (rule?.format === 'relative' && typeof value === 'string' && value) return <span>{formatDate(value)}</span>;
  /* Money keeps its cents on paper, every figure of a column the same width: $198.00 over $84.65, not $198. A part
     taken off a total is said with the minus sign, not a hyphen, as the New form's summary says it. */
  const figure = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
  if (rule?.format === 'money' && figure && maskedText(rule, value) === undefined) {
    const currency = rowCurrency(rule, row, rule.currency || defaultCurrency());
    const major = rule.minor ? (minorFigure(value, currency) ?? value) : value;
    return (
      <span className="num-value">
        {formatMoney(major as number | string, currency, { maximumFractionDigits: undefined }).replace(/^-/, '−')}
      </span>
    );
  }
  /* A status is its word on paper: a chip's tint is the screen's, and a printed page wears none of it. */
  const dress = dressFor(rule, value);
  if (dress?.kind === 'tone') return <span>{dress.label}</span>;
  return <Value col={col} value={value} tableId={tableId} row={row} links={false} />;
}

/** A figure with its sign turned: a part a total takes off (a discount), as the total's sum reads it. */
function negated(value: unknown): unknown {
  if (typeof value === 'number') return -value;
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Number(value))) return value;
  const text = value.trim();
  return text.startsWith('-') ? text.slice(1) : `-${text}`;
}

/** The document's number: its own field where it names one, else the record's name. */
function numberOf(paper: PageDocument, base: TableMeta, row: Row): string | undefined {
  const value = paper.number ? row[paper.number] : rowLabel(base, row);
  return value === null || value === undefined || value === '' ? undefined : String(value);
}

/**
 * Sections side by side as the page grid places them: a width and its
 * offsets on twelve columns, a new line where the next one would not fit.
 * Placed here rather than left to the grid so each line is a block of its
 * own on paper, where a sheet may end between two lines but not inside one.
 */
function rowsOf<S extends { section: PageSection; index: number }>(sections: S[]) {
  const lines: Array<Array<S & { column: number; span: number }>> = [];
  let cursor = 12;
  for (const item of sections) {
    const { width, offsetLeft, offsetRight } = item.section as {
      width?: keyof typeof SHEET_SPAN;
      offsetLeft?: keyof typeof OFFSET_SPAN;
      offsetRight?: keyof typeof OFFSET_SPAN;
    };
    const span = SHEET_SPAN[width ?? 'full'];
    const before = offsetLeft ? OFFSET_SPAN[offsetLeft] : 0;
    const after = offsetRight ? OFFSET_SPAN[offsetRight] : 0;
    if (cursor + before + span > 12) {
      lines.push([]);
      cursor = 0;
    }
    lines[lines.length - 1].push({ ...item, column: cursor + before, span: Math.min(span, 12 - cursor - before) });
    cursor = Math.min(12, cursor + before + span + after);
  }
  return lines;
}

/** Who sends it, across from what it is: the App's mark and name, the sender's lines, the document's name and number. */
function Letterhead({ paper, number }: { paper: PageDocument; number?: string }) {
  const app = activeApp();
  const name = app?.name ?? '';
  const mark = brandMark((app?.ui.theme as { branding?: { mark?: unknown } } | undefined)?.branding?.mark ?? app?.ui.logo, name);
  return (
    <header className="doc-letterhead">
      <div className="doc-from">
        {mark.image ? (
          <img className="doc-logo-image" src={mark.image} alt={name} decoding="async" />
        ) : (
          <div className="doc-brand">
            <span className={`doc-logo${mark.icon ? ' doc-logo--icon' : ''}`} aria-hidden="true">
              {mark.icon ? <Icon name={mark.icon} size="1em" weight="bold" /> : mark.initial}
            </span>
            <span className="doc-from-name">{name}</span>
          </div>
        )}
        {paper.description && <p className="doc-from-lines">{paper.description}</p>}
      </div>
      {/* One heading, read whole as the tab's title, so a saved PDF is named "Invoice SO-1042 · Atelier". */}
      <h1 className="doc-title">
        <span className="doc-title-label">{paper.label}</span>{' '}
        {number && (
          <span className="doc-title-number">
            <span className="doc-title-caption">{say('numberCaption')} </span>
            {number}
          </span>
        )}
      </h1>
    </header>
  );
}

/* Address parts by their column's name: a facts section that holds a city says "Portland, OR 97201" on one line. */
const CITY = /(^|_)(city|town|locality)$/i;
const REGION = /(^|_)(state|region|province)$/i;
const POSTAL = /(^|_)(zip|zip_code|postcode|postal|postal_code)$/i;

/** The record's own fields, as paper says the presentation the section asks. */
function PaperFields({ section, base, row, labels }: { section: Fields; base: TableMeta; row: Row; labels: Map<string, string> }) {
  const paths = section.paths?.length ? section.paths : Object.keys(row).filter((path) => base.columns.some((c) => c.name === path));
  const presented = presentationColumns(state.schema, base, paths);
  const columnAt = (path: string) => (base.columns.find((c) => c.name === path) ?? presented.get(path)) as Column | undefined;
  const caption = (path: string) => (columnLabel(base.id, path) as string | null) ?? humanName(path.split('.').pop() ?? path);
  const filled = (path: string) => row[path] !== null && row[path] !== undefined && row[path] !== '';
  /* A reference is the record it names, by its name, and nothing on paper is a link. */
  const said = (path: string): ReactNode => {
    const label = labels.get(path);
    if (columnAt(path)?.references && label && filled(label)) return String(row[label]);
    return <PaperValue col={columnAt(path)} value={row[path]} tableId={base.id} row={row} />;
  };
  /* Text to read rather than a value to glance at — what the record page draws as prose: under its caption, the
     section's whole width, so it never squeezes the caption beside it to a few letters. */
  const block = (path: string): boolean => {
    if (columnAt(path)?.references || !filled(path)) return false;
    const dress = dressFor(columnDisplay(base.id, path) as DisplayRule | null, row[path]);
    if (dress) return dress.kind === 'richText';
    return sayValue(columnAt(path), row[path]).kind === 'long';
  };
  const title = section.title ? <h2 className="doc-caption">{section.title}</h2> : null;
  const shown = paths.filter(filled);
  switch (section.presentation) {
    case 'facts': {
      /* An address block: each value a line of its own, a city, its region and code one line together. */
      const city = shown.find((path) => CITY.test(path));
      const joined = city ? shown.filter((path) => REGION.test(path) || POSTAL.test(path)) : [];
      const lines: ReactNode[] = [];
      for (const path of shown) {
        if (joined.includes(path)) continue;
        if (path !== city) {
          lines.push(<span key={path}>{said(path)}</span>);
          continue;
        }
        const region = joined.find((part) => REGION.test(part));
        const postal = joined.find((part) => POSTAL.test(part));
        lines.push(
          <span key={path}>
            {said(path)}
            {region && <>, {said(region)}</>}
            {postal && <> {said(postal)}</>}
          </span>,
        );
      }
      return (
        <section className="doc-facts">
          {title}
          <p className="doc-facts-lines">{lines}</p>
        </section>
      );
    }
    case 'table': {
      /* The totals: caption beside figure, the last the one that is owed, under a rule. A zero before it says nothing.
         Where the last is a sum of the others, a part it takes off is said negated (−$297.00), as the New form's
         summary says it. */
      const rows = shown.filter((path, i) => i === shown.length - 1 || Number(row[path]) !== 0 || typeof row[path] !== 'number');
      const total = shown[shown.length - 1];
      const expr = total ? base.computed?.[total]?.expr : undefined;
      const terms = expr ? sumTerms(expr) : undefined;
      const taken = (path: string) => path !== total && terms?.some((term) => term.path === path && term.sign < 0) === true;
      return (
        <section className="doc-totals">
          {title}
          <dl>
            {rows.map((path, i) => (
              <div key={path} className={`doc-total${i === rows.length - 1 && rows.length > 1 ? ' doc-total--due' : ''}`}>
                <dt>{caption(path)}</dt>
                <dd>
                  {taken(path) ? <PaperValue col={columnAt(path)} value={negated(row[path])} tableId={base.id} row={row} /> : said(path)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      );
    }
    case 'properties':
      return (
        <section className="doc-properties">
          {title}
          <dl>
            {shown.map((path) => (
              <div key={path} className={block(path) ? 'doc-property doc-property--block' : 'doc-property'}>
                <dt>{caption(path)}</dt>
                <dd>{said(path)}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case 'headline': {
      const [figure, ...rest] = paths;
      return (
        <section className="doc-headline">
          <p className="doc-caption">{section.title ?? caption(figure)}</p>
          <p className="doc-figure">{filled(figure) ? said(figure) : '—'}</p>
          {rest.filter(filled).length > 0 && (
            <p className="doc-headline-facts">
              {rest.filter(filled).map((path, i) => (
                <span key={path}>
                  {i > 0 && ' · '}
                  {caption(path)} {said(path)}
                </span>
              ))}
            </p>
          )}
        </section>
      );
    }
    default:
      return (
        <section className="doc-summary">
          {title}
          <dl>
            {shown.map((path) => (
              <div key={path} className={block(path) ? 'doc-field doc-field--block' : 'doc-field'}>
                <dt>{caption(path)}</dt>
                <dd>{said(path)}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
  }
}

/** Every line of a related list, in a table whose header each sheet repeats; its sums close it, once. */
function PaperList({ section, plan, label }: { section: List; plan: SectionPlan | undefined; label: string }) {
  const api = usePageApi();
  const table = findTable(section.from ?? '') as TableMeta | undefined;
  const presentation = useMemo(
    () => (plan ? listView(recordReadNames(), section, plan, section.limit ?? 0) : undefined),
    [plan, section], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const view = presentation?.view;
  const lines = useQuery({
    queryKey: ['document-lines', view],
    queryFn: () => api('/api/view/run', { view, offset: 0 } as never) as Promise<ViewReply | { errors: Array<{ message: string }> }>,
    enabled: Boolean(view) && !plan?.empty,
    staleTime: 0,
  });
  const sums = useQuery({
    queryKey: ['document-lines', 'totals', plan?.totals],
    queryFn: () => api('/api/breakdown', { def: plan!.totals } as never) as Promise<{ rows?: Row[] }>,
    enabled: Boolean(plan?.totals) && !plan?.empty,
    staleTime: 0,
  });
  const title = section.title ? <h2 className="doc-caption">{section.title}</h2> : null;
  if (!plan || plan.error || !view || !table) return <p className="doc-broken">{plan?.error ?? say('lineCouldNotBeRead')}</p>;
  if (plan.empty || (lines.data && 'rows' in lines.data && !lines.data.rows.length)) {
    if (section.emptyMode) return null;
    return (
      <section className="doc-lines">
        {title}
        <p className="doc-empty">{say('noLines')}</p>
      </section>
    );
  }
  if (!lines.data) return null;
  if (!('rows' in lines.data)) return <p className="doc-broken">{lines.data.errors[0]?.message ?? say('lineCouldNotBeRead')}</p>;
  const got = lines.data;
  /* The column that points back at the record holds one value on every line: said nowhere, as on its page. */
  const back = section.path && !section.path.includes('.') ? section.path : undefined;
  const held = new Set<string>([...(presentation!.hidden as string[]), ...(back ? [back] : [])]);
  const columns = got.columns.filter((column) => !held.has(column));
  const presented = presentationColumns(state.schema, table, columns);
  const metaOf = (column: string) => (table.columns.find((c) => c.name === column) ?? presented.get(column)) as Column | undefined;
  const plans = new Map(
    columns.map((column) => [column, planColumn(metaOf(column), column, got.rows) as { align: string; identifier?: boolean }]),
  );
  const figure = (column: string) => plans.get(column)?.align === 'right' && !plans.get(column)?.identifier;
  /* The words take the room: the column whose values run longest, a description, is the one that wraps;
     a code, a date, a figure is as wide as it is. */
  const lengthOf = (column: string) => got.rows.reduce((sum, row) => sum + String(row[column] ?? '').length, 0);
  const wordy = columns
    .filter((column) => !figure(column))
    .reduce<string | undefined>((best, column) => (best === undefined || lengthOf(column) > lengthOf(best) ? column : best), undefined);
  const cellClass = (column: string) => (figure(column) ? 'is-figure' : column === wordy ? 'is-words' : 'is-fit');
  const caption = (column: string) =>
    section.labels?.[column] ?? (columnLabel(table.id, column) as string | null) ?? humanName(column.split('.').pop() ?? column);
  const referenceLabels = presentation!.labelColumns as Record<string, string>;
  const cell = (row: Row, column: string): ReactNode => {
    const named = referenceLabels[column];
    if (named && row[named] !== null && row[named] !== undefined) return String(row[named]);
    return <PaperValue col={metaOf(column)} value={row[column]} tableId={table.id} row={row} />;
  };
  const summed = sums.data?.rows?.[0];
  const totals =
    section.totals?.length && summed ? new Map(section.totals.map((column, i) => [column, summed[`total_${i}`] ?? 0])) : undefined;
  return (
    <section className="doc-lines">
      {title}
      <table className="doc-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className={cellClass(column)}>
                {caption(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {got.rows.map((row, i) => (
            <tr key={i}>
              {columns.map((column) => (
                <td key={column} className={cellClass(column)}>
                  {cell(row, column)}
                </td>
              ))}
            </tr>
          ))}
          {/* In the body, not a footer: a footer repeats on every sheet, and a sum is said once, under the last line. */}
          {totals && (
            <tr className="doc-table-total">
              {columns.map((column, i) => (
                <td key={column} className={cellClass(column)}>
                  {totals.has(column) ? (
                    <PaperValue col={metaOf(column)} value={totals.get(column)} tableId={table.id} />
                  ) : i === 0 ? (
                    say('total')
                  ) : null}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
      {got.more && <p className="doc-more">{say('more', { count: got.rows.length, document: label.toLocaleLowerCase() })}</p>}
    </section>
  );
}

/** The author's words: terms, a thank-you, how to pay. */
function PaperNote({ section }: { section: Note }) {
  return (
    <section
      className={`doc-note${section.variant === 'quiet' ? ' doc-note--quiet' : ''}${section.variant === 'callout' ? ' doc-note--callout' : ''}`}
    >
      {section.title && <h2 className="doc-caption">{section.title}</h2>}
      {(section.text ?? '').split(/\n\s*\n/).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
    </section>
  );
}
