/**
 * What `@mistriwork/mistri/ui` reads from the page around a component: how to read an
 * App resource, how to open a record or a view, what a column is and how its
 * App dresses it, and which look is on. One interface, two implementations:
 * the page's (host.tsx, over the App payload and the session endpoints) and a
 * test's (testing.tsx, over typed fixtures). The kit and the hooks only ever
 * reach the page through it, never through the walk's globals, so a component
 * draws the same in the App and in its own tests.
 *
 * Message-shaped on purpose: every read and every navigation is a request
 * with serializable arguments, so a component could one day be hosted in a
 * frame behind the same SDK without a second contract.
 */
import { createContext, useContext } from 'react';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import type { DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { say } from '../../copy/components/components/sdk/context.js';
import type { AppFlagsSource } from '../../appFlags.js';
import type { AppCommandField } from '../../../shared/command.js';

export type UiRow = Record<string, unknown>;
/** The page a read is made for (`x-mistri-page`), where it is a free-form page's. */
interface UiAsking {
  page?: string;
}
export interface UiRowsOptions extends UiAsking {
  /** A condition written as an object (`{ status: 'booked' }`), or a list of them joined by `and` (a `<Scope>`'s and
      its block's): sent as written, compiled and judged against the resource's columns by the server (pageWhere.ts). */
  where?: unknown;
  query?: string;
  show?: readonly string[];
  sort?: string;
  limit?: number;
  /** Rows skipped before this page: `useRows`' `more()` asks for the next page from where the last one ended. */
  offset?: number;
  /** The resource's key columns read beside `show`, so a row can be acted on (`<List>` hands its rows to a
      `CommandButton`) without its author naming columns the row is not drawn with. */
  keys?: boolean;
}
/** One page of a resource's rows, and whether the server holds more past it. */
interface UiRowsPage {
  rows: UiRow[];
  more: boolean;
  /** Present only when the server counted the rows; never inferred from a page's length. */
  total?: number;
}
export interface UiBreakdownOptions extends UiAsking {
  by: string;
  measure?: string;
  query?: string;
  limit?: number;
}
export type OpenMode = 'page' | 'drawer' | 'modal';
export interface UiOpenViewOptions {
  tab?: string;
  search?: string;
  filters?: Readonly<Record<string, string>>;
}
export interface UiLook {
  look: string;
  /** The theme the look started from: the App's chosen theme where `look` is `tenant`, else the look itself. */
  preset: string;
  mode: 'light' | 'dark';
  density: 'compact' | 'comfortable' | 'spacious';
}
/**
 * What this server presents the App as, read-only (`useDeployment()`): the name, the mark, the theme and the
 * language the deployment settled on, and the path it is served under. Presentation only; nothing here is a
 * credential, a connection or a setting of the server's.
 */
export interface UiDeployment {
  /** The program's name, as the bar and the page title say it. */
  readonly name: string;
  /** Where the logo's picture is served (its mark where it has one), or null: the App's logo is an icon, or it has none. */
  readonly mark: string | null;
  /** The theme the App is set in, by id, or null where the App sets none. */
  readonly theme: string | null;
  /** The language tag the App is set in, or null where the reader's browser decides. */
  readonly locale: string | null;
  /** The path a reverse proxy serves the server under (`/tools`), or '' at the root. */
  readonly basePath: string;
}
interface UiColumn {
  meta?: ColumnMeta;
  rule?: DisplayRule | null;
  label: string;
}

/** A command, by its name: the App's registry key. */
export type UiCommandRef = string;
/**
 * How a command a component ran ended: applied, with what its handler returned (`output`, as the API's `result`), refused
 * (with the server's words), a form closed with nothing sent, or not known: it was sent and no answer said whether it
 * ran (the connection dropped, the server could not say). `check()` asks again under the same key, so it can never run
 * twice, and resolves as the run would have.
 */
export type UiCommandOutcome =
  | { status: 'applied'; message?: string; output?: unknown }
  /** `fields`: the server's words for an input the refusal named, by its path, where the command declares it and the
      values sent leave it shown; what no field can hold stays in `message`. */
  | { status: 'refused'; message: string; code?: 'stale'; fields?: Readonly<Record<string, string>> }
  | { status: 'closed' }
  | {
      status: 'unknown';
      message: string;
      /** Ask again under the same key. A public page with a human check hands it a fresh token (`{ challenge }`). */
      check(options?: { challenge?: string }): Promise<UiCommandOutcome>;
    };
export interface UiCommandOptions {
  label?: string;
  /** A public page's human check: the token its widget gave, sent with the run (`auth.challenge`). */
  challenge?: string;
  /** The key a run that names no record is sent under: a UUID the component made once for this intent and keeps (in
      its address, say), so a run sent again after a reload is the same run. Made fresh per run when not given. */
  attempt?: string;
  /** The words said when it applied, instead of the platform's (`<ActionButton done>`). */
  done?: string;
  /** A refusal or an answer not known is the caller's to say, not a toast's: a form that says it beside its field and
      on its own line (`<Steps>`) would otherwise have it read out twice. */
  quiet?: boolean;
  /** The review the person confirmed (`prepare`): the run is sent for its revision only, never prepared again, and is
      refused `code: 'stale'` when the record has moved past it. */
  review?: UiCommandReview;
}

/** What `prepare` read for a review: the values the command starts from, `input` over them, and the token pinning a run. */
export interface UiCommandReview {
  readonly token: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** False once a change to the record reached the page, or the server refused the review. */
  readonly fresh: boolean;
}

/** A command's input that names a record of another resource, as it was served with the command. */
export type UiReferenceInput = Extract<AppCommandField, { type: 'reference' }>;

/**
 * The records of an App resource, offered as a picker's choices without a command's input behind them
 * (`useOptions('country')`): named by the resource's own title column, read under the reader's grants and row policy.
 * `page` is the free-form page asking, so the server holds the read to what the page declared.
 */
export interface UiResourceChoices {
  readonly resource: string;
  /** A condition written as an object, as `UiRowsOptions.where`: sent as written, judged by the server. */
  readonly where?: unknown;
  readonly page?: string;
}

/** One record a reference input offers: the key it is sent as, its name, and the line that tells two of one name apart. */
export interface UiOption {
  key: string | number;
  label: string;
  detail?: string;
}

/**
 * One command as the host serves it to a component: the platform's own
 * action, found by its command among the App's actions for this reader, or
 * else the signed-in form over it, which names no record. Its runs go through the one command pipeline — prepared for the record's
 * revision, sent once under a request key, refused in the server's words —
 * and its form is the platform's own dialog.
 */
export interface UiCommandHandle {
  /** The action's label: "React", "Pick". */
  label: string;
  /** Whether this reader may run it at all: signed in, granted it, and served the action or form that offers it. */
  granted: boolean;
  /** The resource whose records it runs on, where it has one: what a button names the record it is pressed for from. */
  resource?: string;
  /** Whether it is available on this record now: the command's own `when` and grants, asked of the server. */
  available(key: Readonly<Record<string, unknown>>): Promise<boolean>;
  /** Run with this input when it is complete and valid; otherwise open the form, filled with what was given. */
  run(
    key: Readonly<Record<string, unknown>>,
    input?: Readonly<Record<string, unknown>>,
    options?: UiCommandOptions,
  ): Promise<UiCommandOutcome>;
  /** The platform's own form for it, filled with what was given. */
  open(
    key: Readonly<Record<string, unknown>>,
    input?: Readonly<Record<string, unknown>>,
    options?: UiCommandOptions,
  ): Promise<UiCommandOutcome>;
  /** What a review shows before the person confirms, read at the record's revision now. A handle that names no record
      revision (a form, a public page, a fixed action) answers it with a refusal. */
  prepare?(
    key: Readonly<Record<string, unknown>>,
    input?: Readonly<Record<string, unknown>>,
  ): Promise<UiCommandReview | Extract<UiCommandOutcome, { status: 'refused' }>>;
  /** The choices one of its inputs offers, as they were served with it (`useCommand(...).choices(name)`). */
  choices?(field: string): readonly UiChoice[] | undefined;
  /** One of its inputs as it was served with it, what the platform's own form draws and judges it from (`useField`). */
  input?(name: string): AppCommandField | undefined;
  /**
   * The server's word on part of an input before the run (`/api/commands/check`): each named input's problem, judged
   * by the reader, `when`s and rules the run uses, nothing run. No word (undefined) when it cannot be asked.
   */
  check?(input: Readonly<Record<string, unknown>>, names: readonly string[]): Promise<Record<string, string> | undefined>;
}

/**
 * A form a page declares (`forms: ['apply']`), as its draft stands for this reader: what `page.useForm` reads. A draft
 * is the same one the form's own layout resumes, under the same keys, so the page and the form never disagree.
 */
export interface UiFormState {
  label: string;
  /** Whether this reader is served the form at all: signed in and granted its command. A public form is opened with `openForm`. */
  granted: boolean;
  steps: ReadonlyArray<{ id: string; label: string }>;
  /** The open draft: the steps it has saved, where the form opens, and when the server lets it go; null without one. */
  draft: { saved: readonly string[]; step: string | null; expiresAt: string | null } | null;
  /** A submit was sent and is not yet known to have landed: the draft cannot be started over until it is. */
  pending: boolean;
}

/**
 * How a declared form ended once it closed: done, received under a reference, sent and still processing (or not yet
 * known to have landed: opening it again submits under the same key, so it never runs twice), saved part way, or
 * closed with nothing kept.
 */
export type UiFormOutcome =
  | { status: 'done'; message?: string }
  | { status: 'received'; reference: string; message?: string }
  | { status: 'processing'; message: string }
  | { status: 'saved'; saved: readonly string[] }
  | { status: 'closed' };

/** A declared form as the host serves it to a page. */
export interface UiFormHandle {
  state(): Promise<UiFormState>;
  /** The platform's own form over the page, filled with what was given; `at` opens a draft at a step it has reached. */
  open(input?: Readonly<Record<string, unknown>>, options?: { at?: string }): Promise<UiFormOutcome>;
  /** The draft discarded, as the form's own Start over does; false while a submit is pending, or without a draft. */
  startOver(): Promise<boolean>;
}

/** One choice an input offers: the value sent, and the words shown for it. */
export interface UiChoice {
  readonly value: string | number | boolean;
  readonly label: string;
}

/** Who is reading: signed in or not, the signed-in account's id and the roles they hold here (none when signed out, and in an App that grants by no role). Browser-side knowledge only, to choose what to offer; the server decides every request. */
export interface UiViewer {
  signedIn: boolean;
  account?: string;
  roles: readonly string[];
}

/** What `useHref` asks a host to address: the sign-in, a list or dashboard by its key, a record under a list view, a page by its path. */
export type UiAddress =
  | { kind: 'signIn' }
  | { kind: 'view'; view: string; params?: Readonly<Record<string, string>> }
  | { kind: 'record'; view: string; key: Readonly<Record<string, unknown>>; tab?: string }
  | { kind: 'page'; path: string; params?: Readonly<Record<string, string>> };

export interface UiHost {
  readonly flags: AppFlagsSource;
  /** Behavior events a component emits; the App's `analytics.events` names what the server keeps. */
  readonly analytics: { emit(name: string, fields?: Readonly<Record<string, string | number | boolean>>): void };
  /** The identity the query cache keys on, so one reader's rows are never another's. */
  scope: readonly unknown[];
  /* A read the reader may not make rejects with an error carrying `status` 401 or 403: that is all `optional: true`
     reads to say `refused` (hooks.ts), so a host surfaces a refusal as it always has and adds nothing. */
  rows(resource: string, options: UiRowsOptions): Promise<UiRowsPage>;
  record(resource: string, key: Readonly<Record<string, unknown>>, show?: readonly string[], asking?: UiAsking): Promise<UiRow | undefined>;
  /** A free-form page's loader, run on the server for this reader: what the page is drawn with. `loader` names one of
      the page's `loaders`; without it the page's own `loader` runs. */
  load(page: string, params: Readonly<Record<string, string>>, loader?: string): Promise<unknown>;
  breakdown(resource: string, options: UiBreakdownOptions): Promise<UiRow[]>;
  openRecord(resource: string, key: Readonly<Record<string, unknown>>, options?: { mode?: OpenMode; label?: string }): void;
  openView(view: string, options?: UiOpenViewOptions): void;
  /** Follow an address `href` wrote, in place: a new history entry the shell paints, never a page load. */
  follow(href: string): void;
  /** One of the App's form views, in a dialog over the page, its prefillable inputs filled. */
  openForm(view: string, prefill?: Readonly<Record<string, string | number>>): void;
  /** One of the form views a page declares, with its draft (`page.useForm`). */
  form(view: string): UiFormHandle;
  /** The link a visitor opens a view or a public form by, placed with this tenant by its own address; undefined without one. */
  publicLink(view: string): string | undefined;
  /** Puts words in the page's timeline composer, never sending them; false when the page draws none. */
  fillComposer(text: string, mode?: 'reply' | 'note'): boolean;
  /** Where a file resource's row is served, inline: its smaller copy with `thumbnail`. Undefined while it is read first
      (a tenant App reads a file on its lease, into a blob): `drawn` is called when it has an address. */
  fileAddress(
    resource: string,
    key: Readonly<Record<string, unknown>>,
    options?: { thumbnail?: boolean },
    drawn?: () => void,
  ): string | undefined;
  /** A command as this reader is served it; `page` is the free-form page asking, whose public commands run through
      its own door. */
  command(ref: UiCommandRef, page?: string): UiCommandHandle;
  /** A fixed action (a machine's verb, `action(label, { set })`) as this reader is served it, found on one of `reads`
      (the free-form page's) or any resource without them; run on a record by its key, as the record page's button runs it. */
  action(ref: UiCommandRef, reads?: readonly string[]): UiCommandHandle;
  /** A reference input's choices as the platform's own picker reads them — the reader's door, the input's filter, by
      its label — a page at a time (`useOptions`). The `{ resource }` arm is a resource's own records, labelled by its
      title column and read under the reader's grants and row policy, with no command behind them. */
  choices(
    field: UiReferenceInput | UiResourceChoices,
    text: string,
    page: { offset: number; limit: number },
  ): Promise<{ options: UiOption[]; more: boolean }>;
  /** The record a reference holds, read by its key as its picker reads it; null where this reader is not offered it. */
  choiceName(field: UiReferenceInput | UiResourceChoices, key: string | number): Promise<UiOption | null>;
  /** The canonical address of a thing in the App, as `appAddress.ts` says it and a link carries it (`useHref`); undefined
      where the App has no such room or the key is not enough to say a record. */
  href(to: UiAddress): string | undefined;
  viewer(): UiViewer;
  /** Called when the reader signs in, out or as someone else; returns the unsubscribe. */
  subscribeViewer(listener: () => void): () => void;
  column(resource: string, name: string): UiColumn | undefined;
  look(): UiLook;
  /** The App as this deployment presents it (UiDeployment). */
  deployment(): UiDeployment;
  token(name: string): string;
  /** Called when the look, the mode or the density changes; returns the unsubscribe. */
  subscribeLook(listener: () => void): () => void;
  /** Whether values are drawn in an App's words (a vocabulary's value as a word). */
  app: boolean;
  /** Said in the page's live region, as the platform says a verb's outcome: a toast, read out by assistive technology. */
  announce(text: string, tone: 'ok' | 'error'): void;
  /** How a row of this resource is named, as a breadcrumb names it: its label column, else its key. */
  rowTitle(resource: string, row: Readonly<Record<string, unknown>>): string | undefined;
  /** One of the App's messages in the reader's words, its arguments filled; a key it lacks is said as itself. */
  message(key: string, args?: Readonly<Record<string, string | number | boolean | Date | null | undefined>>): string;
}

/**
 * A free-form page's frame (`definePage`, served as its manifest): the
 * resources it declared it reads and the commands it declared it runs (the
 * hooks refuse any other as a mistake, before the server refuses it as a
 * denial), the loader whose result it is drawn with, and the address
 * parameters it keeps its place in, read and written through the walk so
 * Back returns to where the reader was.
 */
export interface UiPageFrame {
  view: string;
  label: string;
  reads: readonly string[];
  commands: readonly string[];
  /** The fixed actions it declared it runs (`useAction`), on the resources it reads. */
  actions?: readonly string[];
  params: readonly string[];
  loader?: string;
  /** Every loader the page names, `loader` first: what `useLoader` is held to. */
  loaders?: readonly string[];
  /**
   * The record a page is a tab of (`pages/accounts/[id]/map.page.tsx`): its resource and key, what `useRecordKey` gives.
   * A test's frame (`renderPage(page, { record })`) knows no file and so no resource: any the page reads is answered.
   */
  record?: { table?: string; key: Readonly<Record<string, unknown>> };
  get(name: string): string | undefined;
  set(name: string, value: string | undefined, options?: { push?: boolean }): void;
}
export const UiPageContext = createContext<UiPageFrame | null>(null);
/** The kinds of the page's params, as `definePage` declared them (paramKinds.ts): what a control bound to one offers. */
export const UiParamKindsContext = createContext<Readonly<Record<string, unknown>>>({});

/**
 * A `<Scope from where>`: the resource the blocks inside it read when they name none, and the conditions each of
 * them reads under, its own `where` added to them. Nested Scopes of one resource add up; one of another resource
 * starts afresh.
 */
export interface UiScope {
  from: string;
  where: readonly unknown[];
  query?: string;
}
export const UiScopeContext = createContext<UiScope | null>(null);

/** The condition a read on `resource` takes from the Scope around it, its own added: all of the Scope's on its own resource, none on another. */
export function scopedCondition(
  scope: UiScope | null,
  resource: string,
  where: unknown,
  query: string | undefined,
): { where: readonly unknown[]; query: string } {
  const same = scope?.from === resource;
  return {
    where: [...(same ? scope.where : []), ...(where === undefined ? [] : [where])],
    query: andQuery(same ? scope.query : '', query),
  };
}

/* The page's host, set when the SDK is installed (host.tsx), so a value
   renderer drawn in a grid cell — with no provider of its own above it —
   still reads the App. A test provides its own. */
let pageHost: UiHost | null = null;
export function setPageHost(host: UiHost): void {
  pageHost = host;
}

export const UiHostContext = createContext<UiHost | null>(null);

/** The host where there is one: a kit block drawn outside a section (a story, a test) keeps the browser's own behaviour. */
export function useHostIfAny(): UiHost | null {
  return useContext(UiHostContext) ?? pageHost;
}

export function useUiHost(): UiHost {
  const host = useContext(UiHostContext) ?? pageHost;
  if (!host) throw new Error(say('uiIsDrawnByASection'));
  return host;
}

/** How wide the section a component stands in is, measured; `compact` below a phone's width. */
export interface UiSize {
  width: number;
  compact: boolean;
}
/* A phone's section is some 360px wide; a record's main column beside its
   aside on a 1280px desk is some 440px, and wants the desk layout. */
export const COMPACT_BELOW = 420;
export const UiSizeContext = createContext<UiSize>({ width: 1024, compact: false });
