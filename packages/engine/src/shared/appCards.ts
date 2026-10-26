/**
 * The cards presentation: a list's rows as a grid of cards, each a picture,
 * a title, one prominent figure, a few facts and a badge, the whole card
 * opening its record. What a shop window, a listing site or a catalogue
 * shows, drawn from ordinary records.
 *
 * The picture comes from one of two places, and the DSL says which by its
 * shape: a column of the row holding an image address (`image: 'photo_url'`),
 * or the first file of a related file resource (`image: { from, whose, sort }`,
 * the related list's own words). The figure and the badge wear the column's
 * display rule, so a price reads as money and a status in its tone.
 *
 * A card may also be the record a reference names, one hop away: a saved car
 * drawn as the car. Its title, figure, lines, facts and picture may each read
 * through one reference — `primary: 'vehicle_id.title'`, `value:
 * 'vehicle_id.price'`, `image: 'vehicle_id.photo_url'`, or the referenced
 * record's first file, `image: { about: 'vehicle_id', from: 'vehicle_photo',
 * whose: 'vehicle_id' }`. Each is read through the referenced table's grants:
 * a part the reader may not read is left off the card (cardsReadable).
 */
import { columnKind, labelPath, primaryKey, tableNamed, type DatabaseSchema, type TableMeta } from './schema.js';
import { LABEL_SEGMENT } from './recordLabel.js';
import { allowKeys, isRecord } from './model.js';
import { pluralOf } from './appNoun.js';
import { singularOf } from './unitWord.js';

/** The first file of a related file resource: its rows `whose` column names the card's record, first by `sort`. */
export interface AppCardsImageFrom {
  /** A reference column of the card's row: the files are the referenced record's, not the row's own. */
  about?: string;
  /** A resource whose rows are files (`file` on the resource). */
  from: string;
  /** The column of `from` that names the card's record. */
  whose: string;
  /** Which file leads, written like the query bar: "position", "added_at desc". */
  sort?: string;
}

/** A responsive grid of cards; the whole card opens its record. */
export interface AppCardsList {
  kind: 'cards';
  /** The card's title: a text column, or as authored without one `$label`, the record's name, which resolving
      the list against a catalog makes the path that name is read from (cardsTitled). */
  primary: string;
  /** A text column said under the title at the card's full width, without a caption, clamped to three lines. */
  description?: string;
  /** One prominent figure — a price, a total — dressed by the column's display rule. A one-hop path
      ("vehicle_id.price") reads it from the record a reference names. */
  value?: string;
  /** A short word in the corner, dressed by the column's tones. */
  badge?: string;
  /** A column whose display rule maps its values to icons: the card wears its value's icon beside the
      title — a ticket's channel, a part's kind — or, with `media: 'icon'`, as a tile leading the card. Only a
      mapped value draws one. */
  icon?: string;
  /** Up to four facts under the title, each under its caption. A one-hop label path ("dealer_id.name") is taken. */
  lines?: string[];
  /** Up to six values said in one line under the figure, each after a dot — "2019 · 85,780 mi · Hybrid" —
      their captions kept for assistive technology: a fields section's `facts` line, on a card. Local
      columns or one-hop label paths. */
  facts?: string[];
  /** Served from a fact written `{ column, after }`: the word said after its value — "1 owner", "3 owners" —
      or `{ column, before }`, before it ("Born Apr 24, 2017"), in place of the caption only assistive
      technology hears. By fact path. */
  factLabels?: Record<string, FactLabel>;
  /** Up to four values along the card's foot, under a hairline, written as `facts` are: what an item costs and how
      long it takes. Its labels are kept in `factLabels` beside the facts'. */
  footer?: string[];
  /** A column holding an image address — the row's, or one hop away ("vehicle_id.photo_url") — or the first file
      of a related file resource, the row's own or (`about`) the referenced record's. */
  image?: string | AppCardsImageFrom;
  /** How an image is framed. Omit or use "cover" for the card's existing picture; "avatar" makes it a portrait and falls back to the title's initials;
      "icon" leads the card with its `icon` column's mark as a tile, a catalog's laptop or headset, with no picture. */
  media?: 'cover' | 'avatar' | 'icon';
}

/** How many facts a card carries under its title. */
export const CARDS_MAX_LINES = 4;
/** How many values a card's facts line says. */
const CARDS_MAX_FACTS = 6;
/** How many values stand along a card's foot. */
const CARDS_MAX_FOOTER = 4;
const CARDS_IMAGE_KEYS = ['about', 'from', 'whose', 'sort'] as const;

/** A local column: bare, non-empty, never a path. The same rule every card presentation reads. */
function local(value: unknown, key: string, at: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('.'))
    throw new Error(`${at}: "${key}" must name a local column, not a path.`);
  return value.trim();
}

/** One sort key and its direction: "position", "added_at desc". */
export function cardsImageSort(sort: string): { column: string; direction: 'asc' | 'desc' } {
  const [column, direction = 'asc'] = sort.trim().split(/\s+/);
  return { column, direction: direction.toLowerCase() === 'desc' ? 'desc' : 'asc' };
}

/** A value the card reads off its row, or one hop away through a reference: "price", "vehicle_id.price". */
function said(value: unknown, key: string, at: string): string {
  if (typeof value !== 'string' || !LABEL_PATH.test(value.trim()))
    throw new Error(`${at}: "${key}" must name a column, or a column one reference away like "vehicle_id.price".`);
  return value.trim();
}

function parseImage(raw: unknown, at: string): string | AppCardsImageFrom {
  if (typeof raw === 'string') return said(raw, 'image', at);
  if (!isRecord(raw))
    throw new Error(
      `${at}: "image" must be a column holding an image address, or { from, whose, sort? } naming a file resource (with about, the referenced record's).`,
    );
  allowKeys(raw, CARDS_IMAGE_KEYS, `${at}, image`);
  const about = raw.about === undefined ? undefined : local(raw.about, 'about', `${at}, image`);
  if (typeof raw.from !== 'string' || !raw.from.trim()) throw new Error(`${at}, image: "from" must name a resource whose rows are files.`);
  const whose = local(raw.whose, 'whose', `${at}, image`);
  let sort: string | undefined;
  if (raw.sort !== undefined) {
    if (typeof raw.sort !== 'string' || !/^\s*[A-Za-z_][A-Za-z0-9_]*(\s+(asc|desc))?\s*$/i.test(raw.sort)) {
      throw new Error(`${at}, image: "sort" is one column and an optional direction, like "position" or "added_at desc".`);
    }
    sort = raw.sort.trim().replace(/\s+/g, ' ');
  }
  return { ...(about ? { about } : {}), from: raw.from.trim(), whose, ...(sort ? { sort } : {}) };
}

/* A said value — the title, the figure, a line, a fact or the picture — may also be a one-hop label path:
   "dealer_id.name" says who sells the car, and the list's query already reads such a path. The badge, the
   icon and the description stay the row's own. */
const LABEL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/* A fact is a path, or `{ column, after }` — the path and the word said after its value, a figure's word made
   plural by rule where it is not 1 — or `{ column, before }`, the word said in front of it. An `after` that is a
   `msg()` with a plural in it reaches the parser said as `{ one, many }`, a plural no rule makes, as a noun's is. */
/** A fact's own word: after its value ("3 beds", plural by the value), or before it ("Born Apr 24, 2017"). */
/** A fact's word. `many` is the author's plural; absent, a word after a bare count agrees with it by rule
    ("3 beds") and any other figure — money, a percent, a figure with a unit — keeps the word as written. */
export interface FactLabel {
  one: string;
  many?: string;
  position?: 'before';
}

export function parseFacts(
  raw: unknown,
  at: string,
  key: 'facts' | 'footer' = 'facts',
  max = CARDS_MAX_FACTS,
): Pick<AppCardsList, 'facts' | 'factLabels'> {
  const shape =
    `${at}: "${key}" must be one to ${max} columns or one-hop label paths, said in one line — ` +
    "each a path, or { column, after } to say a word after its value, like { column: 'owners', after: 'owner' }, " +
    "or { column, before } to say it before, like { column: 'born_on', before: 'Born' }.";
  if (!Array.isArray(raw) || !raw.length || raw.length > max) throw new Error(shape);
  const facts: string[] = [];
  const factLabels: Record<string, FactLabel> = {};
  for (const entry of raw) {
    if (typeof entry === 'string' && LABEL_PATH.test(entry.trim())) {
      facts.push(entry.trim());
      continue;
    }
    if (!isRecord(entry) || typeof entry.column !== 'string' || !LABEL_PATH.test(entry.column.trim())) throw new Error(shape);
    allowKeys(entry, ['column', 'before', 'after'], `${at}, ${key}`, {
      label: 'is now "after" (a word after the value) or "before" (a word before it)',
      position: 'is gone: "before" is a word before the value, "after" a word after it',
    });
    const path = entry.column.trim();
    const word = (value: unknown, which: 'before' | 'after') => {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 40) {
        throw new Error(`${at}: the fact "${path}" has a "${which}" that is not a word of at most 40 characters.`);
      }
      return value.trim();
    };
    if (entry.before !== undefined && entry.after !== undefined)
      throw new Error(`${at}: the fact "${path}" has both "before" and "after"; a fact says its word on one side of the value.`);
    if (entry.before === undefined && entry.after === undefined)
      throw new Error(`${at}: the fact "${path}" says no word; write the path alone, or give it a "before" or an "after".`);
    let label: FactLabel;
    if (entry.before !== undefined) label = { one: word(entry.before, 'before'), position: 'before' };
    else if (isRecord(entry.after)) {
      allowKeys(entry.after, ['one', 'many'], `${at}, facts "${path}" after`);
      label = { one: word(entry.after.one, 'after'), many: word(entry.after.many, 'after') };
    } else {
      /* A word after a count agrees with it ("3 beds"), which factWord says as the
         value is drawn: only a count does. "$18,400 left to pay" is not "left to pays". */
      label = { one: word(entry.after, 'after') };
    }
    facts.push(path);
    Object.defineProperty(factLabels, path, { value: label, enumerable: true, configurable: true, writable: true });
  }
  if (new Set(facts).size !== facts.length) throw new Error(`${at}: "${key}" names a column twice.`);
  return { facts, ...(Object.keys(factLabels).length ? { factLabels } : {}) };
}

/**
 * The word a fact's label says beside this value, or undefined where the value already says it. A word before a
 * value is a caption ("Floor 3"). After one, the author's `{ one, many }` agrees with any figure; a word written
 * once agrees only with a bare count ("3 beds"), since a figure the display rule dresses — money, a percent, a
 * duration, a unit — is not a count of the word ("$18,400 left to pay"). A word that repeats the rule's unit is
 * left out: the figure said it ("48,341 mi", never "48,341 mi mis").
 */
export function factWord(
  label: FactLabel,
  value: unknown,
  rule?: { format?: string; unit?: string; bar?: boolean } | null,
): string | undefined {
  if (label.position === 'before' && label.many === undefined) return label.one;
  const unit = rule?.unit?.replace(/^\//, '').trim().toLowerCase();
  if (unit && (label.one.toLowerCase() === unit || label.many?.toLowerCase() === unit)) return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  const many = Number.isFinite(n) && n !== 1;
  if (label.many !== undefined) return many ? label.many : label.one;
  const counted = !rule?.unit && !rule?.bar && (rule?.format === undefined || rule.format === 'number');
  return counted && Number.isFinite(n) ? countWord(label.one, many) : label.one;
}

/* A word written once, agreed with a count by the shared rule (unitWord.ts): a phrase agrees by the word written
   in the plural ("tickets logged" → "1 ticket logged"), a single word written singular is made plural ("bed" →
   "3 beds"), and a phrase with no plural in it is said as written ("left to pay"), since no rule knows which of
   its words counts. Never an "s" on the last word: "0 tickets loggeds" was. */
function countWord(phrase: string, many: boolean): string {
  const words = phrase.split(/\s+/);
  const at = words.findIndex((word) => singularOf(word) !== undefined);
  if (at >= 0) return many ? phrase : words.map((word, i) => (i === at ? singularOf(word) : word)).join(' ');
  return many && words.length === 1 ? pluralOf(phrase) : phrase;
}

/** The cards presentation as written: the shape only, judged against a catalog by cardsProblem. */
export function parseCards(raw: Record<string, unknown>, at: string, primary: string, lines: string[]): AppCardsList {
  const value = raw.value === undefined ? undefined : said(raw.value, 'value', at);
  const description = raw.description === undefined ? undefined : local(raw.description, 'description', at);
  const badge = raw.badge === undefined ? undefined : local(raw.badge, 'badge', at);
  const icon = raw.icon === undefined ? undefined : local(raw.icon, 'icon', at);
  const image = raw.image === undefined ? undefined : parseImage(raw.image, at);
  const media = raw.media;
  if (media !== undefined && media !== 'cover' && media !== 'avatar' && media !== 'icon') {
    throw new Error(`${at}: "media" must be "cover", "avatar" or "icon".`);
  }
  /* An icon tile is the card's lead in place of a picture: the mark its icon column's rule gives each value. */
  if (media === 'icon' && icon === undefined)
    throw new Error(`${at}: "media: 'icon'" leads the card with its "icon" column's mark; name the column, like icon: 'kind'.`);
  if (media === 'icon' && image !== undefined)
    throw new Error(`${at}: "media: 'icon'" leads the card with an icon tile, and "image" with a picture; a card has one lead.`);
  const facts = raw.facts === undefined ? undefined : parseFacts(raw.facts, at);
  /* The foot's values, written as facts are; their words kept with the facts', so a value is said in one place. */
  const foot = raw.footer === undefined ? undefined : parseFacts(raw.footer, at, 'footer', CARDS_MAX_FOOTER);
  const twice = foot?.facts?.find((path) => facts?.facts?.includes(path));
  if (twice) throw new Error(`${at}: "${twice}" is in "facts" and in "footer"; a card says a value once.`);
  const factLabels = facts?.factLabels || foot?.factLabels ? { ...facts?.factLabels, ...foot?.factLabels } : undefined;
  return {
    kind: 'cards',
    primary,
    ...(description ? { description } : {}),
    ...(value ? { value } : {}),
    ...(badge ? { badge } : {}),
    ...(icon ? { icon } : {}),
    ...(lines.length ? { lines } : {}),
    ...(facts?.facts ? { facts: facts.facts } : {}),
    ...(foot?.facts ? { footer: foot.facts } : {}),
    ...(factLabels ? { factLabels } : {}),
    ...(image === undefined ? {} : { image }),
    ...(media === 'cover' || media === 'avatar' || media === 'icon' ? { media } : {}),
  };
}

/**
 * A card titled by its record's name, as this catalog names it: the
 * resource's recordLabel — a template computed as `$label`, a column, a path
 * through a reference — or the name the catalog finds without one
 * (schema.ts labelPath), else the key. A card with a title of its own, or a
 * `$label` this catalog serves, is as it was.
 */
export function cardsTitled(list: AppCardsList, table: TableMeta, schema: DatabaseSchema, recordLabel?: string | false): AppCardsList {
  if (list.primary !== LABEL_SEGMENT || table.labelTemplate) return list;
  const named = labelPath(schema, table, recordLabel);
  return { ...list, primary: named && named !== LABEL_SEGMENT ? named : (primaryKey(table)[0] ?? list.primary) };
}

/** The row's own columns a card reads, so the list's query fetches them beside the keys. */
export function cardsColumns(list: AppCardsList): string[] {
  return [
    ...new Set([
      list.primary,
      ...(list.description ? [list.description] : []),
      ...(list.value ? [list.value] : []),
      ...(list.badge ? [list.badge] : []),
      ...(list.icon ? [list.icon] : []),
      ...(list.lines ?? []),
      ...(list.facts ?? []),
      ...(list.footer ?? []),
      ...(typeof list.image === 'string' ? [list.image] : []),
      // The reference whose record's first file is the picture: its value names the record the files are asked by.
      ...(typeof list.image === 'object' && list.image.about ? [list.image.about] : []),
    ]),
  ];
}

/** A rollup of the row's own table, read like a column (rollups.ts). */
const ownRollup = (table: TableMeta, name: string) =>
  Boolean(table.rollups && Object.hasOwn(table.rollups, name)) || Boolean(table.computed && Object.hasOwn(table.computed, name));

/** The table a one-column reference of `table` names, and the reference, in this catalog. */
function referenced(schema: DatabaseSchema, table: TableMeta, column: string) {
  const fk = schema.foreignKeys.find(
    (candidate) => candidate.from.table === table.id && candidate.from.columns.length === 1 && candidate.from.columns[0] === column,
  );
  return fk ? { fk, target: schema.tables.find((candidate) => candidate.id === fk.to.table) } : undefined;
}

/** A said value against the catalog: the row's own column or rollup, or a reference and a column or rollup of its target. */
function saidProblem(name: string, key: string, table: TableMeta, schema?: DatabaseSchema, text = false): string | undefined {
  const [head, tail] = name.split('.');
  if (!tail)
    return table.columns.some((column) => column.name === head) || ownRollup(table, head)
      ? undefined
      : `Cards ${key}: "${name}" must be a readable column.`;
  if (!schema) return undefined;
  const hop = referenced(schema, table, head);
  if (!hop) return `Cards ${key}: "${head}" in "${name}" is not a reference of "${table.name}".`;
  const { fk, target } = hop;
  const column = target?.columns.find((candidate) => candidate.name === tail);
  if (!target || (!column && !ownRollup(target, tail))) return `Cards ${key}: "${target?.name ?? fk.to.table}" has no column "${tail}".`;
  if (text && (!column || columnKind(column.type) !== 'text')) return `Cards ${key} must be a text column; "${name}" is not.`;
  return undefined;
}

/** The parts of the card that read through a reference, by where they are said: what cardsReadable may leave off. */
function throughReference(list: AppCardsList): Array<[string, string]> {
  return [
    ...(list.value?.includes('.') ? [['value', list.value] as [string, string]] : []),
    ...(typeof list.image === 'string' && list.image.includes('.') ? [['image', list.image] as [string, string]] : []),
    ...(list.lines ?? []).flatMap((line, i): Array<[string, string]> => (line.includes('.') ? [[`properties[${i}]`, line]] : [])),
    ...(list.facts ?? []).flatMap((fact, i): Array<[string, string]> => (fact.includes('.') ? [[`facts[${i}]`, fact]] : [])),
    ...(list.footer ?? []).flatMap((fact, i): Array<[string, string]> => (fact.includes('.') ? [[`footer[${i}]`, fact]] : [])),
  ];
}

/**
 * The cards as one reader's catalog can draw them: a figure, a picture, a
 * line or a fact read through a reference that this reader may not read —
 * the referenced table, or that column of it — is left off the card, and
 * the card stands without it, as a calendar's span does. The title is the
 * card: a title the reader cannot read is the cardsProblem it always was.
 */
export function cardsReadable(list: AppCardsList, table: TableMeta, schema: DatabaseSchema, files?: ReadonlySet<string>): AppCardsList {
  const unread = new Set(
    throughReference(list)
      .filter(([key, name]) => saidProblem(name, key, table, schema, key === 'image'))
      .map(([, name]) => name),
  );
  const image = list.image;
  const fileGone = typeof image === 'object' && image.about !== undefined && Boolean(imageProblem(image, table, schema, files));
  if (!unread.size && !fileGone) return list;
  const { value, image: _image, lines, facts, footer, factLabels, ...rest } = list;
  const keptFacts = facts?.filter((fact) => !unread.has(fact));
  const keptFooter = footer?.filter((fact) => !unread.has(fact));
  const keptLines = lines?.filter((line) => !unread.has(line));
  const labels = factLabels && Object.fromEntries(Object.entries(factLabels).filter(([fact]) => !unread.has(fact)));
  return {
    ...rest,
    ...(value !== undefined && !unread.has(value) ? { value } : {}),
    ...(image !== undefined && !fileGone && !(typeof image === 'string' && unread.has(image)) ? { image } : {}),
    ...(keptLines?.length ? { lines: keptLines } : {}),
    ...(keptFacts?.length ? { facts: keptFacts } : {}),
    ...(keptFooter?.length ? { footer: keptFooter } : {}),
    ...(labels && Object.keys(labels).length ? { factLabels: labels } : {}),
  };
}

/** A picture from a file resource against the catalog: the row's own files, or (`about`) the referenced record's. */
function imageProblem(image: AppCardsImageFrom, table: TableMeta, schema: DatabaseSchema, files?: ReadonlySet<string>): string | undefined {
  let owner = table;
  if (image.about !== undefined) {
    const hop = referenced(schema, table, image.about);
    if (!hop) return `Cards image: "about" names "${image.about}", which is not a reference of "${table.name}".`;
    if (!hop.target) return `Cards image: "${image.about}" names "${hop.fk.to.table}", which is not readable here.`;
    owner = hop.target;
  }
  const from = tableNamed(schema, image.from);
  if (!from) return `Cards image: this connection has no table "${image.from}".`;
  if (files && !files.has(from.id)) return `Cards image: "${image.from}" is not a resource whose rows are files; declare "file" on it.`;
  const whose = from.columns.find((column) => column.name === image.whose);
  if (!whose) return `Cards image: "${from.name}" has no column "${image.whose}".`;
  const fk = schema.foreignKeys.find(
    (candidate) =>
      candidate.from.table === from.id &&
      candidate.to.table === owner.id &&
      candidate.from.columns.length === 1 &&
      candidate.from.columns[0] === whose.name,
  );
  if (!fk) return `Cards image: "${from.name}.${whose.name}" does not reference "${owner.name}".`;
  /* The row's reference and the files' must name the same key of that record, or the files asked by its value are another's. */
  if (image.about !== undefined && referenced(schema, table, image.about)!.fk.to.columns[0] !== fk.to.columns[0])
    return `Cards image: "${table.name}.${image.about}" and "${from.name}.${whose.name}" name different keys of "${owner.name}".`;
  if (image.sort) {
    const { column } = cardsImageSort(image.sort);
    if (!from.columns.some((candidate) => candidate.name === column))
      return `Cards image: "${from.name}" has no column "${column}" to sort by.`;
  }
  return undefined;
}

/**
 * The cards against the readable catalog. `files` is the tables whose rows
 * are files (the App's resolved `file` rules), for an image drawn from one;
 * absent, only the row's own columns are judged.
 */
export function cardsProblem(
  list: AppCardsList,
  table: TableMeta,
  schema?: DatabaseSchema,
  files?: ReadonlySet<string>,
  icons?: (column: string) => boolean,
): string | undefined {
  if (!table.columns.some((column) => column.primaryKey)) return 'Cards require a complete readable primary key.';
  if (list.icon !== undefined) {
    if (!table.columns.some((column) => column.name === list.icon)) return `Cards icon: "${list.icon}" must be a local readable column.`;
    /* The icon is the value's mark as the display rule draws it everywhere else; a card has no vocabulary of its own. */
    if (icons && !icons(list.icon))
      return `Cards icon: "${list.icon}" has no icons to draw; map its values in the resource's display rule (display.${list.icon}.icons).`;
  }
  const said: Array<[string, string]> = [
    ...(list.lines ?? []).map((line, i): [string, string] => [`properties[${i}]`, line]),
    ...(list.facts ?? []).map((name, i): [string, string] => [`facts[${i}]`, name]),
    ...(list.footer ?? []).map((name, i): [string, string] => [`footer[${i}]`, name]),
    ...(list.value?.includes('.') ? [['value', list.value] as [string, string]] : []),
  ];
  for (const [key, name] of said) {
    const problem = saidProblem(name, key, table, schema);
    if (problem) return problem;
  }
  if (typeof list.image === 'string' && list.image.includes('.')) {
    const problem = saidProblem(list.image, 'image', table, schema, true);
    if (problem) return problem;
  }
  /* A title read from the record's name is the catalog's own path: a computed `$label` or a reference's name. */
  const titled = list.primary === LABEL_SEGMENT || list.primary.includes('.');
  if (titled && list.primary !== LABEL_SEGMENT) {
    const problem = saidProblem(list.primary, 'primary', table, schema);
    if (problem) return problem;
  }
  const named: Array<[string, string]> = [
    ...(titled ? [] : [['primary', list.primary] as [string, string]]),
    ...(list.value && !list.value.includes('.') ? [['value', list.value] as [string, string]] : []),
    ...(list.badge ? [['badge', list.badge] as [string, string]] : []),
    ...(list.description ? [['description', list.description] as [string, string]] : []),
    ...(typeof list.image === 'string' && !list.image.includes('.') ? [['image', list.image] as [string, string]] : []),
  ];
  for (const [key, name] of named) {
    const column = table.columns.find((candidate) => candidate.name === name);
    // The figure and the badge may be a rollup: a SKU's stock, a board's threads.
    if (!column && (key === 'value' || key === 'badge') && ownRollup(table, name)) continue;
    if (!column) return `Cards ${key}: "${name}" must be a local readable column.`;
    if ((key === 'primary' || key === 'image' || key === 'description') && columnKind(column.type) !== 'text')
      return `Cards ${key} must be a text column.`;
  }
  const image = list.image;
  if (typeof image === 'object' && image.about !== undefined && !table.columns.some((column) => column.name === image.about))
    return `Cards image: "about" names "${image.about}", which is not a readable column of "${table.name}".`;
  if (typeof image !== 'object' || !schema) return undefined;
  return imageProblem(image, table, schema, files);
}
