/**
 * A list's rows as cards: a picture at a fixed ratio, the title, one
 * prominent figure, a few facts under their captions and a badge. The whole
 * card opens its record — the title is the one button, stretched over the
 * card, so the card is one tab stop with the house focus ring. One to four
 * columns, by the room's width rather than the window's: a card list in a
 * peek or a split pane reads as a phone would.
 *
 * The picture is a column holding an image address, or the first file of a
 * related file resource, asked once for every card on the page and drawn
 * inline through the file route. Images load lazily into boxes that already
 * have their size, so nothing moves as they arrive. A configured image that
 * is missing shows a placeholder; a card without image configuration starts
 * with its text.
 */
import { useMessageLanguage } from './useMessageLanguage.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, columnDisplay, columnLabel, findTable, keyOf, openRecord, quote, state } from '../core.js';
import { opensRecord } from '../recordIntent.js';
import type { TrailList } from '../recordTrail.js';
import { ownedBy } from '../requestIdentity.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { cardsImageSort, factWord, type AppCardsList } from '@mistriwork/engine/shared/appCards.js';
import { Value } from './Value.js';
import { centsAmong, dressFor, hueOf, initialsOf, maskedText, type DisplayRule } from './valueModel.js';
import { Icon, type IconName } from './Icon.js';
import { useListOrder, type ListOrder } from './useListOrder.js';
import { useChangedRows } from '../liveState.js';
import { useListRef, useRowWindow } from './useRowWindow.js';
import { namedCell } from './listColumn.js';
import { say } from '../copy/lists/components/CardsList.js';
import { served } from '../addressMount.js';
import { CARD_IMAGE_SIZES, imageSources, imageFallbackSet } from '@mistriwork/engine/shared/imageWidths.js';
import { inlineFileAddress } from './cardsModel.js';

/** An image address a card may draw: https, or a path on this server. Never data:, javascript: or a protocol-relative host. */
export function cardImageAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return /^https:\/\/[^\s]+$/i.test(text) || /^\/(?!\/)[^\s]*$/.test(text) ? text : undefined;
}

const literal = (value: unknown) => (typeof value === 'number' ? String(value) : quote(String(value)));

/**
 * The lead file of each card's record, when the picture comes from a file
 * resource: one question for the whole page, sorted by the owning record and
 * then the author's order, so the first row seen for a record is its lead.
 * With `about`, the files are the record that reference names (a saved car's
 * car), asked by the reference's value on each row.
 */
function useLeadFiles(
  table: TableMeta,
  spec: AppCardsList,
  rows: Array<Record<string, unknown>>,
): (row: Record<string, unknown>) => string | undefined {
  const image = typeof spec.image === 'object' ? spec.image : undefined;
  const from = image ? (findTable(image.from) as TableMeta | undefined) : undefined;
  const connection = state.activeConnection ?? null;
  const foreignKeys = (state.schema?.foreignKeys ?? []) as Array<{
    from: { table: string; columns: string[] };
    to: { table: string; columns: string[] };
  }>;
  /* The record the files belong to: the row's own, or the one its `about` reference names. */
  const owner = image?.about
    ? foreignKeys.find((fk) => fk.from.table === table.id && fk.from.columns.length === 1 && fk.from.columns[0] === image.about)?.to.table
    : table.id;
  const reference =
    image && from && owner
      ? foreignKeys.find(
          (fk) => fk.from.table === from.id && fk.to.table === owner && fk.from.columns.length === 1 && fk.from.columns[0] === image.whose,
        )
      : undefined;
  // The row's own column holding that record's key: the key itself, or the reference to it.
  const target = reference ? (image?.about ?? reference.to.columns[0]) : undefined;
  const owners = target ? [...new Set(rows.map((row) => row[target]).filter((value) => value !== null && value !== undefined))] : [];
  const keys = from ? primaryKey(from) : [];
  const sort = image?.sort ? cardsImageSort(image.sort) : undefined;
  const text =
    image && from && owners.length && keys.length
      ? `${from.id} ${image.whose} in (${owners.map(literal).join(', ')}) sort ${image.whose}${sort ? `, ${sort.column} ${sort.direction}` : ''} show ${[...new Set([...keys, image.whose])].join(', ')}`
      : '';
  const answer = useQuery({
    queryKey: ['run', connection ?? '', 'card-images', text],
    enabled: Boolean(text),
    staleTime: 60_000,
    queryFn: async () => {
      const data = (await api('/api/run', {
        q: text,
        limit: 500,
        offset: 0,
        count: 'none',
        ...(connection ? ownedBy(connection) : {}),
      })) as {
        rows?: Array<Record<string, unknown>>;
        errors?: Array<{ message: string }>;
      };
      if (data.errors?.length) throw new Error(data.errors[0].message);
      return data.rows ?? [];
    },
  });
  const lead = new Map<string, string>();
  if (image && from) {
    for (const row of answer.data ?? []) {
      const owner = String(row[image.whose]);
      if (!lead.has(owner))
        lead.set(owner, inlineFileAddress(from.id, Object.fromEntries(keys.map((column) => [column, row[column]])), connection, 'thumb'));
    }
  }
  return (row) => (target ? lead.get(String(row[target])) : undefined);
}

interface CardsListProps {
  table: TableMeta;
  rows: Array<Record<string, unknown>>;
  spec: AppCardsList;
  interactive?: boolean;
  /** Lets an otherwise read-only card open its record, without enabling writes or ordering. */
  recordNavigation?: boolean;
  label?: string;
  /** The list these cards are a page of, so a record opened here steps past the page (recordTrail.ts). */
  list?: TrailList;
  /** The view's hand order, where it keeps one (useListOrder.tsx). */
  order?: ListOrder;
  /** A reference column → the fetched path its record's name is read from (appListModel's referenceNames). */
  referenceLabels?: Record<string, string>;
}

/* Cards stand in columns where the room is wide enough: a drop lands left or right of a card, not above it. */
const inColumns = (grid: HTMLElement) => getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length > 1;

export function CardsList({
  table,
  rows,
  spec,
  interactive = true,
  recordNavigation = false,
  label,
  list,
  order,
  referenceLabels,
}: CardsListProps) {
  useMessageLanguage();
  const leadOf = useLeadFiles(table, spec, rows);
  /* The card's name wherever it is said — the title, the record it opens, the order's announcements — masked where its rule says. */
  const titleOf = (row: Record<string, unknown>) => {
    // A title that is a reference is its record's name, where the list fetched one (listColumn.ts).
    const named = namedCell(table, spec.primary, row, referenceLabels);
    if (named.column?.name !== spec.primary) return String(named.value);
    const rule = columnDisplay(table.id, spec.primary) as DisplayRule | null;
    const masked = maskedText(rule, row[spec.primary]);
    if (masked !== undefined && masked !== null) return masked;
    const value = row[spec.primary];
    if (value === null || value === undefined) return say('common.untitled');
    /* The column's display rule says the title as the grid does (an enum's words, a figure's format): a card titled
       each record by the stored key where the rule had words for it. A document, a code and a picture have no words
       to say; they stay the value. */
    const dress = dressFor(rule, value);
    if (!dress || dress.kind === 'json' || dress.kind === 'qr' || dress.kind === 'signature' || dress.kind === 'richText')
      return String(value);
    return 'label' in dress ? dress.label : dress.text;
  };
  const ordering = useListOrder({ table, rows, order, interactive, title: titleOf, across: inColumns });
  // A card another person just changed wears the grid's fading tint (docs/design.md, rule 11).
  const changedRows = useChangedRows(table.id, rows, (row) => keyOf(table, row) as Record<string, unknown> | null);
  const image = spec.image;
  const records: Array<{ key: Record<string, unknown>; label?: string }> = rows.flatMap((row) => {
    const key = keyOf(table, row) as Record<string, unknown> | null;
    return key ? [{ key, label: titleOf(row) }] : [];
  });
  /* A rollup or a label path dresses as what it reads, and a reference the list
     fetched a name for says the name (listColumn.ts). */
  /* A field's money says its cents on every card where one card's figure has some (centsAmong): "$24,495" on each. */
  const centsOf = new Map<string, boolean | undefined>();
  const cents = (name: string) => {
    if (!centsOf.has(name))
      centsOf.set(
        name,
        centsAmong(
          columnDisplay(table.id, name) as DisplayRule | null,
          rows.map((row) => namedCell(table, name, row, referenceLabels).value),
        )?.cents,
      );
    return centsOf.get(name);
  };
  const said = (row: Record<string, unknown>, name: string) => {
    const { column, value } = namedCell(table, name, row, referenceLabels);
    return <Value col={column} value={value} tableId={table.id} compact cents={cents(name)} />;
  };
  // A line or a fact may be a label path ("dealer_id.name"): its caption is the App's, else its last step's.
  const caption = (name: string) => (columnLabel(table.id, name) as string | null) ?? humanName(name.split('.').pop() ?? name);
  const present = (row: Record<string, unknown>, name: string) => row[name] !== null && row[name] !== undefined && row[name] !== '';
  const canOpen = interactive || recordNavigation;
  /* A fact as a card says it, on its line under the figure or along the foot: its value, and its own word after it
     ("1 owner") or before it ("Born …") as its caption for everyone; without one, the caption only assistive
     technology hears. */
  const fact = (row: Record<string, unknown>, name: string, className: string) => {
    const word =
      spec.factLabels && Object.hasOwn(spec.factLabels, name)
        ? factWord(
            spec.factLabels[name],
            row[name],
            columnDisplay(table.id, name) as { format?: string; unit?: string; bar?: boolean } | null,
          )
        : undefined;
    const before = word !== undefined && spec.factLabels![name].position === 'before';
    return (
      <span key={name} className={className}>
        {word === undefined && <span className="visually-hidden">{caption(name)}: </span>}
        {before && <span className="cards-summary-word">{word} </span>}
        {said(row, name)}
        {word !== undefined && !before && <span className="cards-summary-word"> {word}</span>}
      </span>
    );
  };
  // A long page is drawn a line of cards at a time; the page itself is unchanged (useRowWindow.ts).
  const win = useRowWindow<HTMLUListElement>(rows.length, {
    columns: (grid) => getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
    estimate: 280,
  });
  const listRef = useListRef(win, ordering.zone.ref);
  return (
    <div className="cards">
      <ul className="cards-grid" aria-label={label ?? say('cards')} {...ordering.zone} ref={listRef}>
        {win.before > 0 && <li className="cards-spacer" aria-hidden="true" style={{ height: `${win.before}px` }} />}
        {win.indices.map((index) => {
          const row = ordering.rows[index];
          const key = keyOf(table, row) as Record<string, unknown> | null;
          const id = ordering.id(row);
          const title = titleOf(row);
          const src = typeof image === 'string' ? cardImageAddress(row[image]) : leadOf(row);
          const avatar = spec.media === 'avatar';
          /* An icon tile leads the card in a picture's place: it is no picture, so the card keeps its text layout. */
          const tile = spec.media === 'icon';
          const hasMedia = image !== undefined || avatar;
          /* The summary as words, masked where its rule says: the whole of it rides the title attribute, since three lines may not hold it. */
          const description =
            spec.description && present(row, spec.description)
              ? (maskedText(columnDisplay(table.id, spec.description) as DisplayRule | null, row[spec.description]) ??
                String(row[spec.description]))
              : undefined;
          /* The icon column's value as its display rule marks it everywhere else; a value the rule leaves unmapped draws none. */
          const dressed = spec.icon ? dressFor(columnDisplay(table.id, spec.icon) as DisplayRule | null, row[spec.icon]) : null;
          const mark =
            (dressed?.kind === 'tone' || dressed?.kind === 'mark') && dressed.icon
              ? { name: dressed.icon, label: dressed.label, tone: dressed.kind === 'tone' ? dressed.tone : undefined }
              : null;
          const badge =
            spec.badge && row[spec.badge] != null && row[spec.badge] !== '' ? (
              <span className="cards-badge">{said(row, spec.badge)}</span>
            ) : null;
          return (
            <li
              key={key ? JSON.stringify(key) : index}
              className="cards-item"
              {...(win.windowed ? { 'data-index': win.lineOf(index), ref: win.measure } : {})}
              {...(id ? ordering.item(id) : {})}
              onKeyDown={id ? (event) => ordering.keyDown(event, id) : undefined}
            >
              <article
                className={`cards-card${hasMedia ? ' has-media' : ''}${avatar ? ' cards-profile' : ''}${changedRows.has(row) ? ` row-changed-${changedRows.get(row)}` : ''}`}
              >
                {hasMedia && <CardPicture src={src} avatar={avatar} title={title} first={index < FIRST_ROW} />}
                {id && ordering.menu(id)}
                <div className="cards-body">
                  {/* The tile holds its place where a value has no mark, so every card's title starts on one line. */}
                  {tile && (
                    <span className={`cards-tile${mark?.tone ? ` tone-${mark.tone}` : ''}`}>
                      {mark && <Icon name={mark.name as IconName} label={mark.label} size={22} />}
                    </span>
                  )}
                  <h3 className="cards-title">
                    {mark && !tile && <Icon name={mark.name as IconName} label={mark.label} className="cards-icon" />}
                    {canOpen && key ? (
                      <button
                        type="button"
                        className="cards-open"
                        data-order-focus=""
                        aria-keyshortcuts={ordering.shortcuts}
                        data-opens={opensRecord(table.id, key)}
                        onClick={() => void openRecord(table.id, key, title, 'push', { records, list })}
                      >
                        {title}
                      </button>
                    ) : (
                      <span>{title}</span>
                    )}
                  </h3>
                  {description !== undefined && (
                    <p className="cards-description" title={description}>
                      {description}
                    </p>
                  )}
                  {(!hasMedia || avatar) && badge}
                  {spec.value && row[spec.value] != null && <p className="cards-value">{said(row, spec.value)}</p>}
                  {spec.facts?.some((name) => present(row, name)) ? (
                    <p className="cards-summary">
                      {spec.facts.filter((name) => present(row, name)).map((name) => fact(row, name, 'cards-summary-item'))}
                    </p>
                  ) : null}
                  {spec.lines?.length ? (
                    <dl className="cards-facts">
                      {spec.lines.map((name) => (
                        <div key={name} className="cards-fact">
                          <dt>{caption(name)}</dt>
                          <dd>{said(row, name)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
                {/* The foot stands on every card that declares one, filled or not, so a row of cards ends on one line. */}
                {spec.footer?.length ? (
                  <p className="cards-foot">
                    {spec.footer.some((name) => present(row, name))
                      ? spec.footer.filter((name) => present(row, name)).map((name) => fact(row, name, 'cards-foot-item'))
                      : '\u00a0'}
                  </p>
                ) : null}
                {hasMedia && !avatar && badge}
              </article>
            </li>
          );
        })}
        {win.after > 0 && <li className="cards-spacer" aria-hidden="true" style={{ height: `${win.after}px` }} />}
      </ul>
      {ordering.live}
    </div>
  );
}

/**
 * A file's two sizes, for the browser to choose between: the thumbnail
 * (320 wide) where a card is drawn at about 300 pixels, the file itself on a
 * dense screen or a phone's full-width card, where the thumbnail would be
 * soft. A file resource with no thumbnail answers both with the file.
 */
function sources(src: string): { srcSet?: string; sizes?: string } {
  // A card is drawn at most 300 pixels wide: up to three times that on a dense screen.
  const srcSet = src.startsWith(served('/api/file?')) ? imageFallbackSet(src, 320, 960) : undefined;
  return srcSet ? { srcSet, sizes: CARD_IMAGE_SIZES } : {};
}

/** The same widths in each modern format, as their own addresses: a browser picks by `type`, a CDN keeps one copy of each. */
function typeSources(src: string): Array<{ type: string; srcSet: string }> {
  return src.startsWith(served('/api/file?')) ? imageSources(src, 320, 960) : [];
}

/* The cards a wide window shows in its first row: their pictures are the
   page's largest paint, so they are asked for first and not left to the
   lazy loader, which waits for layout to say they are in view. */
const FIRST_ROW = 4;

/** An authored picture, or a neutral placeholder when that picture is unavailable. Avatar mode keeps the name in the card title and makes its image decorative. */
function CardPicture({ src, avatar, title, first = false }: { src: string | undefined; avatar: boolean; title: string; first?: boolean }) {
  const [broken, setBroken] = useState<string>();
  const shown = src && broken !== src ? src : undefined;
  return (
    <div className={`cards-media${avatar ? ' cards-avatar' : ''}`}>
      {shown ? (
        <picture>
          {typeSources(shown).map((source) => (
            <source key={source.type} type={source.type} srcSet={source.srcSet} sizes={CARD_IMAGE_SIZES} />
          ))}
          <img
            className="cards-image"
            src={shown}
            {...sources(shown)}
            alt=""
            loading={first ? 'eager' : 'lazy'}
            fetchPriority={first ? 'high' : undefined}
            decoding="async"
            onError={() => setBroken(shown)}
          />
        </picture>
      ) : avatar ? (
        <span className={`cards-avatar-mark avatar avatar-c${hueOf(title)}`} aria-hidden="true">
          {initialsOf(title)}
        </span>
      ) : (
        <span className="cards-placeholder" aria-hidden="true">
          <svg viewBox="0 0 64 32" width="64" height="32" focusable="false">
            <rect x="8" y="6" width="48" height="20" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="23" cy="13" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="m12 23 13-8 8 6 7-5 12 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </div>
  );
}
