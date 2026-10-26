/**
 * A JSON document, laid out by its shape.
 *
 * jsonModel.ts decides what each part is best shown as; this draws it: an
 * object as quiet labels beside their values, like records as a table,
 * words as chips. Two levels open and deeper ones folded behind a count,
 * long arrays a page at a time — so a document of any size reads top-down
 * instead of as one line of braces. Raw is the text itself, pretty-printed,
 * for the reader who wants the braces; Copy takes that text.
 *
 * Read-only on purpose: a document is changed by the statement that owns
 * it, not by a box pretending a tree is a line of text.
 */
import { useEffect, useState } from 'react';
import { formatLocale } from '../locale.js';
import {
  countLabel,
  isContainer,
  ITEM_PAGE,
  KEY_PAGE,
  layoutOf,
  MORE_STEP,
  OPEN_DEPTH,
  prettyJson,
  restOf,
  scalarOf,
  sizeOf,
  type Layout,
} from './jsonModel.js';
import { say } from '../copy/record/components/JsonView.js';

export function JsonView({ value }: { value: object }) {
  const [raw, setRaw] = useState(false);
  const locale = formatLocale();
  return (
    <div className="json-view">
      <div className="json-bar">
        <button type="button" className="json-tool" aria-pressed={raw} onClick={() => setRaw(!raw)}>
          {say('raw')}
        </button>
        <CopyButton value={value} />
      </div>
      {raw ? (
        <pre className="json-raw" tabIndex={0} aria-label={say('rawJson')}>
          {prettyJson(value)}
        </pre>
      ) : (
        <Node value={value} depth={0} locale={locale} />
      )}
    </div>
  );
}

function CopyButton({ value }: { value: object }) {
  const [said, setSaid] = useState<'copied' | 'refused' | null>(null);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), 1600);
    return () => clearTimeout(timer);
  }, [said]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prettyJson(value));
      setSaid('copied');
    } catch {
      /* Clipboard access can be refused — an insecure origin, a permission
         denied; the text is one Raw away. */
      setSaid('refused');
    }
  };
  return (
    <>
      <button type="button" className="json-tool" onClick={() => void copy()}>
        {said === 'copied' ? say('copied') : said === 'refused' ? say('copyRefused') : say('copy')}
      </button>
      <span className="visually-hidden" role="status">
        {said === 'copied' ? say('copiedTheJson') : said === 'refused' ? say('common.theBrowserRefusedClipboard') : ''}
      </span>
    </>
  );
}

interface NodeProps {
  value: unknown;
  depth: number;
  locale: string | undefined;
}

function Node({ value, depth, locale }: NodeProps) {
  const layout = layoutOf(value);
  switch (layout.kind) {
    case 'scalar':
      return <Scalar value={value} locale={locale} />;
    case 'empty':
      return <span className="json-empty">{layout.text}</span>;
    case 'fields':
      return <Fields layout={layout} depth={depth} locale={locale} />;
    case 'table':
      return <Table layout={layout} depth={depth} locale={locale} />;
    case 'chips':
      return <Items items={layout.items} locale={locale} chips />;
    case 'lines':
      return <Items items={layout.items} locale={locale} chips={false} />;
  }
}

/** A value inside a container: a container with something in it folds behind its count; anything else is drawn as it is. */
function Child({ value, depth, locale, name }: NodeProps & { name: string }) {
  if (!isContainer(value) || !sizeOf(value)) return <Node value={value} depth={depth} locale={locale} />;
  return <Fold value={value} depth={depth} locale={locale} name={name} />;
}

function Fold({ value, depth, locale, name }: { value: object; depth: number; locale: string | undefined; name: string }) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const count = countLabel(value, locale);
  return (
    <>
      <button type="button" className="json-fold" aria-expanded={open} aria-label={`${name}: ${count}`} onClick={() => setOpen(!open)}>
        <span className="json-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {count}
      </button>
      {open && (
        <div className="json-group">
          <Node value={value} depth={depth} locale={locale} />
        </div>
      )}
    </>
  );
}

/** The rest of a long list, a step at a time, and never the whole of a huge one at once. */
function More({ total, shown, onMore }: { total: number; shown: number; onMore: (next: number) => void }) {
  if (shown >= total) return null;
  const next = Math.min(total - shown, MORE_STEP);
  return (
    <button
      type="button"
      className="json-more"
      title={say('notShown', { total: (total - shown).toLocaleString() })}
      onClick={() => onMore(shown + next)}
    >
      {say('showMore', { next: next.toLocaleString() })}
    </button>
  );
}

function Fields({ layout, depth, locale }: { layout: Extract<Layout, { kind: 'fields' }>; depth: number; locale: string | undefined }) {
  const [shown, setShown] = useState(layout.indexed ? ITEM_PAGE : KEY_PAGE);
  return (
    <>
      <dl className="json-fields">
        {layout.entries.slice(0, shown).map(([key, item]) => (
          <div key={key} className="json-field">
            <dt className={layout.indexed ? 'json-key json-index' : 'json-key'}>{key === '' ? '""' : key}</dt>
            <dd>
              <Child value={item} depth={depth + 1} locale={locale} name={key} />
            </dd>
          </div>
        ))}
      </dl>
      <More total={layout.entries.length} shown={shown} onMore={setShown} />
    </>
  );
}

function Table({ layout, depth, locale }: { layout: Extract<Layout, { kind: 'table' }>; depth: number; locale: string | undefined }) {
  const [shown, setShown] = useState(ITEM_PAGE);
  const { columns, folded, rows } = layout;
  /* A column of figures is read by its place values: right-aligned, head and all. */
  const figures = new Set(
    columns.filter(
      (column) =>
        rows.some((row) => typeof row[column] === 'number') && rows.every((row) => row[column] == null || typeof row[column] === 'number'),
    ),
  );
  const align = (column: string) => (figures.has(column) ? 'json-figures' : undefined);
  return (
    <>
      <div className="json-table-wrap">
        <table className="json-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col" className={align(column)}>
                  {column}
                </th>
              ))}
              {folded.length > 0 && (
                <th scope="col" title={folded.join(', ')}>
                  {say('moreFolded', { count: folded.length })}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((row, i) => {
              const rest = folded.length ? restOf(row, columns) : null;
              return (
                <tr key={i}>
                  {/* A row is one level down and its cells one more, so a
                      table's nested values start folded: a cell is a line. */}
                  {columns.map((column) => (
                    <td key={column} className={align(column)}>
                      {Object.hasOwn(row, column) && (
                        <Child value={row[column]} depth={depth + 2} locale={locale} name={`${column}, row ${i + 1}`} />
                      )}
                    </td>
                  ))}
                  {rest && (
                    <td>{sizeOf(rest) > 0 && <Fold value={rest} depth={OPEN_DEPTH} locale={locale} name={`Row ${i + 1}, the rest`} />}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <More total={rows.length} shown={shown} onMore={setShown} />
    </>
  );
}

function Items({ items, locale, chips }: { items: unknown[]; locale: string | undefined; chips: boolean }) {
  const [shown, setShown] = useState(ITEM_PAGE);
  const drawn = items.slice(0, shown).map((item, i) => (
    <li key={i} className={chips ? 'json-chip' : undefined}>
      <Scalar value={item} locale={locale} />
    </li>
  ));
  return (
    <>
      {chips ? (
        <ul className="json-chips">{drawn}</ul>
      ) : (
        <ol className="json-lines" start={0}>
          {drawn}
        </ol>
      )}
      <More total={items.length} shown={shown} onMore={setShown} />
    </>
  );
}

function Scalar({ value, locale }: { value: unknown; locale: string | undefined }) {
  const said = scalarOf(value, locale);
  switch (said.kind) {
    case 'null':
      return (
        <span className="json-null" title="null">
          —
        </span>
      );
    case 'boolean':
      return <span className={`json-bool${said.on ? ' yes' : ''}`}>{said.on ? say('common.yes') : say('common.no')}</span>;
    case 'number':
      return (
        <span className="json-number" title={said.title}>
          {said.text}
        </span>
      );
    case 'link':
      return (
        <a className="json-link" href={said.href} target="_blank" rel="noopener noreferrer">
          {said.text}
        </a>
      );
    case 'date':
      return (
        <time className="json-date" dateTime={said.title} title={said.title}>
          {said.text}
        </time>
      );
    case 'empty':
      return (
        <span className="json-empty" title={say('anEmptyString')}>
          ""
        </span>
      );
    case 'text':
      return <span className={said.long ? 'json-text json-long' : 'json-text'}>{said.text}</span>;
  }
}
