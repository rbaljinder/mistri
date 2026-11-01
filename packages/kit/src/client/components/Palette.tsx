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
import { shell } from '../shellMode.js';
import { findRecords, findableTables, type Findable } from './recordSearch.js';
import { whenMenuChanges } from '../menu.js';
import { entries } from '../palette.js';
import { score } from './paletteModel.js';
import { offeredChoices } from './pickerStaleness.js';
import { say } from '../copy/shell/components/Palette.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

interface PaletteItem {
  kind: string;
  label: string;
  search: string;
  detail?: string | null;
  run: () => void;
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
    default:
      return kind;
  }
}

function recordTables(): Findable[] {
  const app = shell().inApp() ? shell().app() : null;
  return app ? findableTables(app) : [];
}

export function Palette({ prefill = '', onClose }: { prefill?: string; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [listed, setAll] = useState<PaletteItem[]>(() => entries() as PaletteItem[]);
  /* The header's New menu, searchable, from the reading its button uses — fetched with that reading, and only
     where the App declares the menu, so the shell's first page carries none of it. */
  const [made, setMade] = useState<PaletteItem[]>([]);
  useEffect(() => {
    const app = shell().inApp() ? shell().app() : null;
    if (!app?.ui.shell?.new?.length) return;
    let live = true;
    void import('./newMenuModel.js').then((model) => {
      if (live) setMade(model.newPaletteItems(app) as PaletteItem[]);
    });
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
    const tables = recordTables();
    if (term.length < 2 || !tables.length) {
      setRecords({ term, items: [] });
      return;
    }
    const timer = setTimeout(
      () => {
        void Promise.all(
          tables.map(async (findable) =>
            (await findRecords(findable, term, 3)).map((found): PaletteItem => ({
              kind: 'record',
              label: found.label,
              search: '',
              detail: `${humanName(findable.table.name)} · ${Object.values(found.key).join('/')}`,
              run: found.open,
            })),
          ),
        ).then((hits) => {
          if (mine !== recordToken.current) return;
          setRecords({ term, items: hits.flat().slice(0, 9) });
        });
      },
      prefill && query === prefill ? 0 : 180,
    );
    return () => clearTimeout(timer);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const term = query.trim();
  const named = all
    .map((item) => ({ item, points: score(item.search, term) as number }))
    .filter(({ points }) => points > 0)
    .sort((a, b) => b.points - a.points)
    // Bounded because a palette is a shortlist.
    .slice(0, 20)
    .map(({ item }) => item);
  /* Hits for earlier text keep only the rows this text also names: with
     nothing named above them, the first is lit and Enter would open a record
     the box never named. Until the hits answer this text, "nothing matches"
     is not yet true either. */
  const hits = offeredChoices({ typed: term, asked: records.term, rows: records.items, label: (item) => item.label });
  const settled = hits.answered || term.length < 2 || !recordTables().length;
  /* Record hits ride below the named things: a table you typed exactly still wins the top. */
  const shown = [...named, ...hits.choices].slice(0, 20);
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
    list.current?.children[current]?.scrollIntoView?.({ block: 'nearest' });
  }, [current, shown.length]);

  return (
    <div
      className="palette-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* A modal in all but its host: the page under the scrim is out of reach, so it is out of the reading too. */}
      <div className="palette" role="dialog" aria-modal="true" aria-label={say('navigation.search')}>
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
        <div ref={list} className="palette-list" id="palette-list" role="listbox">
          {!shown.length
            ? settled && <p className="palette-empty">{term ? say('nothingMatches', { term }) : say('nothingToGo')}</p>
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
      </div>
    </div>
  );
}
