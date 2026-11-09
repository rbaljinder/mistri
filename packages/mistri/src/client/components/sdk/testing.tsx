/**
 * `@mistriwork/mistri/ui/testing`: a custom component drawn in a test as the page
 * would draw it, over typed fixture rows instead of a server. Vitest with
 * happy-dom (or jsdom) and Testing Library, the repository's own setup.
 *
 * The fixture host answers what the page's host answers (context.ts): each
 * declared read is the fixture rows of its resource with the declaration's
 * own `show`, `sort` and `limit` applied — what the planner would have asked
 * for; the query is the server's to judge, so the rows a test gives are the
 * rows it answered. `useRows`, `useRecord` and `useBreakdown` read the same
 * rows. Navigation and every command a component runs or opens are recorded,
 * never followed or sent. The App's locale and currency are the test's to
 * say; en-US and USD unless it does.
 */
import { act, cleanup, fireEvent, render, within, type BoundFunctions, type queries, type RenderResult } from '@testing-library/react';
import { createElement, useState, type ComponentType, type ReactNode } from 'react';
import { installShell } from '@mistriwork/kit/client/shellMode.js';
import type { QueryClient } from '@tanstack/react-query';
import type { UiRow } from './context.js';
import { resetReviews, staleReviews } from '../../commandReviews.js';
import { say } from '../../copy/components/components/sdk/testing.js';
import {
  FixtureComponent,
  SectionFrame,
  fixtureClient,
  fixtureHost,
  fixtures,
  sectionProps,
  type AuthoredList,
  type AuthoredPage,
  type AuthoredSection,
  type CommandCall,
  type Example,
  type Navigation,
  type RenderOptions,
} from './fixture.js';

export {
  example,
  examples,
  fixtures,
  type CommandCall,
  type Example,
  type FixtureCatalog,
  type Fixtures,
  type Navigation,
  type RenderOptions,
} from './fixture.js';

/** What changes on the server between two reads: a resource's rows now, and the resources the reader is refused now. */
export interface FixtureChange {
  data?: Record<string, readonly UiRow[]>;
  /** The whole refused set after the change: a resource left out is readable again. */
  refused?: Record<string, 401 | 403>;
}

type Drawn = RenderResult & {
  navigations: Navigation[];
  commands: CommandCall[];
  /**
   * The server changed under the drawn page, then every read was asked again, as a live update or a refocus asks:
   * resolves once the reads have answered. A read that fails now keeps its last good rows (`isStale`), as the
   * page's does; a read never answered shows its refused or failed state.
   */
  refresh(change?: FixtureChange): Promise<void>;
  /**
   * Queries over one region of the page, so a test never runs `getByRole` over the whole of it: the region is a
   * landmark or group with that accessible name (`aria-label`), or the section a `<Panel title>` draws. It throws
   * when no region, or more than one, has the name.
   */
  region(name: string): BoundFunctions<typeof queries>;
};

/* The test's options with fixture tables of their own: a refresh changes this drawing's server, never the test's
   fixtures. The layer inherits the test's tables rather than copying them, so a table is still read only when a read
   asks for it, and a test whose tables throw on read (a dropped connection) fails that read, not the drawing. */
function live(options: RenderOptions): RenderOptions {
  const data = options.data ?? fixtures({});
  return { ...options, data: { tables: Object.create(data.tables) as typeof data.tables, display: data.display } };
}

function refresher(options: RenderOptions, client: QueryClient) {
  return async (change: FixtureChange = {}) => {
    for (const [resource, rows] of Object.entries(change.data ?? {})) options.data!.tables[resource] = rows;
    if (change.refused) options.refused = change.refused;
    /* A table that changed stales every review of it, as live sync does a record's (liveInvalidate.ts). */
    await act(() => {
      for (const resource of Object.keys(change.data ?? {})) staleReviews(resource, 'many');
      return client.invalidateQueries({ queryKey: ['mistri-ui'] });
    });
  };
}

const HEADING = 'h1, h2, h3, h4, h5, h6';
/* The region a name says: `aria-label`, `aria-labelledby`, or the first heading a section opens with (a `<Panel title>`). */
function regionNamed(container: HTMLElement, name: string): HTMLElement {
  const found = [
    ...container.querySelectorAll<HTMLElement>('section, [role="region"], [role="group"], [role="list"], [role="grid"]'),
  ].filter((candidate) => {
    if (candidate.getAttribute('aria-label') === name) return true;
    const labelled = candidate.getAttribute('aria-labelledby');
    if (labelled && labelled.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim() === name)) return true;
    const heading = candidate.querySelector<HTMLElement>(HEADING);
    return candidate.tagName === 'SECTION' && heading?.closest('section') === candidate && heading.textContent?.trim() === name;
  });
  if (found.length !== 1) throw new Error(say('regionNamed', { name, count: found.length }));
  return found[0];
}
const regioned = (view: RenderResult) => (name: string) => within(regionNamed(view.container, name));

function prepare(options: RenderOptions): void {
  /* One drawing at a time: Testing Library unmounts after each test only
     where the runner has globals, and an author's Vitest may not, so the
     last drawing is taken down before the next rather than piling up. */
  cleanup();
  resetReviews();
  installShell({
    format: () => ({
      locale: options.locale ?? 'en-US',
      currency: options.currency ?? 'USD',
      ...(options.timezone ? { timezone: options.timezone } : {}),
    }),
  });
  document.documentElement.dataset.visualTheme = options.look ?? 'workshop';
  document.documentElement.dataset.theme = options.mode ?? 'light';
}

function drawn(
  component: ComponentType<never>,
  declaration: Parameters<typeof FixtureComponent>[0]['declaration'],
  options: RenderOptions,
): Drawn {
  prepare(options);
  const served = live(options);
  const client = fixtureClient();
  const navigations: Navigation[] = [];
  const commands: CommandCall[] = [];
  const view = render(
    <FixtureComponent
      component={component}
      declaration={declaration}
      options={served}
      navigations={navigations}
      commands={commands}
      client={client}
    />,
  );
  return Object.assign(view, { navigations, commands, refresh: refresher(served, client), region: regioned(view) });
}

/** One component in the frame its placement gives it, over this drawing's own fixture server. */
function framed(options: RenderOptions, id: string, className: string | undefined, body: (served: RenderOptions) => ReactNode): Drawn {
  prepare(options);
  const served = live(options);
  const client = fixtureClient();
  const navigations: Navigation[] = [];
  const commands: CommandCall[] = [];
  const view = render(
    <SectionFrame
      host={fixtureHost(served.data!, served, navigations, commands)}
      id={id}
      width={served.width ?? 960}
      client={client}
      {...(className ? { className } : {})}
    >
      {body(served)}
    </SectionFrame>,
  );
  return Object.assign(view, { navigations, commands, refresh: refresher(served, client), region: regioned(view) });
}

/**
 * Draw a custom section's component as the page would: its declared reads
 * answered from `data`, its record's declared fields from `record`, its props
 * the declaration's with their defaults. Returns Testing Library's result and
 * every navigation and command the component asked for.
 */
export function renderSection<P>(component: ComponentType<P>, declaration: AuthoredSection, options: RenderOptions = {}): Drawn {
  return framed(options, declaration.component.id, undefined, (served) =>
    createElement(component as ComponentType<Record<string, unknown>>, sectionProps(declaration, served.data!, served)),
  );
}

/**
 * Draw a list view's custom presentation as the list would: a page of its
 * resource's fixture rows, each with its keys and exactly the presentation's
 * `show`, in the view's `sort`; `page`, `total` and `selection` say the rest.
 */
export function renderList<P>(component: ComponentType<P>, view: AuthoredList, options: RenderOptions = {}): Drawn {
  return drawn(component as ComponentType<never>, view, options);
}

/**
 * Draw a free-form page as the App would (`definePage`'s result): within its declared reads and commands,
 * with `loaded` as its loader's `data`, its address parameters from `address` and kept as the reader moves.
 */
export function renderPage(page: ComponentType<never> & { definition: object }, options: RenderOptions = {}): Drawn {
  return drawn(page, page.definition as AuthoredPage, options);
}

/** Draw a value renderer on one value, as a grid cell (`compact`) or a record field would. */
export function renderValue<P>(
  component: ComponentType<P>,
  declaration: { id: string },
  value: {
    value: unknown;
    row?: Record<string, unknown>;
    column: { name: string; resource: string };
    context?: 'grid' | 'record' | 'card';
  },
  options: RenderOptions = {},
): Drawn {
  const context = value.context ?? 'record';
  const props = { value: value.value, row: value.row, column: value.column, context, compact: context !== 'record' };
  return framed(options, declaration.id, undefined, () => createElement(component as ComponentType<Record<string, unknown>>, props));
}

/** An input component in a form, holding its value as the form would: `view.value()` is what the form now holds. */
function HeldInput({
  component,
  start,
  field,
  context,
  label,
  required,
  onChange,
}: {
  component: ComponentType<Record<string, unknown>>;
  start: string | number | boolean | null;
  field: { name: string; resource?: string };
  context: 'edit' | 'new' | 'command';
  label: string;
  required: boolean;
  onChange: (value: string | number | boolean | null) => void;
}) {
  const [value, setValue] = useState(start);
  return createElement(component, {
    value,
    id: `input-${field.name}`,
    invalid: false,
    disabled: false,
    required,
    label,
    field,
    context,
    onChange: (next: string | number | boolean | null) => {
      setValue(next);
      onChange(next);
    },
  });
}

/** Draw an input component standing in a form's field. Returns what it handed back, in order (`changes`), and the value the form holds now. */
export function renderInput<P>(
  component: ComponentType<P>,
  declaration: { id: string },
  field: {
    value: string | number | boolean | null;
    name: string;
    resource?: string;
    label?: string;
    required?: boolean;
    context?: 'edit' | 'new' | 'command';
  },
  options: RenderOptions = {},
): Drawn & { changes: Array<string | number | boolean | null>; value(): string | number | boolean | null } {
  const changes: Array<string | number | boolean | null> = [];
  const view = framed(options, declaration.id, 'custom-input', () => (
    <HeldInput
      component={component as ComponentType<Record<string, unknown>>}
      start={field.value}
      field={{ name: field.name, ...(field.resource ? { resource: field.resource } : {}) }}
      context={field.context ?? 'edit'}
      label={field.label ?? field.name}
      required={field.required ?? false}
      onChange={(next) => changes.push(next)}
    />
  ));
  return Object.assign(view, { changes, value: () => (changes.length ? changes[changes.length - 1] : field.value) });
}

/**
 * Draw one of a component's examples (the default export and one named
 * `example(…)` of its `*.examples.tsx`) as its story draws it: the test checks
 * exactly what Storybook and the visual matrix show.
 */
export function renderExample(
  meta: { component: ComponentType<never>; parameters: { mistri: { declaration: object; shared: RenderOptions } } },
  story: Example,
  options: RenderOptions = {},
): Drawn {
  const { declaration, shared } = meta.parameters.mistri;
  return drawn(meta.component, declaration as Parameters<typeof FixtureComponent>[0]['declaration'], {
    ...shared,
    ...story.args,
    ...options,
  });
}

/* A drag as the pointer engine hears it: a press on the card, a move past the slop over the lane, a release. happy-dom
   lays nothing out, so the page's hit test is stood in by the lane itself. */
function dragOnto(source: Element, target: Element): void {
  const original = document.elementFromPoint;
  const originals = document.elementsFromPoint;
  document.elementFromPoint = () => target;
  document.elementsFromPoint = () => [target];
  const pointer = (x: number) => ({ pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: x });
  try {
    fireEvent.pointerDown(source, pointer(0));
    fireEvent.pointerMove(window, pointer(10));
    fireEvent.pointerUp(window, pointer(10));
  } finally {
    document.elementFromPoint = original;
    document.elementsFromPoint = originals;
  }
}

const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
/* The scope a helper looks in: the whole document unless a test narrows it (`view.region('Next week')`'s container, say). */
const scoped = (scope?: HTMLElement) => within(scope ?? document.body);

/**
 * A `<Board>` (or a list view's board presentation) as a person meets it: cards in lanes. Each helper answers the
 * element, throwing when it is not there or is there twice, so a test reads `board.card('Broken login')`.
 */
export const board = {
  /** The lane titled `name`: the section a lane's heading opens. */
  lane(name: string, scope?: HTMLElement): HTMLElement {
    const heading = scoped(scope).getByRole('heading', { level: 2, name });
    return heading.closest('section') ?? heading;
  },
  /** The card titled `title`, wherever it stands. */
  card(title: string, scope?: HTMLElement): HTMLElement {
    return scoped(scope).getByRole('button', { name: exactly(title) });
  },
  /** Drops the card titled `title` into the lane `toLane`, as a pointer does; the board asks the page's command to move it. */
  move(title: string, toLane: string, scope?: HTMLElement): void {
    dragOnto(board.card(title, scope), board.lane(toLane, scope));
  },
};

/** A `<Calendar>` (or a list view's calendar presentation): events on days. */
export const calendar = {
  /** The event titled `title`, wherever it falls. */
  event(title: string, scope?: HTMLElement): HTMLElement {
    return scoped(scope).getByRole('button', { name: exactly(title) });
  },
  /** The day `date` (`YYYY-MM-DD`): the grid's cell, or the agenda's entry on a phone. Where an event is dropped to move it. */
  day(date: string, scope?: HTMLElement): HTMLElement {
    const day = (scope ?? document.body).querySelector<HTMLElement>(`[data-date="${date}"]`);
    if (!day) throw new Error(say('noDay', { date }));
    return day;
  },
};
