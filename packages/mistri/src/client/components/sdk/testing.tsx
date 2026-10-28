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
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { createElement, useState, type ComponentType } from 'react';
import { installShell } from '@mistriwork/kit/client/shellMode.js';
import {
  FixtureComponent,
  SectionFrame,
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
  type Fixtures,
  type Navigation,
  type RenderOptions,
} from './fixture.js';

type Drawn = RenderResult & { navigations: Navigation[]; commands: CommandCall[] };

function prepare(options: RenderOptions): void {
  /* One drawing at a time: Testing Library unmounts after each test only
     where the runner has globals, and an author's Vitest may not, so the
     last drawing is taken down before the next rather than piling up. */
  cleanup();
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
  const navigations: Navigation[] = [];
  const commands: CommandCall[] = [];
  const view = render(
    <FixtureComponent component={component} declaration={declaration} options={options} navigations={navigations} commands={commands} />,
  );
  return Object.assign(view, { navigations, commands });
}

/**
 * Draw a custom section's component as the page would: its declared reads
 * answered from `data`, its record's declared fields from `record`, its props
 * the declaration's with their defaults. Returns Testing Library's result and
 * every navigation and command the component asked for.
 */
export function renderSection<P>(component: ComponentType<P>, declaration: AuthoredSection, options: RenderOptions = {}): Drawn {
  prepare(options);
  const data = options.data ?? fixtures({});
  const navigations: Navigation[] = [];
  const commands: CommandCall[] = [];
  const view = render(
    <SectionFrame host={fixtureHost(data, options, navigations, commands)} id={declaration.component.id} width={options.width ?? 960}>
      {createElement(component as ComponentType<Record<string, unknown>>, sectionProps(declaration, data, options))}
    </SectionFrame>,
  );
  return Object.assign(view, { navigations, commands });
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
  prepare(options);
  const navigations: Navigation[] = [];
  const commands: CommandCall[] = [];
  const context = value.context ?? 'record';
  const props = { value: value.value, row: value.row, column: value.column, context, compact: context !== 'record' };
  const view = render(
    <SectionFrame
      host={fixtureHost(options.data ?? fixtures({}), options, navigations, commands)}
      id={declaration.id}
      width={options.width ?? 960}
    >
      {createElement(component as ComponentType<Record<string, unknown>>, props)}
    </SectionFrame>,
  );
  return Object.assign(view, { navigations, commands });
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
  prepare(options);
  const changes: Array<string | number | boolean | null> = [];
  const navigations: Navigation[] = [];
  const commands: CommandCall[] = [];
  const view = render(
    <SectionFrame
      host={fixtureHost(options.data ?? fixtures({}), options, navigations, commands)}
      id={declaration.id}
      width={options.width ?? 960}
      className="custom-input"
    >
      <HeldInput
        component={component as ComponentType<Record<string, unknown>>}
        start={field.value}
        field={{ name: field.name, ...(field.resource ? { resource: field.resource } : {}) }}
        context={field.context ?? 'edit'}
        label={field.label ?? field.name}
        required={field.required ?? false}
        onChange={(next) => changes.push(next)}
      />
    </SectionFrame>,
  );
  return Object.assign(view, { navigations, commands, changes, value: () => (changes.length ? changes[changes.length - 1] : field.value) });
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
