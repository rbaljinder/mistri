/**
 * What every Console room shares: the App it is about, chosen once, and a
 * live read that refreshes itself while the tab is in view.
 *
 * The App is held in the address (`?app=`) and remembered for the next room,
 * so Operations, Analytics and Feature flags open on the App last chosen
 * without asking again. A live read keeps its last answer on screen while the
 * next is asked — a finished screen swapped for a finished screen, so nothing
 * moves when it refreshes (docs/design.md, motion rule 8) — and says when it
 * was last answered beside one button that asks now.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Dropdown, Icon, SplitListDetail, useFormat, useNavigate } from '@mistriwork/mistri/ui';
import { useAddressState } from '@mistriwork/mistri/page';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { say } from '../../copy/console/components/console/ConsoleShell.js';
import type { ConsoleRequest } from './model.js';
import { addHostListener, removeHostListener, shellById, shellRoot } from '@mistriwork/kit/client/shellHost.js';

/** How often a room's reads refresh while the tab is visible. */
const LIVE_EVERY = 15_000;
const MEMORY = 'mistri-console-app';

/** The App last chosen in any room, by id and name: a flag target's handle rotates, its name does not. */
function rememberedApp(): { id?: string; name?: string } {
  try {
    const value = JSON.parse(localStorage.getItem(MEMORY) ?? 'null');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
export function rememberApp(app: { id?: string; name: string }) {
  try {
    localStorage.setItem(MEMORY, JSON.stringify(app));
  } catch {
    /* a private window keeps the address alone */
  }
}

/** The room's App: the address's, else the one last chosen; choosing pushes it and remembers it. */
export function useConsoleApp(): [string | undefined, (app: { id: string; name: string }) => void] {
  const [app, setApp] = useAddressState('app');
  const choose = useCallback(
    (next: { id: string; name: string }) => {
      rememberApp(next);
      setApp(next.id, { push: true });
    },
    [setApp],
  );
  return [app ?? rememberedApp().id, choose];
}

/** One App among those offered: the asked one, else the remembered one by name, else the first. */
export function pickApp<T extends { id: string; name: string }>(apps: readonly T[], asked: string | undefined): T | undefined {
  const memory = rememberedApp();
  return apps.find((app) => app.id === asked) ?? apps.find((app) => app.name === memory.name) ?? apps[0];
}

/**
 * A clock the room's reads follow: it ticks every `every` ms while the tab is
 * visible, once when the tab comes back after missing a tick, and at once
 * when asked. A hidden tab asks nothing.
 */
export function useLiveTick(every = LIVE_EVERY): [number, () => void] {
  const [tick, setTick] = useState(0);
  const last = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(function next() {
      if (document.visibilityState === 'visible') {
        last.current = Date.now();
        setTick((value) => value + 1);
      }
      timer.current = setTimeout(next, every);
    }, every);
  }, [every]);
  const now = useCallback(() => {
    last.current = Date.now();
    setTick((value) => value + 1);
    schedule();
  }, [schedule]);
  useEffect(() => {
    schedule();
    const seen = () => {
      if (document.visibilityState === 'visible' && Date.now() - last.current >= every) now();
    };
    addHostListener(document, 'visibilitychange', seen);
    return () => {
      clearTimeout(timer.current);
      removeHostListener(document, 'visibilitychange', seen);
    };
  }, [every, schedule, now]);
  return [tick, now];
}

interface LiveRead<T> {
  data?: T;
  error?: string;
  code?: string;
  at: number;
  pending: boolean;
  current: boolean;
}

/**
 * One Console read that follows the clock. Its last answer stays while the
 * next one is asked (`pending`), also across a change of path (`current` is
 * false until the new path answers), so a refresh or a filter never blanks
 * what is drawn. A late answer for an older path is dropped.
 */
export function useLiveRead<T>(request: ConsoleRequest, path: string | undefined, tick = 0): LiveRead<T> | undefined {
  const [state, setState] = useState<{
    path: string;
    request: ConsoleRequest;
    data?: T;
    error?: string;
    code?: string;
    at: number;
  }>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const cancel = new AbortController();
    setPending(true);
    void request<T>(path, undefined, cancel.signal).then(
      (data) => {
        if (live) {
          setState({ path, request, data, at: Date.now() });
          setPending(false);
        }
      },
      (error: Error & { code?: string }) => {
        if (!live) return;
        // A refresh that fails keeps what was drawn and says why above it.
        setState((previous) => ({
          path,
          request,
          error: error.message,
          code: error.code,
          at: previous?.at ?? Date.now(),
          ...(previous?.path === path && previous.request === request && previous.data !== undefined ? { data: previous.data } : {}),
        }));
        setPending(false);
      },
    );
    return () => {
      live = false;
      cancel.abort();
    };
  }, [request, path, tick]);
  if (!state || !path || state.request !== request) return undefined;
  return {
    data: state.data,
    error: state.error,
    code: state.code,
    at: state.at,
    pending,
    current: state.path === path,
  };
}

/** "Updated 12 s ago", said again every few seconds in a box of its own width, so the bar never moves. */
function Updated({ at, pending }: { at: number | undefined; pending: boolean }) {
  useMessageLanguage();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setNow(Date.now());
  }, [at]);
  const seconds = at === undefined ? undefined : Math.max(0, Math.round((now - at) / 1000));
  const text =
    pending && at === undefined
      ? say('updating')
      : seconds === undefined
        ? say('never')
        : seconds < 5
          ? say('updatedNow')
          : seconds < 60
            ? say('updatedSeconds', { seconds: Math.floor(seconds / 5) * 5 })
            : say('updatedMinutes', { count: Math.floor(seconds / 60) });
  return (
    <span className="console-updated" aria-live="off">
      {text}
    </span>
  );
}

/** One thing the palette can jump to: a flag, an App, a job, a room. */
export interface PaletteEntry {
  id: string;
  group: string;
  label: string;
  detail?: string;
  run(): void;
}

const ROOMS = [
  { view: 'targets', label: () => say('roomFlags') },
  { view: 'operations', label: () => say('roomOperations') },
  { view: 'analytics', label: () => say('roomAnalytics') },
  { view: 'governance', label: () => say('roomGovernance') },
] as const;
const mac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * The head every Console room opens with, one row at a desk: the room's name,
 * the App it is about (a switcher even with one App, so the room always says
 * which), the room's own context (a scope, an environment), and at its end
 * the jump box and the live clock. The room's toolbar follows it as children.
 *
 * ⌘K (Ctrl K) opens the palette from anywhere in the room. The shell binds
 * the same chord to its own search; the Console's palette is the one that
 * knows flags, Apps and jobs, so the room takes the chord first.
 */
/** The Console lays its rooms out with two props the public split leaves out (the shell's own, SplitListDetail.tsx):
    the detail's title in sentence case, and a full-width list until a record is picked. */
export const ConsoleSplit = SplitListDetail as (
  props: Parameters<typeof SplitListDetail>[0] & { sentenceTitle?: boolean; expandList?: boolean },
) => ReturnType<typeof SplitListDetail>;

export function ConsoleHead({
  title,
  apps,
  app,
  onApp,
  context,
  live,
  entries = [],
  children,
}: {
  title: string;
  apps: readonly { id: string; name: string; detail?: string }[];
  app: { id: string; name: string } | undefined;
  onApp(app: { id: string; name: string }): void;
  /** What the room is scoped to besides its App: a scope, an environment. */
  context?: ReactNode;
  live?: { at: number | undefined; pending: boolean; onRefresh(): void };
  /** The room's own things to jump to (its flags, its jobs); Apps and rooms are added here. */
  entries?: readonly PaletteEntry[];
  children?: ReactNode;
}) {
  useMessageLanguage();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  useEffect(() => {
    const chord = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      show();
    };
    addHostListener(window, 'keydown', chord, true);
    return () => removeHostListener(window, 'keydown', chord, true);
  }, [show]);
  const all: PaletteEntry[] = [
    ...entries,
    ...apps.map((entry) => ({
      id: `app:${entry.id}`,
      group: say('groupApps'),
      label: entry.name,
      detail: entry.id === app?.id ? say('current') : entry.detail,
      run: () => onApp(entry),
    })),
    ...ROOMS.map((room) => ({
      id: `room:${room.view}`,
      group: say('groupRooms'),
      label: room.label(),
      run: () => navigate.openView(room.view),
    })),
  ];
  return (
    <header className="console-head">
      <div className="console-head-row">
        {/* The page's heading (hidden by the room's `heading: false`) says the same; this is its visible face. */}
        <span className="console-title" aria-hidden="true">
          {title}
        </span>
        {app && (
          <div className="console-switcher">
            <Dropdown
              ariaLabel={say('app')}
              value={app.id}
              items={apps.map((entry) => ({
                value: entry.id,
                label: entry.name,
                ...(entry.detail ? { detail: entry.detail } : {}),
              }))}
              onChange={(value) => {
                const next = apps.find((entry) => entry.id === value);
                if (next) onApp(next);
              }}
            />
          </div>
        )}
        {context}
        <span className="console-head-end">
          <button type="button" className="console-jump" aria-keyshortcuts="Meta+K Control+K" aria-haspopup="dialog" onClick={show}>
            <Icon name="magnifying-glass" size={14} />
            <span className="console-jump-word">{say('jump')}</span>
            <kbd>{mac() ? say('chordMac') : say('chordOther')}</kbd>
          </button>
          {live && (
            <>
              <Updated at={live.at} pending={live.pending} />
              <Button
                size="compact"
                intent="quiet"
                className="console-refresh"
                aria-label={say('refreshNow')}
                title={say('refreshNow')}
                onClick={live.onRefresh}
              >
                <span aria-hidden="true">↻</span>
              </Button>
            </>
          )}
        </span>
      </div>
      {children}
      {open && <Palette entries={all} onClose={() => setOpen(false)} />}
    </header>
  );
}

/** The best matches first: a name that starts with the words, then one that holds them, in the order given. */
function rankEntries(entries: readonly PaletteEntry[], text: string): PaletteEntry[] {
  const asked = text.trim().toLowerCase();
  if (!asked) return [...entries];
  const scored = entries
    .map((entry, index) => {
      const label = entry.label.toLowerCase();
      const score = label.startsWith(asked)
        ? 0
        : label.includes(asked)
          ? 1
          : `${entry.group} ${entry.detail ?? ''}`.toLowerCase().includes(asked)
            ? 2
            : 3;
      return { entry, index, score };
    })
    .filter((item) => item.score < 3);
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((item) => item.entry);
}

/**
 * The jump box: type, arrow to a line, Enter to go. Grouped as the room gave them.
 *
 * A native modal dialog, not the shell's Modal: a room is a component bundle, and the shell's dialog would bring its
 * own copy of Base UI into it. The native one is drawn in the top layer yet stays inside the room's element, so the
 * room's scoped styles reach it, and it brings Escape, the inert page behind it and focus returned on close.
 */
function Palette({ entries, onClose }: { entries: readonly PaletteEntry[]; onClose(): void }) {
  useMessageLanguage();
  const [text, setText] = useState(''),
    [at, setAt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal?.();
    return () => {
      if (node?.open) node.close();
    };
  }, []);
  const shown = rankEntries(entries, text).slice(0, 50);
  const active = Math.min(at, Math.max(shown.length - 1, 0));
  const groups: Array<{
    name: string;
    items: Array<{ entry: PaletteEntry; index: number }>;
  }> = [];
  shown.forEach((entry, index) => {
    const group = groups.find((item) => item.name === entry.group) ?? groups[groups.push({ name: entry.group, items: [] }) - 1];
    group.items.push({ entry, index });
  });
  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    dialog.current?.close();
    entry.run();
  };
  useEffect(() => {
    shellById(`${id}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [id, active]);
  return (
    <dialog
      ref={dialog}
      className="console-palette"
      aria-label={say('paletteLabel')}
      onClose={onClose}
      onClick={(event) => {
        /* A press on the backdrop lands on the dialog itself; inside the box it lands on a child. */
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="console-palette-box">
        <Icon name="magnifying-glass" size={16} />
        {/* `palette-input`: the shell's mark for a box that is its dialog's whole subject and draws no focus ring of its own. */}
        <input
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={shown.length ? `${id}-${active}` : undefined}
          aria-label={say('paletteLabel')}
          placeholder={say('palettePlaceholder')}
          value={text}
          autoFocus
          onChange={(event) => {
            setText(event.target.value);
            setAt(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setAt((active + step + shown.length) % Math.max(shown.length, 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              run(shown[active]);
            }
          }}
        />
      </div>
      <div className="console-palette-list" id={`${id}-list`} role="listbox" aria-label={say('paletteResults')}>
        {!shown.length && <p className="console-palette-empty">{say('paletteNothing')}</p>}
        {groups.map((group) => (
          <div key={group.name} role="group" aria-label={group.name} className="console-palette-group">
            <span className="console-palette-heading" aria-hidden="true">
              {group.name}
            </span>
            {group.items.map(({ entry, index }) => (
              <div
                key={entry.id}
                id={`${id}-${index}`}
                role="option"
                aria-selected={index === active}
                className="console-palette-item"
                onPointerMove={() => setAt(index)}
                onClick={() => run(entry)}
              >
                <span className="console-palette-label">{entry.label}</span>
                {entry.detail && <span className="console-palette-detail">{entry.detail}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </dialog>
  );
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
    !!target.closest('[role="dialog"], [role="listbox"], [role="menu"]'));

/**
 * A list walked by keys, as Linear's are: j and k move to the next and the
 * previous row (its first `[data-list-key]` control, which Enter presses),
 * and Escape closes what the list opened. Nothing moves while the reader is
 * typing or a dialog holds the keys; no motion follows the focus (motion rule 2).
 */
export function useListKeys(list: RefObject<HTMLElement | null>, onEscape?: () => void) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (event.key === 'Escape') {
        if (escape.current) {
          escape.current();
          event.preventDefault();
        }
        return;
      }
      if (event.key !== 'j' && event.key !== 'k') return;
      const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-list-key]') ?? [])];
      if (!rows.length) return;
      const at = rows.findIndex((row) => row === document.activeElement || row.contains(document.activeElement));
      const next =
        at < 0 ? (event.key === 'j' ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'j' ? 1 : -1)));
      event.preventDefault();
      rows[next].focus();
      rows[next].scrollIntoView?.({ block: 'nearest' });
    };
    addHostListener(document, 'keydown', keys);
    return () => removeHostListener(document, 'keydown', keys);
  }, [list]);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 1],
  ['minute', 60],
  ['hour', 3600],
  ['day', 86_400],
  ['month', 2_592_000],
  ['year', 31_536_000],
];
/** "12 minutes ago", "in 3 hours": the largest whole unit, in the page's language. */
function ago(at: string, now = Date.now()): string | undefined {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return undefined;
  const seconds = Math.round((ms - now) / 1000),
    size = Math.abs(seconds);
  let unit: Intl.RelativeTimeFormatUnit = 'second',
    per = 1;
  for (const [name, length] of UNITS)
    if (size >= length) {
      unit = name;
      per = length;
    }
  if (size < 45) return new Intl.RelativeTimeFormat(shellRoot().lang || undefined, { numeric: 'auto' }).format(0, 'second');
  return new Intl.RelativeTimeFormat(shellRoot().lang || undefined, { numeric: 'auto' }).format(Math.round(seconds / per), unit);
}

/** A moment said relatively ("12 minutes ago"), with the moment itself on hover. */
export function When({ at }: { at: string | null }) {
  const format = useFormat();
  if (at === null) return <span className="console-faint">—</span>;
  return (
    <time dateTime={at} title={format.dateTime(at)}>
      {ago(at) ?? format.dateTime(at)}
    </time>
  );
}
