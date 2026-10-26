/**
 * What a public page says in words, for whoever reads the HTML and not the
 * running page: a search engine, a link preview, a reader without scripts.
 *
 * A signed-out visitor's list or record (`auth.public`) was one static shell
 * until the client had booted, so a crawler that does not run scripts, and
 * every link preview, saw the App's name and nothing else. Here the server
 * reads the room the way publicHead.ts reads its title — under the public
 * grant alone, through the same scoped read path a public `/api/run`
 * takes, so the App's table and field grants and its row policy decide
 * exactly as they would for the browser — and says it as a small document:
 * the list's cards (title, figure, facts, lead photo, the record's
 * canonical address) or the record's facts and photos. The page's
 * description and preview image come from the same reads.
 *
 * Only what the reader could read is said, and only as text: formatting is
 * Intl's, in the App's locale and currency. The document is drawn by the
 * public renderer (client ssr/render.tsx) and replaced by the App's own room
 * when it boots (clientHttp.ts says how, without moving anything).
 */
import { primaryKey, labelPath, findTable, columnKind, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { addressSlug, appAddressBook, recordSegments, type AddressBook } from '../../shared/appAddress.js';
import { type AppDisplayRule } from '../../shared/appModel.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { viewOrder, zonedNow } from '../../shared/app.js';
import { appZone } from '../../shared/appZone.js';
import type { AppCardsImageFrom, AppCardsList } from '@mistriwork/engine/shared/appCards.js';
import { cardsImageSort } from '@mistriwork/engine/shared/appCards.js';
import { appListQuery } from '@mistriwork/engine/shared/listQuestion.js';
import { quoteValue } from '@mistriwork/engine/shared/query.js';
import { dispatchResourceReadHttp } from '@mistriwork/engine/server/resourceReadHttp.js';
import { APP_READS } from '../app/appReads.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import type { ResolvedSource } from '@mistriwork/engine/server/http/context.js';
import type { PublicFact, PublicImage, PublicItem, PublicRoom } from '../../shared/publicDocument.js';
import { unitWord } from '@mistriwork/engine/shared/unitWord.js';
import { pictureKey, type PictureDetails } from './publicPictures.js';

/** What one public address says beyond its title: the room, its description and its preview picture. */
export interface PublicPage {
  room?: PublicRoom;
  description?: string;
  image?: PublicImage;
}

/** What the reads need: the source as this visitor resolved it, the App as served to them, and the address book. */
export interface PublicReading {
  source: ResolvedSource;
  app: AppPayloadApp;
  schema: DatabaseSchema;
  book: AddressBook;
  /** An inside address (`/{app}/vehicles/12-…`) as the browser shows it. */
  outward: (inside: string) => string;
  /** A server path (`/api/file?…`) where this server answers it: under the base path, when there is one. */
  served: (path: string) => string;
  /** The hash and room of a file resource's pictures, by `pictureKey` (publicPictures.ts); absent where nothing is known. */
  pictures?: (table: TableMeta, rows: Row[]) => Promise<Map<string, PictureDetails>>;
}

/* A list's first screen: what a crawler needs to find every record is the sitemap's, not this page's. */
const LIST_ROWS = 24;
const RECORD_FACTS = 16;
const RECORD_PHOTOS = 6;

type Row = Record<string, unknown>;

async function run(reading: PublicReading, q: string, limit: number): Promise<Row[] | undefined> {
  const reply = await dispatchResourceReadHttp('/api/run', { q, limit, offset: 0, count: 'none' }, reading.source.adapter, reading.schema, {
    app: APP_READS,
    // The App's wall clock, as a member's list reads it: a public route's `starts_on >= today` is the App's day.
    now: () => zonedNow(appZone(reading.app.ui, reading.source.zone), clockNow()),
  });
  const body = reply?.status === 200 ? (reply.body as { rows?: Row[]; errors?: unknown[] }) : undefined;
  return body && !body.errors?.length ? body.rows : undefined;
}

/** A value as the App says it, in words: its vocabulary, money, a number with its unit, a percent, a date. */
function said(rule: AppDisplayRule | undefined, value: unknown, ui: AppPayloadApp['ui']): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'object') return undefined;
  const text = String(value);
  const values = (rule as { values?: Record<string, string> } | undefined)?.values;
  if (values && Object.hasOwn(values, text)) return values[text];
  const unit = (rule as { unit?: string } | undefined)?.unit;
  const locale = (ui as { locale?: string }).locale;
  const n = Number(value);
  const safe = typeof value !== 'boolean' && text.trim() !== '' && Number.isFinite(n) && Number.isSafeInteger(Math.trunc(n));
  const withUnit = (figure: string) =>
    unit ? (unit.startsWith('/') ? `${figure}${unit}` : `${figure} ${unitWord(figure, unit)}`) : figure;
  try {
    if (rule?.format === 'money' && safe) {
      const currency = (rule as { currency?: string }).currency ?? (ui as { currency?: string }).currency ?? 'USD';
      /* As the client says one figure (valueModel.ts moneyText): to the cent where it has cents, else whole, so a
         SQLite numeric(10,2) read back as "22495.00" is "$22,495". */
      return withUnit(
        new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          ...(Math.round(n * 100) % 100 ? {} : { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
        }).format(n),
      );
    }
    if (rule?.format === 'percent' && safe) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n)}%`;
    if (rule?.format === 'items') return text.split(/\r?\n/).filter(Boolean).join(', ');
    if ((rule?.format === 'number' || unit) && safe) return withUnit(new Intl.NumberFormat(locale).format(n));
  } catch {
    /* An unknown currency or locale: said as stored. */
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return withUnit(text);
}

function captionOf(app: AppPayloadApp, table: string, path: string): string {
  const own = app.resources[table]?.labels?.[path];
  return own ?? humanName(path.includes('.') ? path.split('.')[0].replace(/_id$/, '') : path);
}

function ruleOf(app: AppPayloadApp, schema: DatabaseSchema, table: string, path: string): AppDisplayRule | undefined {
  if (!path.includes('.')) return app.resources[table]?.display?.[path];
  /* One hop: the referenced table's own rule for the column. */
  const [reference, column] = path.split('.');
  const target = findTable(schema, table)?.columns.find((c) => c.name === reference)?.references?.table;
  return target ? app.resources[target]?.display?.[column] : undefined;
}

/** The App's addresses as this reader is served them (client publicAddress.ts builds the same book from the same payload). */
export function publicAddressBook(app: AppPayloadApp, schema: DatabaseSchema): AddressBook {
  return appAddressBook({
    views: app.views as never,
    order: viewOrder(app),
    resources: app.resources,
    pages: app.pages ?? [],
    tables: schema.tables,
    inbox: app.inbox === true,
    assistant: app.assistant?.page === true,
    projected: true,
  });
}

/** A record's canonical address, as the browser shows it. */
export function recordHref(reading: PublicReading, table: TableMeta, row: Row, label: string | undefined): string | undefined {
  const key = primaryKey(table);
  if (!key.length || key.some((column) => row[column] === null || row[column] === undefined)) return undefined;
  const route = reading.book.records.get(table.id);
  const segments = recordSegments(reading.book, table.id, {
    key: Object.fromEntries(key.map((column) => [column, row[column]])),
    natural: route?.column ? row[route.column] : undefined,
    slug: addressSlug(label),
  });
  return segments ? reading.outward(`/${encodeURIComponent(reading.app.id)}/${segments.join('/')}`) : undefined;
}

/** A file row's picture address, as the client writes it (cardsModel.ts inlineFileAddress), in its inside form. */
function fileImage(reading: PublicReading, table: TableMeta, row: Row, alt: string, details?: Map<string, PictureDetails>): PublicImage {
  const key = Object.fromEntries(primaryKey(table).map((column) => [column, row[column]]));
  const known = details?.get(pictureKey(table, row));
  return {
    src: reading.served(
      `/api/file?${new URLSearchParams({ table: table.id, key: JSON.stringify(key), inline: '1', variant: 'thumb', ...(known?.hash ? { h: known.hash } : {}) })}`,
    ),
    alt,
    ...(known?.room ? { width: known.room.width, height: known.room.height, color: known.room.color } : {}),
  };
}

/**
 * The lead picture of each owner, from the file resource a card names: one
 * read for the page, sorted by owner and then the author's order, so the
 * first row seen for an owner is its lead (as CardsList.tsx useLeadFiles).
 */
async function leadImages(reading: PublicReading, image: AppCardsImageFrom, owners: unknown[], most: number): Promise<Map<string, Row[]>> {
  const found = new Map<string, Row[]>();
  const from = findTable(reading.schema, image.from);
  const keys = from ? primaryKey(from) : [];
  const present = owners.filter((value) => value !== null && value !== undefined);
  if (!from || !keys.length || !present.length || !from.columns.some((c) => c.name === image.whose)) return found;
  const sort = image.sort ? cardsImageSort(image.sort) : undefined;
  const q = `${from.id} ${image.whose} in (${present.map(quoteValue).join(', ')}) sort ${image.whose}${sort ? `, ${sort.column} ${sort.direction}` : ''} show ${[...new Set([...keys, image.whose])].join(', ')}`;
  for (const row of (await run(reading, q, 500)) ?? []) {
    const owner = String(row[image.whose]);
    const list = found.get(owner) ?? [];
    if (list.length < most) list.push(row);
    found.set(owner, list);
  }
  return found;
}

/** The first card presentation in the App that draws this table's photos from a file resource: where a record's pictures come from. */
function imageSourceFor(app: AppPayloadApp, table: string): AppCardsImageFrom | undefined {
  for (const view of Object.values(app.views)) {
    const list = view as { table?: string; presentation?: AppCardsList };
    const image = list.presentation?.kind === 'cards' ? list.presentation.image : undefined;
    if (list.table === table && image && typeof image === 'object' && !image.about) return image;
  }
  return undefined;
}

/** A list's first screen, as cards: its first tab, unrefined (the address carried nothing else). */
export async function listPage(reading: PublicReading, viewKey: string, tab: number): Promise<PublicPage | undefined> {
  const { app, schema } = reading;
  const view = app.views[viewKey] as
    | (Parameters<typeof appListQuery>[1] & { label?: string; presentation?: { kind?: string } & Partial<AppCardsList> })
    | undefined;
  const table = view?.table ? findTable(schema, view.table) : undefined;
  if (!view || !table || !view.label) return undefined;
  const kind = view.presentation?.kind;
  if (kind && kind !== 'cards') return { room: { kind: 'list', title: view.label, items: [] } };
  const rows = await run(reading, appListQuery({ schema, resources: app.resources }, view, tab), LIST_ROWS);
  if (!rows) return undefined;
  const cards = kind === 'cards' ? (view.presentation as AppCardsList) : undefined;
  const label = cards?.primary ?? labelPath(schema, table, app.resources[table.id]?.recordLabel);
  const image = cards && typeof cards.image === 'object' ? cards.image : undefined;
  const ownerColumn = image ? (image.about ?? primaryKey(table)[0]) : undefined;
  const leads =
    image && ownerColumn
      ? await leadImages(
          reading,
          image,
          rows.map((row) => row[ownerColumn]),
          1,
        )
      : new Map<string, Row[]>();
  const fileTable = image ? findTable(schema, image.from) : undefined;
  const details =
    fileTable && reading.pictures
      ? await reading.pictures(
          fileTable,
          [...leads.values()].flatMap((rows) => rows.slice(0, 1)),
        )
      : undefined;
  const facts = cards?.facts ?? cards?.lines ?? [];
  const items: PublicItem[] = [];
  for (const row of rows) {
    const title = label ? said(undefined, row[label], app.ui) : undefined;
    const href = recordHref(reading, table, row, title);
    if (!href) continue;
    const lead = ownerColumn ? leads.get(String(row[ownerColumn]))?.[0] : undefined;
    items.push({
      href,
      title:
        title ??
        primaryKey(table)
          .map((column) => String(row[column]))
          .join(' · '),
      ...(cards?.value ? { value: said(ruleOf(app, schema, table.id, cards.value), row[cards.value], app.ui) } : {}),
      ...(cards?.badge ? { badge: said(ruleOf(app, schema, table.id, cards.badge), row[cards.badge], app.ui) } : {}),
      facts: facts
        .map((path) => ({ label: captionOf(app, table.id, path), text: said(ruleOf(app, schema, table.id, path), row[path], app.ui) }))
        .filter((fact): fact is PublicFact => fact.text !== undefined),
      ...(cards?.description && typeof row[cards.description] === 'string' ? { description: String(row[cards.description]) } : {}),
      ...(lead && fileTable ? { image: fileImage(reading, fileTable, lead, title ?? '', details) } : {}),
    });
  }
  const first = items.find((item) => item.image)?.image;
  return {
    room: { kind: 'list', title: view.label, items },
    description: items
      .slice(0, 3)
      .map((item) => [item.title, item.value].filter(Boolean).join(', '))
      .join('; '),
    ...(first ? { image: first } : {}),
  };
}

/* What a record's document leaves out: keys, files' bytes, anything not text-like. */
const quiet = (column: { name: string; type: string; primaryKey: boolean }) =>
  column.primaryKey ||
  !['number', 'boolean', 'date', 'text'].includes(columnKind(column.type)) ||
  /json|blob|bytea|binary/i.test(column.type);

/** One record: its facts in the App's captions, its first long text as its description, and its photos. */
export async function recordPage(
  reading: PublicReading,
  table: TableMeta,
  key: Record<string, unknown>,
  name: string,
  up?: { href: string; label: string },
): Promise<PublicPage | undefined> {
  const { app, schema } = reading;
  const resource = app.resources[table.id];
  const label = labelPath(schema, table, resource?.recordLabel);
  const paths: string[] = [];
  for (const column of table.columns) {
    if (quiet(column) || column.name === label) continue;
    const target = column.references ? findTable(schema, column.references.table) : undefined;
    const named = target ? labelPath(schema, target, app.resources[target.id]?.recordLabel) : undefined;
    // A reference says the record it names, by that record's label, where the reader may read it.
    if (column.references) {
      if (named && !named.includes('.')) paths.push(`${column.name}.${named}`);
      continue;
    }
    paths.push(column.name);
  }
  const shown = paths.slice(0, RECORD_FACTS * 2);
  const where = Object.entries(key)
    .map(([column, value]) => `${column} = ${quoteValue(value)}`)
    .join(' and ');
  const rows = shown.length ? await run(reading, `${table.id} ${where} show ${[...primaryKey(table), ...shown].join(', ')}`, 2) : [];
  if (!rows || rows.length > 1) return undefined;
  const row = rows[0] ?? {};
  const facts: PublicFact[] = [];
  let description: string | undefined;
  for (const path of shown) {
    const value = row[path];
    const rule = ruleOf(app, schema, table.id, path);
    if (!description && typeof value === 'string' && value.length > 80 && !rule?.format) {
      description = value;
      continue;
    }
    const text = said(rule, value, app.ui);
    if (text !== undefined && text.length <= 200 && facts.length < RECORD_FACTS)
      facts.push({ label: captionOf(app, table.id, path), text });
  }
  const source = imageSourceFor(app, table.id);
  const files = source ? findTable(schema, source.from) : undefined;
  const photos =
    source && files ? ((await leadImages(reading, source, [key[primaryKey(table)[0]]], RECORD_PHOTOS)).values().next().value ?? []) : [];
  const details = files && reading.pictures ? await reading.pictures(files, photos) : undefined;
  const images = files ? photos.map((photo, index) => fileImage(reading, files, photo, index ? '' : name, details)) : [];
  return {
    room: { kind: 'record', title: name, facts, ...(description ? { description } : {}), images, ...(up ? { up } : {}) },
    description:
      description ??
      facts
        .slice(0, 4)
        .map((fact) => `${fact.label}: ${fact.text}`)
        .join(' · '),
    ...(images[0] ? { image: images[0] } : {}),
  };
}
