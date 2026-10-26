/**
 * `@mistriwork/mistri/page`: a free-form page, one file each (`pages/<path>.page.tsx`); the file's name is its path.
 *
 *   const page = definePage({ label: 'Pick walk', reads: ['pick_list'], commands: ['pickList'],
 *     params: ['list'], loader: 'pickWalk', component: PickWalk });
 *   export default page;
 *   function PickWalk({ data }) { const [list, setList] = page.useParam('list'); … }
 *
 * What the page says of itself is read by the server without drawing it
 * (server/app/appPages.ts) and served back as its manifest, which the page
 * is drawn inside (UiPageFrame): the hooks bound to the definition read and
 * run only what it declares, and its loader's result arrives as `data`.
 *
 * `definePage` hands back a component — the page itself — with its hooks on
 * it. They are the SDK's own hooks: `page.useX` is the shape so the types
 * can bind them to this page's reads, commands and parameters
 * (packages/mistri/schema/page.d.ts), and so a linter still sees them as hooks.
 *
 * The blocks are the kit's (kit.tsx), the platform's own command form, the layout's `Grid` and `Panel`, and the
 * platform's sections as components (blocks.tsx), each loaded when a page first draws one.
 * In the page this module is the page's own, reached through the import map
 * like `@mistriwork/mistri/ui`; its value exports are `PAGE_EXPORTS` (shared/uiSdk.ts).
 */
import { createElement, type ComponentType, type ReactNode } from 'react';
import { useAddressState, useBreakdown, useCommand, useFile, useRecord, useRows } from './hooks.js';
import { Button } from './kit.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { pageBlocks } from './pageBlocks.js';
import { say } from '../../copy/components/components/sdk/page.js';

export { Card, Columns, Empty, Heading, Row, Stack, Stat, Value } from './kit.js';
export { Button };
/* A page's place in its address: `page.useParam` is this hook, typed to the page's `params`; this one is for a module
   the page draws that is not the page itself (a widget, the Console's rooms). */
export { useAddressState };

/* The platform's blocks (blocks.tsx): a part of their own, loaded when a page first draws one. They draw the
   platform's rooms, which reach this module again through the host, so the module that draws a free-form page hands
   in how they load (pageBlocks.ts) rather than this one importing them. */
const blocks = () => pageBlocks<typeof import('./blocks.js')>(say('blocksUnregistered'));
export const Rows = onDemand(blocks, 'Rows');
export const RecordCard = onDemand(blocks, 'RecordCard');
export const Metric = onDemand(blocks, 'Metric');
export const Chart = onDemand(blocks, 'Chart');
export const Breakdown = onDemand(blocks, 'Breakdown');
export const Timeline = onDemand(blocks, 'Timeline');
export const Tree = onDemand(blocks, 'Tree');
export const Gantt = onDemand(blocks, 'Gantt');
export const Assistant = onDemand(blocks, 'Assistant');
export const Tabs = onDemand(blocks, 'Tabs');

/** The page's grid: blocks and panels side by side by their `width`, wrapping as a dashboard's sections do. */
export function Grid({ children }: { children?: ReactNode }) {
  return <div className="page-body">{children}</div>;
}

/** A titled region of the grid, a dashboard section's box: `<Panel title="Open lines" width="half">…</Panel>`. */
export function Panel({
  title,
  width = 'full',
  children,
}: {
  title?: ReactNode;
  width?: 'full' | 'half' | 'third' | 'two-thirds';
  children?: ReactNode;
}) {
  return (
    <section className={`page-section width-${width}`}>
      {title !== undefined && <h2 className="page-section-title">{title}</h2>}
      {children}
    </section>
  );
}

/** What a page's component is drawn with: its loader's result, and the props the platform placed it with. */
export interface PageProps<D = unknown> {
  data: D;
  props: Readonly<Record<string, unknown>>;
}

const FIELDS = ['label', 'icon', 'nav', 'roles', 'reads', 'commands', 'params', 'loader', 'public', 'description', 'favorite'];

/** A page as `definePage` makes it: the component that draws it, its definition and its hooks. */
export interface PageDefinition<D = unknown> {
  (props: PageProps<D>): ReactNode;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly useRows: typeof useRows;
  readonly useRecord: typeof useRecord;
  readonly useBreakdown: typeof useBreakdown;
  readonly useFile: typeof useFile;
  readonly useCommand: typeof useCommand;
  readonly useParam: typeof useAddressState;
}

/** A free-form page: its label, reads, commands, parameters and loader, and the component that draws it. */
export function definePage<D = unknown>(
  definition: Record<string, unknown> & { component: ComponentType<PageProps<D>> },
): PageDefinition<D> {
  if (!definition || typeof definition !== 'object' || typeof definition.component !== 'function')
    throw new TypeError(say('definePageTakes'));
  const { component, ...fields } = definition;
  for (const name of Object.keys(fields)) if (!FIELDS.includes(name)) throw new TypeError(say('definePageHasNo', { name }));
  const draw = component;
  const Page = (props: PageProps<D>) => createElement(draw, props);
  return Object.assign(Page, {
    definition: Object.freeze(fields),
    useRows,
    useRecord,
    useBreakdown,
    useFile,
    useCommand,
    useParam: useAddressState,
  });
}

/**
 * A command's own form, behind a button: `<CommandForm command="releaseOrder" />`, or on one record,
 * `<CommandForm command="pickList" record={{ id: 12 }} />`. The platform's dialog, the one pipeline;
 * the button is not drawn for a reader who may not run the command.
 */
export function CommandForm({
  command,
  record,
  label,
  intent = 'secondary',
  onDone,
}: {
  command: string;
  record?: Readonly<Record<string, unknown>>;
  label?: ReactNode;
  intent?: 'primary' | 'secondary' | 'quiet';
  onDone?: (outcome: Awaited<ReturnType<ReturnType<typeof useCommand>['open']>>) => void;
}) {
  const handle = useCommand(command);
  const key = record ?? {};
  if (!handle.granted) return null;
  const busy = handle.pending(key);
  return (
    <Button
      intent={intent}
      busy={busy}
      disabled={busy || handle.available(key) === false}
      onClick={() => void handle.open(key).then((outcome) => onDone?.(outcome))}
    >
      {label ?? handle.label}
    </Button>
  );
}
