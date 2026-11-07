/**
 * A JSON document, laid out by its shape.
 *
 * jsonModel.ts decides what each part is best shown as; this draws it: an
 * object as quiet labels beside their values, like records as a table,
 * words as chips. Two levels open and deeper ones folded behind a count,
 * long arrays a page at a time — so a document of any size reads top-down
 * instead of as one line of braces. Raw is the text itself, pretty-printed
 * and tinted, for the reader who wants the braces; Copy takes that text.
 *
 * What a developer's viewer gives, it gives too, without giving up the
 * layout: a filter over keys and values that marks each match and opens
 * whatever holds one; Expand all and Collapse all; each node's value and
 * path (`data.lines[2].sku`) a click or a key away; values tinted by type,
 * quietly, from the tokens (a hex color with its swatch, an id in the code
 * face).
 *
 * The keyboard's tree pattern (APG), as TreeList.tsx has it: the document is
 * one `role="tree"` and one Tab stop, the node last visited. Up and Down move
 * through what is open, Right opens a node or steps into it, Left folds it or
 * steps out to its parent, Home and End go to the ends, Enter and Space fold.
 * Every key, value, row and item is a `treeitem` with its level, its place
 * among its siblings and, when it holds something, `aria-expanded`; its name
 * is said for it (`city: London`), so a folded branch is never read out
 * whole. The tree rather than the description list and table it draws:
 * those name a pair or a cell, but not where it is, whether it opens, or
 * how to get back out — and a reader moving by key needs all three. A table
 * row's name carries its column names, so nothing the header said is lost.
 * The current node's own controls (Copy value, Copy path, a link) are the
 * Tab stops after it; every other node's wait until it is current.
 *
 * Read-only on purpose: a document is changed by the statement that owns
 * it, not by a box pretending a tree is a line of text.
 */
import './JsonView.css';
import {
  createContext,
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
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
import {
  childPath,
  copyTextOf,
  hasNested,
  isFound,
  nodeCount,
  rawLines,
  search,
  shownTextOf,
  splitOnMatches,
  textFace,
  tokenizeLine,
  type Found,
} from './jsonTree.js';
import { say } from '../copy/record/components/JsonView.js';

/** The filter is offered past this many nodes: a dozen lines are read faster than searched. */
const FILTER_FROM = 12;
/** Raw lines tinted token by token; past these a line is drawn plain, so a huge document is a page, not a freeze. */
const TINTED_LINES = 4000;

type Opening = 'auto' | 'open' | 'closed';

interface Tree {
  locale: string | undefined;
  /** What the filter found, when it found anything. */
  found: Found | null;
  /** The node that is the tree's one Tab stop. */
  current: string | null;
  isOpen: (path: string, depth: number, holdsMatch: boolean) => boolean;
  toggle: (path: string, open: boolean) => void;
  copy: (text: string, done: string) => Promise<boolean>;
  /** Whether a node offers its copies: not in a list of plain values, which is words, not a document (`bar`). */
  copies: boolean;
}

const TreeContext = createContext({} as Tree);
const useTree = () => useContext(TreeContext);

export function JsonView({
  value,
  bar = true,
  label,
  head,
  tail,
}: {
  value: object;
  /** False for a list of plain values (Value.tsx): its words with neither the bar nor a node's copies over them. */
  bar?: boolean;
  /** The tree's name: the field's or the column's, where there is one. */
  label?: string;
  /** Drawn at the start of the bar, and at its end: the overlay's title and its Close. */
  head?: ReactNode;
  tail?: ReactNode;
}) {
  const locale = formatLocale();
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const [wrap, setWrap] = useState(false);
  const [opening, setOpening] = useState<Opening>('auto');
  const [query, setQuery] = useState('');
  const asked = useDeferredValue(query.trim());
  /* A fold the reader set by hand holds for the filter it was set under; a new
     filter opens what holds its matches afresh. */
  const [folds, setFolds] = useState<{ asked: string; map: ReadonlyMap<string, boolean> }>({ asked: '', map: new Map() });
  const [current, setCurrent] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const filterable = useMemo(() => nodeCount(value, FILTER_FROM + 1) > FILTER_FROM, [value]);
  const nested = useMemo(() => hasNested(value), [value]);
  const found = useMemo(() => (filterable && asked ? search(value, asked, locale) : null), [filterable, value, asked, locale]);
  /* A filter that finds nothing folds nothing: the document stays as it was, and the bar says so. */
  const folding = found?.count ? found : null;
  const own = folds.asked === asked ? folds.map : null;

  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(''), 1600);
    return () => clearTimeout(timer);
  }, [said]);

  /* The tree is one Tab stop. When the node that held it is folded away or
     paged out, the first node takes it, so Tab always lands somewhere. */
  useLayoutEffect(() => {
    const root = treeRef.current;
    if (!root || root.querySelector('[role="treeitem"][tabindex="0"]')) return;
    const first = root.querySelector<HTMLElement>('[role="treeitem"]');
    if (first?.dataset.path !== undefined) setCurrent(first.dataset.path);
  });

  const tree: Tree = {
    locale,
    found: folding,
    current,
    copies: bar,
    isOpen: (path, depth, holdsMatch) => {
      const set = own?.get(path);
      if (set !== undefined) return set;
      if (opening === 'open' || (folding && holdsMatch)) return true;
      if (folding || opening === 'closed') return false;
      return depth < OPEN_DEPTH;
    },
    toggle: (path, open) => setFolds((prev) => ({ asked, map: new Map(prev.asked === asked ? prev.map : []).set(path, open) })),
    copy: async (text, done) => {
      try {
        await navigator.clipboard.writeText(text);
        setSaid(done);
        return true;
      } catch {
        /* Clipboard access can be refused — an insecure origin, a permission
           denied; the text is one Raw away. */
        setSaid(say('common.theBrowserRefusedClipboard'));
        return false;
      }
    },
  };

  const openAll = (to: Opening) => {
    setOpening(to);
    setFolds({ asked, map: new Map() });
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[role="treeitem"]');
    if (!item || item.dataset.path === undefined) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const at = items.indexOf(item);
    const expanded = item.getAttribute('aria-expanded');
    const go = (next: HTMLElement | null | undefined) => next?.focus();
    switch (event.key) {
      case 'ArrowDown':
        go(items[at + 1]);
        break;
      case 'ArrowUp':
        go(items[at - 1]);
        break;
      case 'Home':
        go(items[0]);
        break;
      case 'End':
        go(items.at(-1));
        break;
      case 'ArrowRight':
        if (expanded === 'false') tree.toggle(item.dataset.path, true);
        else if (items[at + 1] && item.contains(items[at + 1])) go(items[at + 1]);
        break;
      case 'ArrowLeft':
        if (expanded === 'true') tree.toggle(item.dataset.path, false);
        else go(item.parentElement?.closest<HTMLElement>('[role="treeitem"]'));
        break;
      case 'Enter':
      case ' ':
        /* On a node's own button or link, the key is that control's. */
        if (target !== item || expanded === null) return;
        tree.toggle(item.dataset.path, expanded === 'false');
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const path = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')?.dataset.path;
    if (path !== undefined && path !== current) setCurrent(path);
  };

  /* `/` finds, as it does in a code host's viewer: from anywhere in the document, to its filter. */
  const onViewKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== '/' || !filterRef.current || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    filterRef.current.focus();
  };

  const treeMode = mode === 'tree';
  const layout = layoutOf(value);
  return (
    <div className="json-view" onKeyDown={onViewKey}>
      {bar && (
        <div className="json-bar">
          {head}
          {treeMode && filterable && (
            <div className="json-filter">
              <input
                ref={filterRef}
                type="search"
                className="json-filter-input"
                value={query}
                placeholder={say('filter')}
                aria-label={say('filterKeysAndValues')}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  /* Escape clears a filter first; only an empty one lets Escape close the dialog it is in. */
                  if (event.key !== 'Escape' || !query) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                }}
              />
              <span className="json-count" aria-live="polite">
                {found ? (found.count ? say('matches', { count: found.count }) : say('noMatches')) : ''}
              </span>
            </div>
          )}
          <div className="json-tools">
            {treeMode && nested && (
              <>
                <button type="button" className="json-tool" onClick={() => openAll('open')}>
                  {say('expandAll')}
                </button>
                <button type="button" className="json-tool" onClick={() => openAll('closed')}>
                  {say('collapseAll')}
                </button>
              </>
            )}
            {/* Each mode's own tools come first, so Tree | Raw and Copy stay where the pointer left them. */}
            {!treeMode && (
              <button type="button" className="json-tool" aria-pressed={wrap} title={say('wrapLines')} onClick={() => setWrap(!wrap)}>
                {say('wrap')}
              </button>
            )}
            <div className="json-modes" role="group" aria-label={say('view')}>
              <button type="button" className="json-mode" aria-pressed={treeMode} onClick={() => setMode('tree')}>
                {say('tree')}
              </button>
              <button type="button" className="json-mode" aria-pressed={!treeMode} onClick={() => setMode('raw')}>
                {say('raw')}
              </button>
            </div>
            <CopyButton value={value} copy={tree.copy} />
            {tail}
          </div>
        </div>
      )}
      {!treeMode ? (
        <RawText value={value} wrap={wrap} />
      ) : layout.kind === 'empty' ? (
        <span className="json-empty">{layout.text}</span>
      ) : (
        <div ref={treeRef} role="tree" aria-label={label ?? say('document')} className="json-tree" onKeyDown={onKey} onFocus={onFocus}>
          <TreeContext.Provider value={tree}>
            <Node value={value} path="" depth={0} level={1} />
          </TreeContext.Provider>
        </div>
      )}
      <span className="visually-hidden" role="status">
        {said}
      </span>
    </div>
  );
}

function CopyButton({ value, copy }: { value: object; copy: Tree['copy'] }) {
  const [said, setSaid] = useState<'copied' | 'refused' | null>(null);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), 1600);
    return () => clearTimeout(timer);
  }, [said]);
  return (
    <button
      type="button"
      className="json-tool"
      onClick={() => void copy(prettyJson(value), say('copiedTheJson')).then((ok) => setSaid(ok ? 'copied' : 'refused'))}
    >
      {said === 'copied' ? say('copied') : said === 'refused' ? say('copyRefused') : say('copy')}
    </button>
  );
}

/** A value said in a node's name: what is drawn, and a container by its count. */
function spoken(value: unknown, locale: string | undefined): string {
  if (isContainer(value)) return sizeOf(value) ? countLabel(value, locale) : Array.isArray(value) ? '[]' : '{}';
  return value === '' ? say('anEmptyString') : shownTextOf(value, locale);
}

/** Whether a container holds a match anywhere inside: it opens while the filter stands. */
function holds(found: Found | null, value: object, base: string): boolean {
  if (!found) return false;
  const indexed = Array.isArray(value);
  return Object.keys(value).some((key) => isFound(found, childPath(base, indexed ? Number(key) : key)));
}

interface NodeProps {
  value: unknown;
  /** The path its children are reached from. */
  path: string;
  depth: number;
  /** The tree level its children stand at. */
  level: number;
}

function Node({ value, path, depth, level }: NodeProps) {
  const layout = layoutOf(value);
  switch (layout.kind) {
    case 'scalar':
    case 'empty':
      return null;
    case 'fields':
      return <Fields layout={layout} path={path} depth={depth} level={level} />;
    case 'table':
      return <Table layout={layout} path={path} depth={depth} level={level} />;
    case 'chips':
    case 'lines':
      return <Items items={layout.items} chips={layout.kind === 'chips'} path={path} level={level} />;
  }
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

/** A text with the filter's matches marked; `whole` marks all of it when the match was in the value's JSON, not its words. */
function Marked({ text, query, whole = false }: { text: string; query: string; whole?: boolean }) {
  const parts = splitOnMatches(text, query);
  if (parts.length === 1) return whole ? <mark className="json-mark">{text}</mark> : <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <mark key={i} className="json-mark">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A folded container's count, in its own braces: `{3 keys}`, `[12 items]`. */
function Summary({ value, onClick }: { value: object; onClick?: () => void }) {
  const { locale } = useTree();
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return (
    <span className="json-summary" onClick={onClick}>
      {open}
      {countLabel(value, locale)}
      {close}
    </span>
  );
}

/**
 * A node's two copies: its value (a string as itself, anything else as JSON)
 * and its path. Drawn on hover and when the node is current; the status line
 * says what was taken, as the bar's Copy does.
 */
function Actions({ value, path, name, active }: { value: unknown; path: string | null; name: string; active: boolean }) {
  const tree = useTree();
  const [done, setDone] = useState<'value' | 'path' | null>(null);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 1600);
    return () => clearTimeout(timer);
  }, [done]);
  const take = (what: 'value' | 'path') => (event: MouseEvent) => {
    event.stopPropagation();
    const text = what === 'value' ? copyTextOf(value) : (path ?? '');
    const said = what === 'value' ? say('copiedValueOf', { path: name }) : say('copiedPath', { path: text });
    void tree.copy(text, said).then((ok) => ok && setDone(what));
  };
  if (!tree.copies) return null;
  return (
    <span className="json-actions">
      <button
        type="button"
        className="json-act"
        tabIndex={active ? 0 : -1}
        aria-label={say('copyValueOf', { path: name })}
        onClick={take('value')}
      >
        {done === 'value' ? say('copied') : say('copyValue')}
      </button>
      {path && (
        <button
          type="button"
          className="json-act"
          tabIndex={active ? 0 : -1}
          aria-label={say('copyPathOf', { path })}
          onClick={take('path')}
        >
          {done === 'path' ? say('copied') : say('copyPath')}
        </button>
      )}
    </span>
  );
}

/** An object's keys, or a mixed array's positions: each a node, its caret in a gutter so every key starts on one line. */
function Fields({
  layout,
  path,
  depth,
  level,
}: {
  layout: Extract<Layout, { kind: 'fields' }>;
  path: string;
  depth: number;
  level: number;
}) {
  const { found } = useTree();
  const [shown, setShown] = useState(layout.indexed ? ITEM_PAGE : KEY_PAGE);
  const total = layout.entries.length;
  return (
    <>
      <div className="json-fields">
        {layout.entries.map(([key, item], i) => {
          const here = childPath(path, layout.indexed ? i : key);
          /* Past the page, a match is still drawn: the filter's count never names a node nobody can see. */
          if (i >= shown && !isFound(found, here)) return null;
          return (
            <Entry
              key={key}
              name={key}
              indexed={layout.indexed}
              value={item}
              path={here}
              depth={depth + 1}
              level={level}
              place={[i + 1, total]}
            />
          );
        })}
      </div>
      <More total={total} shown={shown} onMore={setShown} />
    </>
  );
}

function Entry({
  name,
  indexed,
  value,
  path,
  depth,
  level,
  place,
}: {
  name: string;
  indexed: boolean;
  value: unknown;
  path: string;
  depth: number;
  level: number;
  place: [number, number];
}) {
  const tree = useTree();
  const folds = isContainer(value) && sizeOf(value) > 0;
  const open = folds && tree.isOpen(path, depth, !!tree.found?.inside.has(path));
  const active = tree.current === path;
  const toggle = folds ? () => tree.toggle(path, !open) : undefined;
  const key = name === '' ? '""' : name;
  return (
    <div
      role="treeitem"
      className="json-entry"
      data-path={path}
      aria-level={level}
      aria-posinset={place[0]}
      aria-setsize={place[1]}
      aria-expanded={folds ? open : undefined}
      aria-label={`${key}: ${spoken(value, tree.locale)}`}
      tabIndex={active ? 0 : -1}
    >
      <div className={folds ? 'json-row is-fold' : 'json-row'}>
        <span className="json-caret" aria-hidden="true" onClick={toggle}>
          {folds ? (open ? '▾' : '▸') : null}
        </span>
        <span className={indexed ? 'json-key json-index' : 'json-key'} onClick={toggle}>
          {!indexed && tree.found?.keys.has(path) ? <Marked text={key} query={tree.found.query} /> : key}
        </span>
        <span className="json-value">
          {folds ? <Summary value={value} onClick={toggle} /> : <Scalar value={value} path={path} active={active} />}
        </span>
        <Actions value={value} path={path} name={path} active={active} />
      </div>
      {open && (
        <div role="group" className="json-group">
          <Node value={value} path={path} depth={depth} level={level + 1} />
        </div>
      )}
    </div>
  );
}

/** A container inside a table's cell, or a row's columns past the drawn ones: a node that folds in place. */
function Fold({
  value,
  id,
  base,
  copyPath,
  depth,
  level,
  name,
}: {
  value: object;
  /** The node's identity: its path, or the row's path and `#rest` for the columns a wide table folds. */
  id: string;
  /** The path its children are reached from. */
  base: string;
  /** Whether the node has a path of its own to copy (a row's rest does not). */
  copyPath: boolean;
  depth: number;
  level: number;
  name: string;
}) {
  const tree = useTree();
  const open = tree.isOpen(id, depth, holds(tree.found, value, base));
  const active = tree.current === id;
  const toggle = () => tree.toggle(id, !open);
  return (
    <div
      role="treeitem"
      className="json-fold"
      data-path={id}
      aria-level={level}
      aria-expanded={open}
      aria-label={`${name}: ${countLabel(value, tree.locale)}`}
      tabIndex={active ? 0 : -1}
    >
      <div className="json-fold-row">
        <span className="json-caret" aria-hidden="true" onClick={toggle}>
          {open ? '▾' : '▸'}
        </span>
        <Summary value={value} onClick={toggle} />
        <Actions value={value} path={copyPath ? id : null} name={name} active={active} />
      </div>
      {open && (
        <div role="group" className="json-group">
          <Node value={value} path={base} depth={depth} level={level + 1} />
        </div>
      )}
    </div>
  );
}

function Table({ layout, path, depth, level }: { layout: Extract<Layout, { kind: 'table' }>; path: string; depth: number; level: number }) {
  const { found } = useTree();
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
  /* A key the filter found is a column here: its head is marked once, not each row. */
  const keyFound = (column: string) => !!found && rows.some((_, i) => found.keys.has(childPath(childPath(path, i), column)));
  return (
    <>
      <div className="json-table-wrap">
        <table className="json-table" role="none">
          {/* The head is for the eye: each row's name says its columns to a screen reader. */}
          <thead aria-hidden="true">
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col" className={align(column)}>
                  {found && keyFound(column) ? <Marked text={column} query={found.query} /> : column}
                </th>
              ))}
              {folded.length > 0 && <th title={folded.join(', ')}>{say('moreFolded', { count: folded.length })}</th>}
              <th className="json-act-cell" />
            </tr>
          </thead>
          <tbody role="none">
            {rows.map((row, i) => {
              const here = childPath(path, i);
              if (i >= shown && !isFound(found, here)) return null;
              return (
                <TableRow
                  key={i}
                  row={row}
                  index={i}
                  total={rows.length}
                  path={here}
                  columns={columns}
                  folded={folded}
                  depth={depth}
                  level={level}
                  align={align}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <More total={rows.length} shown={shown} onMore={setShown} />
    </>
  );
}

function TableRow({
  row,
  index,
  total,
  path,
  columns,
  folded,
  depth,
  level,
  align,
}: {
  row: Record<string, unknown>;
  index: number;
  total: number;
  path: string;
  columns: string[];
  folded: string[];
  depth: number;
  level: number;
  align: (column: string) => string | undefined;
}) {
  const tree = useTree();
  const active = tree.current === path;
  const rest = folded.length ? restOf(row, columns) : null;
  const said = columns
    .filter((column) => Object.hasOwn(row, column))
    .map((column) => `${column} ${spoken(row[column], tree.locale)}`)
    .join(', ');
  return (
    <tr
      role="treeitem"
      className="json-tr"
      data-path={path}
      aria-level={level}
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-label={`${say('row', { n: index + 1 })}: ${said}`}
      tabIndex={active ? 0 : -1}
    >
      {/* A row is one level down and its cells one more, so a table's
          nested values start folded: a cell is a line. */}
      {columns.map((column) => (
        <td key={column} role="none" className={align(column)}>
          {Object.hasOwn(row, column) && (
            <Cell value={row[column]} path={childPath(path, column)} depth={depth + 2} level={level + 1} active={active} />
          )}
        </td>
      ))}
      {rest && (
        <td role="none">
          {sizeOf(rest) > 0 && (
            <div role="group">
              <Fold
                value={rest}
                id={`${path}#rest`}
                base={path}
                copyPath={false}
                depth={OPEN_DEPTH}
                level={level + 1}
                name={say('rowRest', { n: index + 1 })}
              />
            </div>
          )}
        </td>
      )}
      <td role="none" className="json-act-cell">
        <Actions value={row} path={path} name={path} active={active} />
      </td>
    </tr>
  );
}

function Cell({ value, path, depth, level, active }: { value: unknown; path: string; depth: number; level: number; active: boolean }) {
  if (!isContainer(value) || !sizeOf(value)) return <Scalar value={value} path={path} active={active} />;
  return (
    <div role="group">
      <Fold value={value} id={path} base={path} copyPath depth={depth} level={level} name={path} />
    </div>
  );
}

function Items({ items, chips, path, level }: { items: unknown[]; chips: boolean; path: string; level: number }) {
  const tree = useTree();
  const [shown, setShown] = useState(ITEM_PAGE);
  const drawn = items.map((item, i) => {
    const here = childPath(path, i);
    if (i >= shown && !isFound(tree.found, here)) return null;
    const active = tree.current === here;
    return (
      <li
        key={i}
        role="treeitem"
        className={chips ? 'json-chip' : 'json-item'}
        data-path={here}
        aria-level={level}
        aria-posinset={i + 1}
        aria-setsize={items.length}
        aria-label={`${i}: ${spoken(item, tree.locale)}`}
        tabIndex={active ? 0 : -1}
      >
        <Scalar value={item} path={here} active={active} />
        <Actions value={item} path={here} name={here} active={active} />
      </li>
    );
  });
  return (
    <>
      {chips ? (
        <ul className="json-chips" role="none">
          {drawn}
        </ul>
      ) : (
        <ol className="json-lines" start={0} role="none">
          {drawn}
        </ol>
      )}
      <More total={items.length} shown={shown} onMore={setShown} />
    </>
  );
}

function Scalar({ value, path, active }: { value: unknown; path: string; active: boolean }) {
  const { locale, found } = useTree();
  if (isContainer(value)) return <span className="json-empty">{Array.isArray(value) ? '[]' : '{}'}</span>;
  const said = scalarOf(value, locale);
  const query = found?.values.has(path) ? found.query : '';
  const mark = (text: string) => (query ? <Marked text={text} query={query} whole /> : text);
  switch (said.kind) {
    case 'null':
      return <span className="json-null">{mark('null')}</span>;
    case 'boolean':
      return <span className="json-bool">{mark(said.on ? 'true' : 'false')}</span>;
    case 'number':
      return (
        <span className="json-number" title={said.title}>
          {mark(said.text)}
        </span>
      );
    case 'link':
      return (
        <a className="json-link" href={said.href} target="_blank" rel="noopener noreferrer" tabIndex={active ? 0 : -1}>
          {mark(said.text)}
        </a>
      );
    case 'date':
      return (
        <time className="json-date" dateTime={said.title} title={said.title}>
          {mark(said.text)}
        </time>
      );
    case 'empty':
      return (
        <span className="json-empty" title={say('anEmptyString')}>
          {mark('""')}
        </span>
      );
    case 'text': {
      if (said.long) return <span className="json-text json-long">{mark(said.text)}</span>;
      const face = textFace(said.text);
      return (
        <span className={face.code ? 'json-text json-code' : 'json-text'}>
          {face.swatch && <span className="json-swatch" style={{ background: face.swatch }} aria-hidden="true" />}
          {mark(said.text)}
        </span>
      );
    }
  }
}

/**
 * The text itself, tinted by hand — keys, strings, numbers, literals, null and
 * punctuation each in its type's ink — with each line's number in a gutter the
 * selection never takes (a pseudo-element's content is not text), and long
 * lines on one line until Wrap. Each line ends in its own line break, so a
 * selection copies as the JSON it shows.
 */
function RawText({ value, wrap }: { value: object; wrap: boolean }) {
  const lines = useMemo(() => rawLines(value), [value]);
  const style = { '--json-digits': String(lines.length).length } as CSSProperties;
  return (
    <pre className={wrap ? 'json-raw is-wrapped' : 'json-raw'} role="region" tabIndex={0} aria-label={say('rawJson')} style={style}>
      {lines.map((line, i) => (
        <span key={i} className="json-line" data-n={i + 1}>
          {i < TINTED_LINES
            ? tokenizeLine(line).map((token, j) =>
                token.kind === 'space' ? (
                  token.text
                ) : (
                  <span key={j} className={`json-t-${token.kind}`}>
                    {token.text}
                  </span>
                ),
              )
            : line}
          {i < lines.length - 1 ? '\n' : null}
        </span>
      ))}
    </pre>
  );
}
