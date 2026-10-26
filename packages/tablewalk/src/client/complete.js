/**
 * Autocomplete for the query bar.
 *
 * The language is small enough to memorise and nobody should have to. The
 * schema is already in the browser, so the bar can propose the table you mean,
 * the columns it has, and the operators that make sense next — which is also
 * the fastest way to *learn* the language, since every suggestion is a working
 * example of the next token.
 *
 * Deliberately not a parser. It reads the token under the caret and the one
 * before it, which is enough to know whether a table, a column, an operator or
 * a keyword comes next. A full parse would be more correct and would also have
 * to cope with the half-written text a parser sees mid-keystroke, where the
 * useful answer is usually "you are in the middle of a column name".
 */
import { $, columnKind, el, looksLikeDateColumn, state, viewportBox, viewportSize } from '@mistriwork/kit/client/core.js';
import { plural } from '@mistriwork/kit/client/locale.js';
import { say } from './copy/workbench/complete.js';
import { portalRoot } from '@mistriwork/kit/client/shellHost.js';

const OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'between', 'contains', 'startswith', 'endswith', 'like', 'in', 'not in'];

/* `between` is offered only where a range means something. On a text column
   it is legal and useless — nobody asks for the names between "a" and "b" —
   and an operator list that offers everything everywhere is a list you stop
   reading. */
const RANGEABLE = new Set(['number', 'date']);
const CLAUSES = ['sort', 'show', 'limit', 'where', 'order by'];
const JOINERS = ['and', 'or'];
const NULL_CHECKS = ['is empty', 'is not empty'];
const DATE_VALUES = [
  'today',
  'yesterday',
  'this week',
  'last week',
  'this month',
  'last month',
  'this quarter',
  'last quarter',
  'this year',
  'last year',
  'last 7 days',
  'last 30 days',
  'last 24 hours',
  'last 12 months',
  'last 3 years',
];

/** Words that mean a column name comes next. */
const EXPECTS_COLUMN = new Set(['and', 'or', 'where', 'filter', 'show', 'select', 'sort', 'by', ',']);

/* Clauses whose value is a comma-separated list, so more than one suggestion
   at a time is a sensible thing to ask for. `show a, b, c` is the case: after
   `show` you nearly always want several columns, and taking them one at a
   time means reopening the list once per column. A filter is not on this
   list — `name` and `email` in the same condition is not a query. */
const TAKES_A_LIST = new Set(['show', 'select', 'sort', 'by', ',']);

/* One popup is open at a time, so the module holds the state of whichever
   field currently has focus rather than a copy per field. `bind()` in
   `attachComplete` points these at the field being typed in — the alternative
   is closures per field and a second set of key handlers, for a list that can
   only ever be in one place. */
let box = null;
/** The input the open list belongs to, for the aria state that lives on it. */
let bound = null;
let items = [];
let index = -1;
/**
 * Where a Shift-extended range started.
 *
 * A range needs two ends: the one the arrow keys are moving and the one it is
 * measured from. Without an anchor, Shift+Down twice would select the two
 * items either side of the cursor rather than the run between them.
 */
let anchorIndex = -1;
/* Typed, not just initialised.

   A default of `() => []` tells the checker the function takes no arguments,
   so every real call — which passes two — reads as an error. The signature is
   the contract between this module and whatever attaches to it, and writing it
   down is what lets a caller that gets it wrong be caught. */

/** @type {(text: string, caret: number) => Array<Record<string, any>>} */
let suggester = () => [];

/** @type {(text: string, caret: number) => { word: string, start: number }} */
let splitter = (text, caret) => tokenAt(text, caret);
let anchor = 'field';

export function initComplete() {
  attachComplete($('query'), suggestionsFor);
}

/**
 * Give any text field the same completion behaviour.
 *
 * Extracted from the query bar so the SQL editor gets the keyboard contract
 * rather than a second implementation of it: Tab takes the first suggestion
 * even with nothing highlighted, Enter only completes when something is, and
 * Ctrl+Space reopens a list that closed itself. Those are small decisions that
 * took a while to settle, and two copies of them would drift the way every
 * other pair of copies in this codebase has.
 *
 * @param {HTMLInputElement|HTMLTextAreaElement} input
 * @param {(text: string, caret: number) => Array} suggest
 * @param {{ anchor?: 'field' | 'caret', split?: (text: string, caret: number) => {word: string, start: number} }} [options]
 */
export function attachComplete(input, suggest, options = {}) {
  /* The combobox contract: without it a screen reader hears nothing when
     the list opens or the highlight moves. The listbox and options carry
     ids for aria-activedescendant; focus itself never leaves the input,
     which is the behaviour readers expect from this pattern. */
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const own = el('div', { class: 'ac', hidden: true, role: 'listbox' });
  input.parentElement.append(own);

  const bind = () => {
    box = own;
    bound = input;
    suggester = suggest;
    splitter = options.split ?? tokenAt;
    anchor = options.anchor ?? 'field';
  };

  input.addEventListener('input', () => {
    bind();
    update(input);
  });
  input.addEventListener('click', () => {
    bind();
    update(input);
  });
  input.addEventListener('blur', () =>
    setTimeout(() => {
      bind();
      close();
    }, 120),
  );
  input.addEventListener('keydown', (e) => {
    bind();
    onKey(e, input);
  });
  return () => own.remove();
}

function close() {
  bound?.setAttribute('aria-expanded', 'false');
  bound?.removeAttribute('aria-activedescendant');
  if (box) box.hidden = true;
  items = [];
  index = -1;
  anchorIndex = -1;
}

/** The word being typed, and where it starts. */
function tokenAt(text, caret) {
  const before = text.slice(0, caret);
  const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf(',')) + 1;
  return { word: before.slice(start), start };
}

function previousWord(text, start) {
  return text.slice(0, start).trim().split(/\s+/).pop()?.toLowerCase() ?? '';
}

/**
 * What could come next, given where the caret is.
 *
 * The ordering within each list matters more than the list: the first entry is
 * what Tab accepts, so it should be the likeliest thing, not the alphabetically
 * first.
 *
 * Exported for test/mirrors.test.ts, which asks it for the suggestions on
 * every column of a fixture schema and checks that the ones offering relative
 * dates are exactly the columns shared/schema.ts calls dates. That the rule is
 * shared is a fact about the source; that the completer *applies* it is not.
 */
export function suggestionsFor(text, caret) {
  const { word, start } = tokenAt(text, caret);
  const lower = word.toLowerCase();
  const head = text.trim().split(/\s+/)[0] ?? '';

  // Nothing typed yet, or still on the first word: this is the table.
  if (start === 0) {
    return state.schema.tables
      .filter((t) => !lower || t.id.toLowerCase().includes(lower) || t.name.toLowerCase().includes(lower))
      .map((t) => ({
        value: t.name === t.id ? t.id : t.id,
        label: t.id,
        detail: `${say('common.columns2', { count: t.columns.length })}${t.isView ? say('view') : ''}`,
        kind: 'table',
      }));
  }

  const listed = state.schema.tables.find((t) => t.id === head) ?? state.schema.tables.find((t) => t.name === head);
  if (!listed) return [];
  const previous = previousWord(text, start);

  /* `any opportunity via account_id where …`: the rows that point at the record. After `any` (or `no`) come the
     tables that point here, then their reference where there are several, then `where` and their own columns. */
  const pointing = state.schema.foreignKeys.filter((fk) => fk.to.table === listed.id);
  const before = text.slice(0, start).trim().split(/\s+/);
  const twoBack = (before[before.length - 2] ?? '').toLowerCase();
  if (previous === 'any' || previous === 'no') {
    return [...new Set(pointing.map((fk) => fk.from.table))]
      .map((id) => ({ value: id, label: id, detail: say('pointsHere', { table: listed.name }), kind: 'table' }))
      .filter((s) => !lower || s.value.toLowerCase().startsWith(lower));
  }
  const childAt = (name) => pointing.find((fk) => fk.from.table === name || findTableNamed(fk.from.table)?.name === name);
  if ((twoBack === 'any' || twoBack === 'no') && childAt(previous)) {
    const several = pointing.filter((fk) => fk.from.table === childAt(previous).from.table).length > 1;
    return [...(several ? ['via'] : []), 'where']
      .map((w) => ({ value: w, label: w, detail: 'clause', kind: 'kw' }))
      .filter((s) => !lower || s.value.startsWith(lower));
  }
  if (previous === 'via' && childAt(twoBack)) {
    return pointing
      .filter((fk) => fk.from.table === childAt(twoBack).from.table)
      .map((fk) => ({ value: fk.from.columns.join('+'), label: fk.from.columns.join('+'), detail: `→ ${listed.name}`, kind: 'column' }))
      .filter((s) => !lower || s.value.toLowerCase().startsWith(lower));
  }
  const table = insideAny(text.slice(0, start), pointing) ?? listed;

  const columns = table.columns.map((c) => ({
    value: c.name,
    label: c.name,
    detail: `${c.type.toLowerCase()}${c.primaryKey ? say('key') : ''}${c.references ? ` → ${c.references.table}` : ''}`,
    kind: 'column',
  }));

  const matches = (list) => list.filter((s) => !lower || s.value.toLowerCase().startsWith(lower));
  /* Where a condition starts, the rows that point at the record may be asked about too. */
  const asking =
    table === listed && pointing.length
      ? ['any', 'no'].map((w) => ({ value: w, label: w, detail: say('rowsThatPointHere'), kind: 'kw' }))
      : [];

  /* Immediately after the table name a column is what you want essentially
     always — `customer ` is the start of a filter, not the end of a query.
     Keywords come after, for the rarer case of jumping straight to `sort`. */
  if (previous === head.toLowerCase() || previous === listed.name.toLowerCase()) {
    return matches([...columns, ...asking, ...CLAUSES.map((c) => ({ value: c, label: c, detail: 'clause', kind: 'kw' }))]);
  }

  // After a joiner or a clause word, a column name comes next.
  if (EXPECTS_COLUMN.has(previous) || previous === '') {
    const aList = TAKES_A_LIST.has(previous) || inList(text, start);
    const conditionStarts = !aList && (previous === 'and' || previous === 'or' || previous === 'where' || previous === 'filter');
    return matches([...columns, ...(conditionStarts ? asking : [])]).map((c) => (aList ? { ...c, list: true } : c));
  }

  const previousIsColumn = table.columns.some((c) => c.name.toLowerCase() === previous);
  if (previousIsColumn) {
    const column = table.columns.find((c) => c.name.toLowerCase() === previous);
    /* An operator, or a null check — and for a date column the relative-date
       phrases, because `opened_on = last 30 days` is the single most useful
       thing you can write about a date and the least guessable. */
    /* The date test comes from core.js, which mirrors looksLikeDate in
       shared/schema.ts. Written out here it had lost `timestamp`, `datetime`
       and `deleted` from the name pattern, so `event_timestamp TEXT` was
       offered `=` and nothing else while the server was perfectly willing to
       answer `event_timestamp = last 30 days` on it — the language's best
       feature, hidden on the columns it exists for. */
    const isDate = column ? looksLikeDateColumn(column) : false;
    const dateHints = isDate ? DATE_VALUES.map((v) => ({ value: `= ${v}`, label: `= ${v}`, detail: say('dateRange'), kind: 'value' })) : [];
    const ranged = isDate || RANGEABLE.has(columnKind(column?.type ?? ''));
    const ops = [
      ...OPERATORS.filter((o) => o !== 'between' || ranged).map((o) => ({
        value: o,
        label: o,
        detail: o === 'between' ? say('aRangeBothEnds') : 'operator',
        kind: 'op',
      })),
      ...NULL_CHECKS.map((o) => ({ value: o, label: o, detail: say('nullCheck'), kind: 'op' })),
    ];
    /* On a date column the relative phrases lead. They are the most useful
       thing you can say about a date and the least guessable, whereas `=` on
       a timestamp is usually a mistake — it matches an exact instant. */
    return matches(isDate ? [...dateHints, ...ops] : ops);
  }

  // Otherwise: another condition, or a clause to finish with.
  return matches([
    ...JOINERS.map((j) => ({ value: j, label: j, detail: 'combine', kind: 'kw' })),
    ...CLAUSES.map((c) => ({ value: c, label: c, detail: 'clause', kind: 'kw' })),
    ...columns,
  ]);
}

const findTableNamed = (id) => state.schema.tables.find((t) => t.id === id);

/**
 * The table whose columns come next when the caret is inside an `any …
 * where` — right after it, or inside its parentheses — or undefined, when
 * the record's own conditions have taken over again.
 */
function insideAny(before, pointing) {
  const opened = [...before.matchAll(/\b(?:any|no)\s+([\w.$]+)(?:\s+via\s+[\w$+]+)?\s+where\s+/gi)].pop();
  if (!opened) return undefined;
  const fk = pointing.find((each) => each.from.table === opened[1] || findTableNamed(each.from.table)?.name === opened[1]);
  if (!fk) return undefined;
  const rest = before.slice((opened.index ?? 0) + opened[0].length);
  let depth = 0;
  for (const ch of rest) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
  const inside = rest.trimStart().startsWith('(') ? depth > 0 : !/\s(?:and|or)\s/i.test(` ${rest} `);
  return inside ? findTableNamed(fk.from.table) : undefined;
}

/**
 * Whether the caret sits inside a clause that is already a list.
 *
 * `show name, ` is a list whether or not the word just before the caret is
 * the comma — after `show name, ema` the previous word is `ema`'s neighbour,
 * not a comma. Looking back to the nearest clause word answers it properly.
 */
function inList(text, start) {
  const before = text.slice(0, start).toLowerCase();
  const clause = before.match(
    /\b(show|select|sort|order\s+by|where|filter|and|or)\b(?![\s\S]*\b(?:show|select|sort|order\s+by|where|filter|and|or)\b)/,
  );
  if (!clause) return false;
  return TAKES_A_LIST.has(clause[1].replace(/\s+/g, ' ') === 'order by' ? 'by' : clause[1]);
}

function update(input) {
  const caret = input.selectionStart ?? input.value.length;
  items = suggester(input.value, caret).slice(0, 30);
  if (!items.length) return close();

  box.replaceChildren();
  items.forEach((item, i) => {
    box.append(
      el(
        'div',
        {
          class: `ac-item kind-${item.kind}`,
          id: `ac-item-${i}`,
          role: 'option',
          'aria-selected': String(i === index),
          // mousedown, not click: the input's blur fires first on click and would
          // close the list before the selection landed.
          onmousedown: (e) => {
            e.preventDefault();
            accept(input, item);
          },
        },
        [el('span', { class: 'ac-label', text: item.label }), el('span', { class: 'ac-detail', text: item.detail })],
      ),
    );
  });
  index = -1;
  box.hidden = false;
  if (!box.id) box.id = 'ac-list';
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', box.id);
  input.removeAttribute('aria-activedescendant');
  if (anchor === 'caret') placeAtCaret(input, box);
}

/**
 * Put the list under the caret rather than under the field.
 *
 * In a one-line query bar those are the same place. In a ten-line SQL editor
 * they are not, and a list pinned to the bottom of the box while you type on
 * line two is a list you have to go and find.
 *
 * The position is measured by rendering the text before the caret into a
 * hidden copy of the field and reading where that copy ends — a textarea will
 * not tell you where its caret is, and every other approach to this is a
 * guess about font metrics.
 */
function placeAtCaret(input, list) {
  const style = getComputedStyle(input);
  const mirror = el('div', { class: 'ac-mirror' });
  for (const property of [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderLeftWidth',
    'whiteSpace',
    'wordWrap',
    'boxSizing',
  ]) {
    mirror.style[property] = style[property];
  }
  mirror.style.width = `${input.clientWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';

  const caret = input.selectionStart ?? input.value.length;
  mirror.textContent = input.value.slice(0, caret);
  const marker = el('span', { text: '\u200b' });
  mirror.append(marker);
  portalRoot().append(mirror);

  const field = viewportBox(input);
  const at = viewportBox(marker);
  const mirrorBox = viewportBox(mirror);
  mirror.remove();

  const lineHeight = parseFloat(style.lineHeight || '18');
  const caretTop = field.top + (at.top - mirrorBox.top) - input.scrollTop;
  const left = field.left + (at.left - mirrorBox.left);

  const view = viewportSize();
  list.style.position = 'fixed';
  list.style.left = `${Math.max(8, Math.min(left, view.width - 320))}px`;

  /* Below the caret when there is room, above it when there is not.

     The SQL editor sits at the bottom of the window, so its caret is usually
     in the lower third and a list that only ever opens downwards opens off the
     screen — which looks like a list with two items in it. Measured after the
     items are in, because the height depends on how many there are. */
  const height = list.offsetHeight;
  const below = view.height - (caretTop + lineHeight);
  list.style.top = below >= height + 12 || caretTop < height + 12 ? `${caretTop + lineHeight}px` : `${caretTop - height - 4}px`;
}

/** The run between the anchor and the cursor, inclusive. Empty when there is no range. */
function selected() {
  if (anchorIndex < 0 || anchorIndex === index) return [];
  const from = Math.min(anchorIndex, index);
  const to = Math.max(anchorIndex, index);
  return items.slice(from, to + 1);
}

function paint() {
  const from = anchorIndex < 0 ? index : Math.min(anchorIndex, index);
  const to = anchorIndex < 0 ? index : Math.max(anchorIndex, index);
  [...box.children].forEach((node, i) => {
    const inRange = i >= from && i <= to;
    node.setAttribute('aria-selected', String(inRange));
    node.classList.toggle('active', i === index);
    node.classList.toggle('picked', inRange && anchorIndex >= 0 && anchorIndex !== index);
  });
  box.children[index]?.scrollIntoView({ block: 'nearest' });
}

/**
 * Move the cursor, extending the selection when Shift is held.
 *
 * Only where a list is meaningful — `show` and `sort` take several columns,
 * a filter condition takes one. Offering a range where it cannot be used
 * would produce a selection that silently collapsed to its last item.
 */
function extend(next) {
  if (!items[0]?.list) return highlight(next);
  if (anchorIndex < 0) anchorIndex = index < 0 ? 0 : index;
  index = Math.max(0, Math.min(items.length - 1, next));
  paint();
}

function highlight(next) {
  if (!items.length) return;
  index = (next + items.length) % items.length;
  [...box.children].forEach((node, i) => {
    node.setAttribute('aria-selected', String(i === index));
    node.classList.toggle('active', i === index);
  });
  const activeNode = box.children[index];
  if (activeNode) bound?.setAttribute('aria-activedescendant', activeNode.id);
  activeNode?.scrollIntoView({ block: 'nearest' });
}

function accept(input, item) {
  acceptMany(input, [item]);
}

/**
 * Put one suggestion in, or a run of them as a comma list.
 *
 * One code path for both, because the interesting part — where the word being
 * completed starts, and whether a space is needed after it — is the same
 * either way, and the version that handled only one is the version that would
 * have kept the trailing-space rule while the other lost it.
 */
function acceptMany(input, chosen) {
  if (!chosen.length) return;
  const caret = input.selectionStart ?? input.value.length;
  const { start } = splitter(input.value, caret);
  const after = input.value.slice(caret);
  const text = chosen.map((c) => c.value).join(', ');
  const insert = text + (after.startsWith(' ') ? '' : ' ');
  input.value = input.value.slice(0, start) + insert + after;
  const next = start + insert.length;
  input.setSelectionRange(next, next);
  close();
  // Chain straight into the next suggestion: pick a table, get its columns.
  update(input);
}

function onKey(e, input) {
  if (box.hidden) {
    // Ctrl+Space opens it deliberately, for when it has closed itself.
    if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      update(input);
    }
    return;
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (e.shiftKey) extend(index + 1);
      else highlight(index + 1);
      return;
    case 'ArrowUp':
      e.preventDefault();
      if (e.shiftKey) extend(index - 1);
      else highlight(index - 1);
      return;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    case 'Tab':
      // Tab always completes — with nothing highlighted it takes the first,
      // which is what makes typing a prefix and pressing Tab work.
      e.preventDefault();
      accept(input, items[index >= 0 ? index : 0]);
      return;
    case 'Enter':
      /* Enter only completes when something is explicitly highlighted.
         Otherwise it submits, so a finished query is one keystroke away and
         does not need Escape first. */
      if (selected().length) {
        /* A range takes all of it. This is the whole point of holding Shift:
           `show` wants several columns, and taking them one at a time means
           reopening the list once per column. */
        e.preventDefault();
        acceptMany(input, selected());
        return;
      }
      if (index >= 0) {
        e.preventDefault();
        accept(input, items[index]);
      } else {
        close();
      }
      return;
    default:
  }
}
