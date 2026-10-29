```ts title="app.ts"
import { defineApp, listView } from '@mistriwork/mistri/app';

export default defineApp({
  name: 'Compass CRM',
  connection: 'compass',
  resources: { opportunity: {} },
  views: { opportunities: listView('Opportunities', 'opportunity') },
  home: 'opportunities',
  nav: ['opportunities'],
});
```

An App directory holds exactly one `app.ts`, `app.mjs` or `app.json`. The
definition is plain data. Helpers such as `defineApp`, `listView`, `page`,
`action` and `metric` return ordinary objects and keep your literals, so a
column a helper names is still type-checked. A view, a list presentation, a
section, a page and a resource action are written with their helper only; an
object written by hand in their place is a type error that names the helper.
Every place takes a fixed set of keys, and an unknown key is refused at load
with the nearest spelling (`Did you mean "label"?`). The complete types are
`schema/app.d.ts`, which ships in the package
(`node_modules/@mistriwork/mistri/schema/app.d.ts`).

[The DSL in one App](/docs/dsl-tour/) builds one step by step, and
[Choose a building block](/docs/choose/) says which key a task wants.

## Typed query strings

```ts
listView('Deals', 'opportunity', { query: 'stage = won' })
// Type '"stage = won"' is not assignable to type
//   '{ "won is not a value of stage: prospecting, …": true; }'.
```

A view's or tab's `query` and `sort`, a dashboard's or page's `query` and
`by`, a rollup's `query`, a command's `when` and a reference field's picker
query are read against the table's columns as you type them, once the App's
generated `mistri-schema.d.ts` registers its `Columns`. A misspelled
column, an operator the language does not have, or a value outside a
column's vocabulary is a type error on the string.

**The limit:** the strings are checked only when the TypeScript project
holds exactly one registered schema. With none (no generated file) or with
two or more (a test or a monorepo root that reaches two Apps' files), the
checking stands down rather than judge one App by another's columns, and
`mistri check` alone judges the strings when the App loads. The guard
reads conditions, operators, measures, group-bys and sorts two references
deep; what it cannot read for certain (a quoted value, `between`, a third
hop) passes to `check`.

## Types and validation

```sh
npx @mistriwork/mistri check --app . --config mistri.json          # types, typecheck, validation
npx @mistriwork/mistri check --app . --config mistri.json --brief  # one line per problem
npx @mistriwork/mistri explain unknown-column                         # one code, with its fix
```

`satisfies App`, with the generated type, checks table, column, connection,
view and look names in the editor, and label paths hop by hop for two hops. A
column no reader is served (`hidden`, or outside every role's `fields`) is
generated apart, as `Hidden`: `hidden`, `fields` and `audit.redact` take it,
and a place that shows, sorts or writes a column does not. `check`
regenerates the types, typechecks, validates against the database and warns
`[restated]` where the App says what the platform already knows. Every code
it prints is on [mistri check](/docs/check-codes/).

**Module graph.** Split an App into `app.ts` (identity, sources, auth, `ui`),
`resources.ts`, `views.ts`, `navigation.ts` and `pages/`. Modules run as
trusted server code in a fresh worker, not a sandbox; a broken edit keeps the
last good definition. Command handlers stay out of this graph. The worker
reads only the environment variables `mistri.json` lists for the App
([secrets](/docs/secrets/)).
