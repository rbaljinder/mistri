/**
 * The hooks a custom component reads and moves with. The declared reads of a
 * `custom()` section are the first way to data — checked at load, planned,
 * narrowed by the dashboard's window — and these are the escape hatch for
 * what a component asks for itself: rows, one record or a breakdown of an App
 * resource, by the resource's own name, never a table or SQL.
 *
 * Every read is an ordinary request through the page's session, authorized
 * on the server like any other: role grants, field projection, row policy.
 * These names narrow what a component asks for; they are not the boundary.
 * Reads go through the page's one query cache, keyed by the reader, so a
 * sign-out or a switch of account never serves one reader's rows to another.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, formatRelativeDay } from '@mistriwork/kit/client/locale.js';
import {
  UiPageContext,
  UiSizeContext,
  useUiHost,
  type OpenMode,
  type UiOpenViewOptions,
  type UiBreakdownOptions,
  type UiChoice,
  type UiCommandOptions,
  type UiCommandOutcome,
  type UiCommandRef,
  type UiLook,
  type UiRow,
  type UiRowsOptions,
  type UiSize,
  type UiViewer,
} from './context.js';
import { say } from '../../copy/components/components/sdk/hooks.js';
import { messageLanguage, subscribeMessages } from '@mistriwork/kit/client/messages.js';
import type { AppFlagReader, AppFlagValue } from '../../../shared/appFlagValues.js';

/** Reads are render-local until React commits this exact render. Suspended or
 * abandoned renders share no consumption set with the committed tree. No ref or
 * memoized mutable set: concurrent work must not leak reads into another effect. */
export function useFlags<V = Readonly<Record<string, AppFlagValue>>>(): AppFlagReader<V> {
  const source = useUiHost().flags;
  const reader = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot);
  useEffect(() => {
    void source.load();
  }, [source, reader]);
  const used = new Set<string>();
  let committed = false;
  useEffect(() => {
    committed = true;
    if (used.size) source.commitUse?.(reader, [...used]);
  });
  return Object.freeze({
    get ready() {
      return reader.ready;
    },
    get(key: string) {
      const value = reader.get(key);
      if (!committed) used.add(key);
      return value;
    },
  }) as AppFlagReader<V>;
}

/** Call start from an authored interaction, never an effect or page load.
 * The server cookie is opaque; this does not sign in or grant App access. */
export function useVisitor(): { start(selection?: { readonly form?: string; readonly address?: string }): Promise<void> } {
  const source = useUiHost().flags;
  return useMemo(
    () => ({
      async start(selection?: { readonly form?: string; readonly address?: string }) {
        if (!source.establishVisitor) throw new Error(say('visitorUnavailable'));
        await source.establishVisitor(selection);
      },
    }),
    [source],
  );
}

/** Emit a custom event the App declared in `analytics.events`: `useAnalytics().emit('compare-opened', { vehicleId })`.
 * Fire-and-forget from an event handler. The server keeps only the declared name and fields, and takes who it
 * was from the session or visitor cookie, never from here. */
export function useAnalytics(): { emit(name: string, fields?: Readonly<Record<string, string | number | boolean>>): void } {
  const source = useUiHost().analytics;
  return useMemo(
    () => ({ emit: (name: string, fields?: Readonly<Record<string, string | number | boolean>>) => source.emit(name, fields) }),
    [source],
  );
}

/* A free-form page reads what it declared (definePage, `reads`): any other
   resource is a mistake said here, before the server refuses it as a denial
   for a reader who cannot read it — and it is the page's read, so the
   request says which page asks. Outside a page a component may name any
   resource. */
function useDeclared(resource: string): string | undefined {
  const page = useContext(UiPageContext);
  if (page && !page.reads.includes(resource)) {
    throw new Error(say('thePageReadsIsNotOne', { label: page.label, map: page.reads.map((name) => `"${name}"`).join(', '), resource }));
  }
  return page?.view;
}

/** Rows of one App resource: `useRows('pay_run', { query: 'status = review', show: ['title', 'net_total'], sort: 'pay_date desc', limit: 12 })`. */
export function useRows(resource: string, options: UiRowsOptions & { enabled?: boolean } = {}): UseQueryResult<UiRow[]> {
  const host = useUiHost();
  const page = useDeclared(resource);
  const { enabled = true, ...rest } = options;
  const asked = page ? { ...rest, page } : rest;
  return useQuery({
    queryKey: ['mistri-ui', 'rows', ...host.scope, resource, asked],
    queryFn: () => host.rows(resource, asked),
    enabled,
  });
}

/** One record of an App resource by its key: `useRecord('employee', { id: 4 }, ['name', 'title'])`. */
export function useRecord(
  resource: string,
  key: Readonly<Record<string, unknown>> | undefined,
  show?: readonly string[],
): UseQueryResult<UiRow | null> {
  const host = useUiHost();
  const page = useDeclared(resource);
  return useQuery({
    queryKey: ['mistri-ui', 'record', ...host.scope, resource, key, show, page],
    queryFn: async () => (await host.record(resource, key!, show, page ? { page } : {})) ?? null,
    enabled: key !== undefined,
  });
}

/**
 * A resource's rows grouped and measured: `useBreakdown('pay_stub', { by: 'status', measure: 'sum net' })`.
 * Each row is keyed as the server names its columns: the groups by their paths (`status`, `day(moved_at)`),
 * the measure as written (`count`, `sum(net)`, `max(on_hand_after)`).
 */
export function useBreakdown(resource: string, options: UiBreakdownOptions): UseQueryResult<UiRow[]> {
  const host = useUiHost();
  const page = useDeclared(resource);
  const asked = page ? { ...options, page } : options;
  return useQuery({
    queryKey: ['mistri-ui', 'breakdown', ...host.scope, resource, asked],
    queryFn: () => host.breakdown(resource, asked),
  });
}

/** Where a component may send the reader: a record (as a page, a peek or a dialog), one of the App's views, or one of its forms in a dialog. */
export function useNavigate(): {
  openRecord(resource: string, key: Readonly<Record<string, unknown>>, options?: { mode?: OpenMode; label?: string }): void;
  openView(view: string, options?: UiOpenViewOptions): void;
  openForm(view: string, prefill?: Readonly<Record<string, string | number>>): void;
  publicLink(view: string): string | undefined;
} {
  const host = useUiHost();
  return {
    openRecord: (resource, key, options) => host.openRecord(resource, key, options),
    openView: (view, options) => host.openView(view, options),
    openForm: (view, prefill) => host.openForm(view, prefill),
    publicLink: (view) => host.publicLink(view),
  };
}

/** The page's timeline composer, from a custom section beside it: `fill` puts a template's words in the box (and
    chooses Reply or Internal note, where the page offers it) for the reader to edit and send — it never sends. It
    answers false when the page draws no composer. */
export function useComposer(): { fill(text: string, options?: { mode?: 'reply' | 'note' }): boolean } {
  const host = useUiHost();
  return { fill: (text, options = {}) => host.fillComposer(text, options.mode) };
}

/** Where a file resource's row is served, for an `<img>`: `useFile('member_avatar')({ id: 4 }, { thumbnail: true })`. */
export function useFile(
  resource: string,
): (key: Readonly<Record<string, unknown>>, options?: { thumbnail?: boolean }) => string | undefined {
  const host = useUiHost();
  useDeclared(resource);
  return useCallback((key, options) => host.fileAddress(resource, key, options), [host, resource]);
}

/** Who is reading: signed in or not, and the signed-in account's id. Redraws when that changes. */
export function useViewer(): UiViewer {
  const host = useUiHost();
  const said = useSyncExternalStore(
    host.subscribeViewer,
    () => JSON.stringify(host.viewer()),
    () => '',
  );
  return said ? (JSON.parse(said) as UiViewer) : host.viewer();
}

const keyText = (key: Readonly<Record<string, unknown>>) =>
  JSON.stringify(
    Object.keys(key)
      .sort()
      .map((column) => [column, String(key[column])]),
  );

/** Why a command cannot be run on a record, before any click (`useCommand(...).reason(record)`). */
export type CommandUnavailable = 'signed-out' | 'not-granted' | 'unavailable';

/** A command as a component holds it (`useCommand`). */
interface UiCommand {
  label: string;
  granted: boolean;
  /** Whether it is available on this record now; undefined until the server has said. */
  available(record: Readonly<Record<string, unknown>>): boolean | undefined;
  /**
   * Why it cannot be run on this record, said before any click: `'signed-out'`, `'not-granted'` (the
   * reader's role is not granted it), or `'unavailable'` (the server said its `when` does not hold for
   * this record and reader now); undefined while it can be, and until the server has said. Nothing the
   * page did not already know: a precondition only the command's handler checks is the App's to say.
   */
  reason(record: Readonly<Record<string, unknown>>): CommandUnavailable | undefined;
  /** Whether a run on this record is on its way. */
  pending(record: Readonly<Record<string, unknown>>): boolean;
  run(
    record: Readonly<Record<string, unknown>>,
    input?: Readonly<Record<string, unknown>>,
    options?: UiCommandOptions,
  ): Promise<UiCommandOutcome>;
  open(
    record: Readonly<Record<string, unknown>>,
    input?: Readonly<Record<string, unknown>>,
    options?: UiCommandOptions,
  ): Promise<UiCommandOutcome>;
  /**
   * The choices one of its inputs offers, as they were served with the command: a choice's declared options, or a
   * table's rows (`field.choice({ from })`) where they come with it — on a public page, read as the public reads them
   * and kept until a row changes, so the page draws its own select with no read of its own. Undefined for an input
   * that offers none, or whose rows its own form reads.
   */
  choices(field: string): readonly UiChoice[] | undefined;
}

/**
 * One of the App's commands, as its actions offer it, by name: `useCommand('reactToPost')`.
 * A command no action offers and a signed-in form does names no record: it
 * is sent as its form sends it, and the record handed in is not read.
 *
 * `run(record, input)` sends it when the input is complete and valid, and
 * opens the platform's own form, filled with what was given, when it is not;
 * `open` always opens the form. Either way it is the one command pipeline —
 * prepared for the record's revision, sent once under a request key,
 * refused in the server's words, the page's reads refreshed after it — and
 * nothing a component sends is a write of its own. `available(record)` asks
 * the server whether the command's `when` holds for this record and this
 * reader, once per record, and answers undefined until it has; `reason(record)`
 * says why not in a word. A signed-out reader is granted no command. An applied
 * run resolves with what the command returned (`output`), so a component acts on
 * what it made without looking it up.
 */
export function useCommand(ref: UiCommandRef): UiCommand {
  const host = useUiHost();
  /* A free-form page runs what it declared (definePage, `commands`), as it reads what it declared. */
  const page = useContext(UiPageContext);
  if (page && !page.commands.includes(ref)) {
    throw new Error(
      say('thePageRunsIsNotOne', {
        label: page.label,
        map: page.commands.length ? page.commands.map((name) => `"${name}"`).join(', ') : say('noCommands'),
        command: ref,
      }),
    );
  }
  const viewer = useViewer();
  const handle = useMemo(() => host.command(ref, page?.view), [host, ref, page?.view, viewer.signedIn, viewer.account]); // eslint-disable-line react-hooks/exhaustive-deps
  const [answers, setAnswers] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef(new Map<string, Readonly<Record<string, unknown>>>());
  const wanted = useRef(new Map<string, Readonly<Record<string, unknown>>>());
  const [round, setRound] = useState(0);
  /* The handle whose answers are wanted: one for another reader or command asks everything again. */
  const current = useRef(handle);
  useEffect(() => {
    if (current.current === handle) return;
    current.current = handle;
    asked.current.clear();
    setAnswers(new Map());
  }, [handle]);
  useEffect(
    () => () => {
      current.current = undefined as unknown as typeof handle;
    },
    [],
  );
  /* The records a draw asked about, asked of the server after it (one batch, commandAvailability.ts). */
  useEffect(() => {
    const ask = [...wanted.current].filter(([text]) => !asked.current.has(text));
    wanted.current.clear();
    if (!ask.length) return;
    for (const [text, key] of ask) asked.current.set(text, key);
    const by = handle;
    void Promise.all(ask.map(async ([text, key]) => [text, by.granted ? await by.available(key).catch(() => false) : false] as const)).then(
      (results) => {
        if (current.current === by) setAnswers((before) => new Map([...before, ...results]));
      },
    );
  });
  /* Asked again after a run, keeping the last answers until the new ones arrive: a chip does not blink. */
  const again = () => {
    asked.current.clear();
    setRound((n) => n + 1);
  };
  const track = (text: string, work: Promise<UiCommandOutcome>) => {
    setRunning((before) => new Set(before).add(text));
    return work.finally(() => {
      setRunning((before) => {
        const next = new Set(before);
        next.delete(text);
        return next;
      });
      /* What a command changed may change what is available: asked again after it settles. */
      again();
    });
  };
  void round;
  const available = (record: Readonly<Record<string, unknown>>) => {
    const text = keyText(record);
    if (!asked.current.has(text)) wanted.current.set(text, record);
    return answers.get(text);
  };
  return {
    label: handle.label,
    granted: handle.granted,
    available,
    reason(record) {
      // A public page's public command is everyone's: granted, signed in or not (publicPageCommand.ts).
      if (!viewer.signedIn && !handle.granted) return 'signed-out';
      if (!handle.granted) return 'not-granted';
      return available(record) === false ? 'unavailable' : undefined;
    },
    pending: (record) => running.has(keyText(record)),
    run: (record, input, options) => track(keyText(record), handle.run(record, input, options)),
    open: (record, input, options) => track(keyText(record), handle.open(record, input, options)),
    choices: (field) => handle.choices?.(field),
  };
}

/**
 * A free-form page's place, kept in its address: `const [list, setList] = useAddressState('list')` reads and writes
 * `/{app}/pick-walk?list=12`, so a page reached by a link, a reload or Back opens where the reader was.
 * The name is one of the page's declared `params` (a page's `useParam` is this hook). A change refines the place the
 * reader is on, in the address as they go; `{ push: true }` makes it a step Back returns from.
 */
export function useAddressState(
  name: string,
): [string | undefined, (value: string | number | undefined, options?: { push?: boolean }) => void] {
  const page = useContext(UiPageContext);
  if (!page) throw new Error(say('useaddressstateKeepsAPages'));
  if (!page.params.includes(name)) {
    throw new Error(
      say('thePageKeepsInItsAddress', {
        label: page.label,
        params: page.params.length ? page.params.map((param) => `"${param}"`).join(', ') : say('noParameters'),
        name,
      }),
    );
  }
  const set = useCallback(
    (value: string | number | undefined, options?: { push?: boolean }) =>
      page.set(name, value === undefined || value === '' ? undefined : String(value), options),
    [page, name],
  );
  return [page.get(name), set];
}

/**
 * One of the App's messages (`messages/<locale>.ts`) in the reader's
 * language, its `{name}`s filled from `args`: `useMessage('help.title')`,
 * `useMessage('help.results', { count: 3 })`. Redraws when the reader picks
 * another language. A key the catalog lacks is said as itself.
 */
export function useMessage(key: string, args?: Readonly<Record<string, string | number | boolean | Date | null | undefined>>): string {
  const host = useUiHost();
  useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
  return host.message(key, args);
}

/** Figures in the App's locale, currency and timezone (`ui.locale`, `ui.currency`, `ui.timezone`), as every built-in section says them. */
export function useFormat() {
  return {
    number: (value: number | string, options?: Intl.NumberFormatOptions) => formatNumber(value, options),
    money: (value: number, currency?: string) => formatMoney(value, currency),
    percent: (value: number) => formatPercent(value),
    date: (value: string) => formatDate(value),
    dateTime: (value: string) => formatDateTime(value),
    /** "in 3 days", "yesterday"; undefined for a value that is not a date. */
    relative: (value: string) => formatRelativeDay(value) ?? undefined,
  };
}

/** The look the App wears for this reader, light or dark, and the density. */
export function useLook(): UiLook {
  const host = useUiHost();
  const said = useSyncExternalStore(
    host.subscribeLook,
    () => JSON.stringify(host.look()),
    () => '',
  );
  return said ? (JSON.parse(said) as UiLook) : host.look();
}

/** One design token's value as the look resolves it — `useToken('--accent')` — for a canvas or an SVG attribute. CSS can say `var(--accent)` itself. */
export function useToken(name: `--${string}`): string {
  const host = useUiHost();
  return useSyncExternalStore(
    host.subscribeLook,
    () => host.token(name),
    () => '',
  );
}

/** The section's measured width, and whether it is phone-narrow: a component lays itself out for the room it has. */
export function useSectionSize(): UiSize {
  return useContext(UiSizeContext);
}
