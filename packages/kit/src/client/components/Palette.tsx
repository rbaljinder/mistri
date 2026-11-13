/**
 * Cmd+K: go anywhere by typing its name — one ranked list of tables,
 * views, saved filters, recent queries, saved SQL, the menu's commands and
 * the other databases, because having to know which *kind* of thing you
 * are looking for before you can search for it defeats the purpose. The
 * ranking (`score`) and the list of everything nameable (`entries`) stay in
 * `palette.js`; this is the surface.
 */
import { useEffect, useRef, useState } from 'react';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { isAppIcon } from '@mistriwork/engine/shared/appIcons.js';
import { shell } from '../shellMode.js';
import { findTable, openRecord } from '../core.js';
import { findAcross, searchedTables, type Findable } from './recordSearch.js';
import { appRooms, isListRoom } from './appRooms.js';
import { Icon } from './Icon.js';
import { whenMenuChanges } from '../menu.js';
import { entries } from '../palette.js';
import { recentVisits } from '../paletteRecents.js';
import { score } from './paletteModel.js';
import { offeredChoices } from './pickerStaleness.js';
import { say } from '../copy/shell/components/Palette.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

interface PaletteItem {
  kind: string;
  label: string;
  search: string;
  detail?: string | null;
  /** An App's mark for the room, the line or the table behind it, one of the App icons. */
  icon?: string;
  /** The room a page entry opens, by its view key: how the Recent group finds the entry again (paletteRecents.ts). */
  room?: string;
  run: () => void;
}

/**
 * What an App's palette sorts its rows under, in the order it draws them. Commands (Preferences and what else the
 * menu registers) are the one group beyond the four a reader names — Recent, Pages, Create, Records — because
 * putting them under any of those would head a row with what it is not.
 */
type Group = 'recent' | 'pages' | 'create' | 'commands' | 'records';
const GROUPS: readonly Group[] = ['recent', 'pages', 'create', 'commands', 'records'];
/** A palette is a shortlist: the best of each group, so one long group cannot push the others off the list. */
const MOST: Record<Group, number> = { recent: 4, pages: 8, create: 5, commands: 4, records: 9 };
/** Before anything is typed a long menu's pages are a first handful, not the menu again: Create must be on the list's
    first screen. A menu that fits the shortlist (MOST.pages) is shown whole: cut to five, an App of seven lists hid
    two of them until a word was typed. */
const FIRST_PAGES = 5;

const groupOf = (item: PaletteItem): Group =>
  item.kind === 'page' ? 'pages' : item.kind === 'create' ? 'create' : item.kind === 'record' ? 'records' : 'commands';

function groupWord(group: Group): string {
  switch (group) {
    case 'recent':
      return say('groupRecent');
    case 'pages':
      return say('groupPages');
    case 'create':
      return say('groupCreate');
    case 'commands':
      return say('groupCommands');
    case 'records':
      return say('groupRecords');
  }
}

/** The line under a row's name: what it opens, said in words and then what the row says of itself. A record's own line begins with its table, which is its kind. */
function detailOf(item: PaletteItem): string | undefined {
  if (item.kind === 'record') return item.detail ?? undefined;
  const word = kindWord(item.kind);
  const kind = word.charAt(0).toUpperCase() + word.slice(1);
  return item.detail ? say('kindDetail', { kind, detail: item.detail }) : kind;
}

/** The mark of the list that serves a table: what a record of it is drawn with. */
function iconOfTable(tableId: string): string | undefined {
  const app = shell().app();
  return app ? (appRooms(app).find((room) => isListRoom(room) && room.table === tableId)?.icon as string | undefined) : undefined;
}

/** Where the reader just was: the rooms they left (found among the palette's own pages) and the records they read. */
function recentItems(listed: readonly PaletteItem[]): PaletteItem[] {
  const places = new Map(listed.flatMap((item) => (item.kind === 'page' && item.room !== undefined ? [[item.room, item] as const] : [])));
  return recentVisits()
    .flatMap((visit): PaletteItem[] => {
      if ('room' in visit) {
        const place = places.get(visit.room);
        return place ? [place] : [];
      }
      const table = findTable(visit.table) as { name: string } | undefined;
      return [
        {
          kind: 'record',
          label: visit.label,
          search: '',
          detail: `${humanName(table?.name ?? visit.table)} · ${Object.values(visit.key).join('/')}`,
          icon: iconOfTable(visit.table),
          run: () => void openRecord(visit.table, visit.key, visit.label),
        },
      ];
    })
    .slice(0, MOST.recent);
}

/** In app mode the App's lists name the tables worth searching and their label columns name the words people search by. */
/** What a row opens, in words: the kinds are the registry's identifiers, not copy. */
function kindWord(kind: string): string {
  switch (kind) {
    case 'page':
      return say('kindPage');
    case 'view':
      return say('kindView');
    case 'table':
      return say('kindTable');
    case 'filter':
      return say('kindFilter');
    case 'recent':
      return say('kindRecent');
    case 'action':
      return say('kindAction');
    case 'record':
      return say('kindRecord');
    case 'sql':
      return say('kindSql');
    case 'database':
      return say('kindDatabase');
    case 'create':
      return say('kindCreate');
    default:
      return kind;
  }
}

/** The tables the term is searched in: every list the reader's menu holds, up to the search's own ceiling (recordSearch.ts),
    and how many past it are left out. */
function recordTables(): { tables: Findable[]; left: number } {
  const app = shell().inApp() ? shell().app() : null;
  return app ? searchedTables(app) : { tables: [], left: 0 };
}

/** The hits one from each table in turn, so the few a palette shows are not the first tables' alone. */
function interleaved<T>(lists: readonly (readonly T[])[], most: number): T[] {
  const out: T[] = [];
  for (let at = 0; out.length < most && lists.some((each) => at < each.length); at++)
    for (const each of lists) if (at < each.length && out.length < most) out.push(each[at]);
  return out;
}

export function Palette({ prefill = '', onClose }: { prefill?: string; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [listed, setAll] = useState<PaletteItem[]>(() => entries() as PaletteItem[]);
  /* The header's New menu, searchable, from the reading its button uses — or, where the App declares none, the New
     its lists offer — fetched with that reading, so the shell's first page carries none of it. */
  const [made, setMade] = useState<PaletteItem[]>([]);
  useEffect(() => {
    const app = shell().inApp() ? shell().app() : null;
    if (!app) return;
    let live = true;
    /* The New items are extra: a palette closed (or a page left) before the chunk arrives, or a chunk a redeploy took
       away, leaves them out rather than raising an uncaught rejection. */
    import('./newMenuModel.js').then(
      (model) => {
        if (live) setMade(model.newPaletteItems(app) as PaletteItem[]);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const all = made.length ? [...listed, ...made] : listed;
  const [query, setQuery] = useState(prefill);
  // The hits and the term they answer, which lags what is typed by a pause and a request.
  const [records, setRecords] = useState<{ term: string; items: PaletteItem[] }>({ term: '', items: [] });
  const [active, setActive] = useState(0);
  const recordToken = useRef(0);

  /* Commands can arrive while the palette is open — the pages group is
     registered asynchronously on load. */
  useEffect(() => whenMenuChanges(() => setAll(entries() as PaletteItem[])) as () => void, []);
  useEffect(() => {
    input.current?.focus();
  }, []);

  /* Record hits, fetched as you type: the palette answers from memory
     instantly and from the database a beat later. */
  useEffect(() => {
    const term = query.trim();
    const mine = ++recordToken.current;
    const { tables } = recordTables();
    if (term.length < 2 || !tables.length) {
      setRecords({ term, items: [] });
      return;
    }
    const timer = setTimeout(
      () => {
        void findAcross(tables, term, 3).then((found) => {
          if (mine !== recordToken.current) return;
          const hits = found.map((own, at) =>
            own.map((each): PaletteItem => ({
              kind: 'record',
              label: each.label,
              search: '',
              detail: `${humanName(tables[at].table.name)} · ${Object.values(each.key).join('/')}`,
              icon: tables[at].room.icon as string | undefined,
              run: each.open,
            })),
          );
          setRecords({ term, items: interleaved(hits, MOST.records) });
        });
      },
      prefill && query === prefill ? 0 : 180,
    );
    return () => clearTimeout(timer);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const term = query.trim();
  const inApp = shell().inApp();
  const ranked = all
    .map((item) => ({ item, points: score(item.search, term) as number }))
    .filter(({ points }) => points > 0)
    .sort((a, b) => b.points - a.points)
    .map(({ item }) => item);
  // Bounded because a palette is a shortlist.
  const named = ranked.slice(0, 20);
  /* Hits for earlier text keep only the rows this text also names: with
     nothing named above them, the first is lit and Enter would open a record
     the box never named. Until the hits answer this text, "nothing matches"
     is not yet true either. */
  const hits = offeredChoices({ typed: term, asked: records.term, rows: records.items, label: (item) => item.label });
  const { tables: searched, left } = recordTables();
  const settled = hits.answered || term.length < 2 || !searched.length;
  /* An App's rows stand in groups, each ranked within itself: where the reader was (only before they type — typing is
     asking for something else), the pages, what they can make, the commands, and the records the words found. A room
     they were just in is under Recent and not again under Pages. */
  const recent = inApp && !term ? recentItems(listed) : [];
  const recentRooms = new Set(recent.flatMap((item) => (item.room === undefined ? [] : [item.room])));
  const pageCount = ranked.filter((item) => groupOf(item) === 'pages' && !(item.room !== undefined && recentRooms.has(item.room))).length;
  const grouped = GROUPS.map((group) => ({
    group,
    items:
      group === 'recent'
        ? recent
        : (group === 'records'
            ? hits.choices
            : ranked.filter((item) => groupOf(item) === group && !(item.room !== undefined && recentRooms.has(item.room)))
          ).slice(0, group === 'pages' && !term && pageCount > MOST.pages ? FIRST_PAGES : MOST[group]),
  }))
    .filter(({ items }) => items.length)
    .map((entry, at, every) => ({ ...entry, from: every.slice(0, at).reduce((sum, { items }) => sum + items.length, 0) }));
  /* Record hits ride below the named things: a table you typed exactly still wins the top. */
  const rows = inApp
    ? grouped.flatMap(({ group, items }) => items.map((item) => ({ item, group })))
    : [...named, ...hits.choices].slice(0, 20).map((item) => ({ item, group: groupOf(item) }));
  const shown = rows.map(({ item }) => item);
  const current = shown.length ? ((active % shown.length) + shown.length) % shown.length : 0;

  const choose = (index: number) => {
    const item = shown[index];
    if (!item) return;
    onClose();
    item.run();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          /* Stopped as well as prevented: a modal takes the key it handles. */
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        case 'ArrowDown':
          e.preventDefault();
          setActive(current + 1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          setActive(current - 1);
          return;
        case 'Enter':
          e.preventDefault();
          choose(current);
          return;
        /* The results are reached with the arrows, so the box is the only
           stop: Tab used to leave it for the page under the scrim, a focus
           nobody could see. */
        case 'Tab':
          e.preventDefault();
          return;
        default:
      }
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  });
  useEffect(() => {
    const row = list.current?.querySelector(`#palette-o${current}`);
    /* The first row of a group brings its heading with it, so a list scrolled up by the arrows does not leave the
       group nameless. */
    const head = row?.previousElementSibling?.classList.contains('palette-group-head') ? row.previousElementSibling : row;
    head?.scrollIntoView?.({ block: 'nearest' });
  }, [current, shown.length]);

  return (
    <div
      className="palette-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* A modal in all but its host: the page under the scrim is out of reach, so it is out of the reading too. */}
      <div className={`palette${inApp ? ' palette-grouped' : ''}`} role="dialog" aria-modal="true" aria-label={say('navigation.search')}>
        <input
          ref={input}
          type="text"
          className="palette-input"
          placeholder={shell().inApp() ? say('searchRecordsPagesAndCommands') : say('goToATable')}
          aria-label={say('navigation.search')}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown.length ? `palette-o${current}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
        />
        <div ref={list} className="palette-list" id="palette-list" role="listbox" aria-label={say('navigation.search')}>
          {!shown.length
            ? settled && <p className="palette-empty">{term ? say('nothingMatches', { term }) : say('nothingToGo')}</p>
            : inApp
              ? grouped.map(({ group, items, from: first }) => {
                  return (
                    <div key={group} className="palette-group" role="group" aria-labelledby={`palette-g-${group}`}>
                      <div className="palette-group-head" id={`palette-g-${group}`}>
                        {groupWord(group)}
                      </div>
                      {items.map((item, at) => {
                        const i = first + at;
                        const detail = detailOf(item);
                        return (
                          <div
                            key={`${group}:${item.kind}:${item.label}:${at}`}
                            className={`palette-item${i === current ? ' active' : ''}`}
                            id={`palette-o${i}`}
                            role="option"
                            aria-selected={i === current}
                            /* Named by its name alone, its line said after it as a description: read as one run of
                               text the two ran together ("Sales dashboard Page · Sales"), the line sounding like part
                               of the name. The group's heading already says the kind. */
                            aria-labelledby={`palette-o${i}-name`}
                            aria-describedby={detail ? `palette-o${i}-line` : undefined}
                            data-group={group}
                            onClick={() => choose(i)}
                            onMouseMove={() => setActive(i)}
                          >
                            <span className="palette-icon" aria-hidden="true">
                              {isAppIcon(item.icon) ? <Icon name={item.icon} size={16} /> : null}
                            </span>
                            <span className="palette-label" id={`palette-o${i}-name`}>
                              {item.label}
                            </span>
                            {detail ? (
                              <span className="palette-detail" id={`palette-o${i}-line`}>
                                {detail}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              : shown.map((item, i) => (
                  <div
                    key={`${item.kind}:${item.label}:${i}`}
                    className={`palette-item${i === current ? ' active' : ''}`}
                    id={`palette-o${i}`}
                    role="option"
                    aria-selected={i === current}
                    onClick={() => choose(i)}
                    onMouseMove={() => setActive(i)}
                  >
                    <span className={`palette-kind kind-${item.kind}`}>{kindWord(item.kind)}</span>
                    <span className="palette-label">{item.label}</span>
                    {item.detail ? <span className="palette-detail">{item.detail}</span> : null}
                  </div>
                ))}
        </div>
        {inApp && left > 0 ? (
          /* Said whether or not a word is typed, so it is there before the first record is asked for and nothing moves
             when it is: a search past its ceiling is told as one, never mistaken for every list answering. */
          <p className="palette-note" role="note">
            {say('searchedSome', { searched: searched.length, total: searched.length + left })}
          </p>
        ) : null}
        {inApp ? (
          /* The keys, as marks: the box answers to them, and nobody is told so. Not read out: the combobox says it. */
          <div className="palette-foot" aria-hidden="true">
            <span className="palette-hint">
              <kbd>↑</kbd>
              <kbd>↓</kbd> {say('hintMove')}
            </span>
            <span className="palette-hint">
              <kbd>↵</kbd> {say('hintOpen')}
            </span>
            <span className="palette-hint">
              <kbd>{say('keyEscape')}</kbd> {say('hintClose')}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
