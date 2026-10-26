/**
 * `@mistriwork/mistri/ui/testing`: a custom component drawn in a test as the page draws
 * it, over typed fixture rows instead of a server. Vitest with happy-dom (or
 * jsdom) and Testing Library — install `@testing-library/react` beside it.
 *
 *   import { fixtures, renderSection } from '@mistriwork/mistri/ui/testing';
 *   const data = fixtures<Rows>({ pay_run: [{ id: 1, title: 'Aug 1–15', pay_date: '2026-08-20', status: 'paid' }] });
 *   const view = renderSection(PayHistory, payHistory, { data, width: 390 });
 *   view.getByRole('list');
 *
 * Each declared read is the fixture rows of its resource with the
 * declaration's own `show`, `sort` and `limit` applied — what the planner
 * would have asked for; its query is the server's to judge, so the rows a test
 * gives are the rows it answered. Navigation is recorded, never followed.
 */
import type { RenderResult } from '@testing-library/react';
import type { ComponentType } from 'react';
import type { OpenMode, ToneName, UiRow, ValueDisplay } from './ui.js';
import type { FlagValue } from './app.js';

/** Rows by resource, and the display rules the App would dress them with. */
export interface Fixtures { tables: Record<string, readonly UiRow[]>; display: Record<string, ValueDisplay> }

/** Typed fixture rows — `fixtures<Rows>({ pay_run: [{ id: 1, … }] })` — and, by `resource.column`, display rules: `{ display: { 'pay_run.status': { tone: {…} } } }`. */
export declare function fixtures<R = Record<string, UiRow>>(
  tables: { [T in keyof R]?: ReadonlyArray<Partial<R[T]>> },
  options?: { display?: Record<string, ValueDisplay> },
): Fixtures;

export type Navigation =
  | { kind: 'record'; resource: string; key: Readonly<Record<string, unknown>>; mode: OpenMode }
  | { kind: 'view'; view: string; tab?: string }
  | { kind: 'form'; view: string; prefill: Readonly<Record<string, string | number>> }
  | { kind: 'composer'; text: string; mode?: 'reply' | 'note' };

/** A command a component ran or opened, recorded instead of sent. */
export interface CommandCall { command: string; mode: 'run' | 'open'; key: Readonly<Record<string, unknown>>; input?: Readonly<Record<string, unknown>> }
export type CommandOutcome = { status: 'applied'; message?: string; output?: unknown } | { status: 'refused'; message: string } | { status: 'closed' };

export interface RenderOptions {
  /** Evaluated values only; these fixtures never grant access or record exposure. */
  flags?: Readonly<Record<string, FlagValue>>;
  data?: Fixtures;
  /** The page's record, for a section that declares `record`: its declared fields are read from here. */
  record?: UiRow;
  /** Props over the declaration's own. */
  props?: Record<string, unknown>;
  look?: string;
  mode?: 'light' | 'dark';
  /** The section's width in pixels; below 420 it is compact, as on a phone. */
  width?: number;
  /** The App's `ui.locale`, `ui.currency` and `ui.timezone`; en-US and USD unless said. */
  locale?: string;
  currency?: string;
  timezone?: string;
  /** What `useToken` answers, by name. */
  tokens?: Record<string, string>;
  /** Who is reading; signed out unless said. */
  viewer?: { signedIn: boolean; account?: string };
  /** The commands the reader is served, by id: its label, whether it is available on a record (true unless said), what a run answers
      (applied unless said). A command not named here is not granted, and none is to a signed-out reader. */
  commands?: Record<string, { label?: string; available?: (key: Readonly<Record<string, unknown>>) => boolean; outcome?: CommandOutcome }>;
  /** A free-form page's address parameters as the reader arrived with them. */
  address?: Record<string, string>;
  /** What a free-form page's loader answers: the page is drawn with it as `data`. */
  loaded?: unknown;
  /** A custom list's page and its total; its rows are its resource's fixture rows in the view's sort. */
  page?: { index: number; size: number };
  total?: number;
  /** Whether the list offers a selection, as one with bulk actions does. */
  selection?: boolean;
  /** What `useFile` answers, by `resource/key` (`member_avatar/4`): a story's pictures. */
  files?: Record<string, string>;
  /** The App's catalog `useMessage` says, in the language under test: `{ 'help.title': 'Help center' }`. A key left out is said as itself. */
  messages?: Record<string, string>;
}

type Drawn = RenderResult & { navigations: Navigation[]; commands: CommandCall[] };

/** Draw a custom section's component: its declared reads answered from `data`, its record from `record`, its props with their defaults. */
export declare function renderSection<P>(component: ComponentType<P>, declaration: object, options?: RenderOptions): Drawn;
/** Draw a list view's custom presentation (`customList`): a page of its resource's fixture rows with the presentation's `show`. */
export declare function renderList<P>(component: ComponentType<P>, view: object, options?: RenderOptions): Drawn;
/** Draw a free-form page (`definePage`'s result) within its declared reads and commands, `loaded` as its loader's `data`, its
    address parameters from `address`, kept as the page moves. */
export declare function renderPage(page: ComponentType<never> & { definition: object }, options?: RenderOptions): Drawn;

/** Draw a value renderer on one value, as a record field (`context: 'record'`) or a cell (`'grid'`, compact). */
export declare function renderValue<P>(component: ComponentType<P>, declaration: { id: string }, value: {
  value: unknown; row?: UiRow; column: { name: string; resource: string }; context?: 'grid' | 'record' | 'card';
}, options?: RenderOptions): Drawn;
/** Draw an input component standing in a form's field: `changes` is every value it handed back, `value()` what the form holds now. */
export declare function renderInput<P>(component: ComponentType<P>, declaration: { id: string }, field: {
  value: string | number | boolean | null; name: string; resource?: string; label?: string; required?: boolean; context?: 'edit' | 'new' | 'command';
}, options?: RenderOptions): Drawn & { changes: Array<string | number | boolean | null>; value(): string | number | boolean | null };

/** One example of a component: `export const Phone = example({ width: 360, mode: 'dark' })` in its `*.examples.tsx`. */
export interface Example { args: RenderOptions; name?: string }
export declare function example(options: RenderOptions, name?: string): Example;
/**
 * A component's examples — the default export of an App's `widgets/*.examples.tsx`, beside one `export const Name = example({…})`
 * each. Storybook draws each as a story (its indexer reads the `example(` exports), and a test draws the same one with `renderExample`.
 */
export declare function examples(component: ComponentType<never>, declaration: object, shared?: RenderOptions, meta?: { title?: string }): {
  title?: string; component: ComponentType<never>; parameters: { mistri: { declaration: object; shared: RenderOptions } }; render(args: RenderOptions): unknown;
};
/** Draw one of a component's examples as its story draws it. */
export declare function renderExample(meta: ReturnType<typeof examples>, story: Example, options?: RenderOptions): Drawn;

export type { ToneName };
