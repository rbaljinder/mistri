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
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import type { DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { say } from '../../copy/components/components/sdk/context.js';
import type { AppFlagsSource } from '../../appFlags.js';

export type UiRow = Record<string, unknown>;
/** The page a read is made for (`x-mistri-page`), where it is a free-form page's. */
interface UiAsking {
  page?: string;
}
export interface UiRowsOptions extends UiAsking {
  query?: string;
  show?: readonly string[];
  sort?: string;
  limit?: number;
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
  mode: 'light' | 'dark';
  density: 'compact' | 'comfortable' | 'spacious';
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
 * (with the server's words), or a form closed with nothing sent.
 */
export type UiCommandOutcome =
  | { status: 'applied'; message?: string; output?: unknown }
  | { status: 'refused'; message: string }
  | { status: 'closed' };
export interface UiCommandOptions {
  label?: string;
  /** A public page's human check: the token its widget gave, sent with the run (`auth.challenge`). */
  challenge?: string;
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
  /** The choices one of its inputs offers, as they were served with it (`useCommand(...).choices(name)`). */
  choices?(field: string): readonly UiChoice[] | undefined;
}

/** One choice an input offers: the value sent, and the words shown for it. */
export interface UiChoice {
  readonly value: string | number | boolean;
  readonly label: string;
}

/** Who is reading: signed in or not, and the signed-in account's id. Browser-side knowledge only; the server decides every request. */
export interface UiViewer {
  signedIn: boolean;
  account?: string;
}

export interface UiHost {
  readonly flags: AppFlagsSource;
  /** Behavior events a component emits; the App's `analytics.events` names what the server keeps. */
  readonly analytics: { emit(name: string, fields?: Readonly<Record<string, string | number | boolean>>): void };
  /** The identity the query cache keys on, so one reader's rows are never another's. */
  scope: readonly unknown[];
  rows(resource: string, options: UiRowsOptions): Promise<UiRow[]>;
  record(resource: string, key: Readonly<Record<string, unknown>>, show?: readonly string[], asking?: UiAsking): Promise<UiRow | undefined>;
  /** A free-form page's loader, run on the server for this reader: what the page is drawn with. */
  load(page: string, params: Readonly<Record<string, string>>): Promise<unknown>;
  breakdown(resource: string, options: UiBreakdownOptions): Promise<UiRow[]>;
  openRecord(resource: string, key: Readonly<Record<string, unknown>>, options?: { mode?: OpenMode; label?: string }): void;
  openView(view: string, options?: UiOpenViewOptions): void;
  /** One of the App's form views, in a dialog over the page, its prefillable inputs filled. */
  openForm(view: string, prefill?: Readonly<Record<string, string | number>>): void;
  /** The link a visitor opens a view or a public form by, placed with this tenant by its own address; undefined without one. */
  publicLink(view: string): string | undefined;
  /** Puts words in the page's timeline composer, never sending them; false when the page draws none. */
  fillComposer(text: string, mode?: 'reply' | 'note'): boolean;
  /** Where a file resource's row is served, inline: its smaller copy with `thumbnail`. */
  fileAddress(resource: string, key: Readonly<Record<string, unknown>>, options?: { thumbnail?: boolean }): string | undefined;
  /** A command as this reader is served it; `page` is the free-form page asking, whose public commands run through
      its own door. */
  command(ref: UiCommandRef, page?: string): UiCommandHandle;
  viewer(): UiViewer;
  /** Called when the reader signs in, out or as someone else; returns the unsubscribe. */
  subscribeViewer(listener: () => void): () => void;
  column(resource: string, name: string): UiColumn | undefined;
  look(): UiLook;
  token(name: string): string;
  /** Called when the look, the mode or the density changes; returns the unsubscribe. */
  subscribeLook(listener: () => void): () => void;
  /** Whether values are drawn in an App's words (a vocabulary's value as a word). */
  app: boolean;
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
  params: readonly string[];
  loader?: string;
  get(name: string): string | undefined;
  set(name: string, value: string | undefined, options?: { push?: boolean }): void;
}
export const UiPageContext = createContext<UiPageFrame | null>(null);

/* The page's host, set when the SDK is installed (host.tsx), so a value
   renderer drawn in a grid cell — with no provider of its own above it —
   still reads the App. A test provides its own. */
let pageHost: UiHost | null = null;
export function setPageHost(host: UiHost): void {
  pageHost = host;
}

export const UiHostContext = createContext<UiHost | null>(null);

export function useUiHost(): UiHost {
  const host = useContext(UiHostContext) ?? pageHost;
  if (!host) throw new Error(say('tablewalkUiIsDrawn'));
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
