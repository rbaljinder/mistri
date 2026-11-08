---
title: Page recipes
description: Six small things a free-form page often draws, built from the kit alone, each one tested code you can copy.
keywords: [recipe, free-form page, facts list, progress, history, cards, before and after, copy, print, definePage]
---

Six small things a free-form page often draws, built from the kit alone, each one tested code you can copy.

Each recipe is a component of `@mistriwork/mistri/page` (or `/ui`) and nothing else: no block of its own, no second renderer, and a style only where print needs one. They are drawn and held by `packages/mistri/src/client/components/sdk/recipes.test.tsx`, which also fails if a block below stops being a piece of the code it runs. Import what they use:

```ts
import { Button, Card, Cluster, Heading, Row, Stack, Table, Tone, useFormat, Value } from '@mistriwork/mistri/page';
```

## A facts list

A record's few fields, each named and said as the App says that column (`Value` dresses it with the column's display rule).

```tsx
export function Facts({ resource, record, columns }: { resource: string; record: Fields; columns: Readonly<Record<string, string>> }) {
  return (
    <Stack as="ul" gap="tight">
      {Object.entries(columns).map(([column, label]) => (
        <li key={column}>
          <Row align="baseline">
            <span>{label}</span>
            <Value value={record[column]} resource={resource} column={column} compact />
          </Row>
        </li>
      ))}
    </Stack>
  );
}
```

Use it as `<Facts resource="ticket" record={ticket} columns={{ title: 'Title', priority: 'Priority' }} />`.

## Ordered progress and history

The road a record has taken and what is left. The step it is on carries `aria-current="step"`, so a screen reader hears it too; a step with a time says it in the App's clock.

```tsx
export function Progress({ steps, current }: { steps: readonly { label: string; at?: string }[]; current: number }) {
  const format = useFormat();
  return (
    <Stack as="ol" gap="tight">
      {steps.map((step, index) => (
        <li key={step.label} aria-current={index === current ? 'step' : undefined}>
          <Row align="baseline">
            <Tone tone={index < current ? 'good' : index === current ? 'info' : 'neutral'}>{step.label}</Tone>
            {step.at && <span>{format.dateTime(step.at)}</span>}
          </Row>
        </li>
      ))}
    </Stack>
  );
}
```

## Selected-item cards

A few options as cards with one chosen. The button says whether its card is the one, with `aria-pressed`, and `Cluster` lays the cards out as many across as fit and one on a phone.

```tsx
export function PickCards({
  options,
  value,
  onChange,
}: {
  options: readonly { id: string; title: string; detail: ReactNode }[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  return (
    <Cluster min="12rem">
      {options.map((option) => (
        <Card key={option.id} title={option.title}>
          <Stack gap="tight">
            <div>{option.detail}</div>
            <Button
              size="compact"
              intent={option.id === value ? 'primary' : 'secondary'}
              aria-pressed={option.id === value}
              onClick={() => onChange(option.id)}
            >
              {option.id === value ? 'Selected' : 'Choose'}
            </Button>
          </Stack>
        </Card>
      ))}
    </Cluster>
  );
}
```

Hold the choice where it should survive a reload in a page param (`const [plan, setPlan] = page.useParam('plan')`), and pass it as `value`.

## Before and after

What a change touched, each field's old value beside its new one, in the look's own table. Each value is said as its column is.

```tsx
export function BeforeAfter({
  resource,
  changes,
}: {
  resource: string;
  changes: readonly { column: string; label: string; before: unknown; after: unknown }[];
}) {
  return (
    <Table
      label="What changed"
      rows={changes}
      rowKey={(change) => change.column}
      columns={[
        { key: 'label', label: 'Field' },
        {
          key: 'before',
          label: 'Before',
          render: (change) => <Value value={change.before} resource={resource} column={change.column} compact />,
        },
        {
          key: 'after',
          label: 'After',
          render: (change) => <Value value={change.after} resource={resource} column={change.column} compact />,
        },
      ]}
    />
  );
}
```

## Reveal and copy

A secret kept out of sight until it is asked for, and one press to put it on the clipboard. The status is read aloud when the copy lands.

```tsx
export function RevealCopy({ label, secret }: { label: string; secret: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <Row align="center">
      <code aria-label={label}>{shown ? secret : '••••••••'}</code>
      <Button size="compact" intent="quiet" aria-pressed={shown} onClick={() => setShown(!shown)}>
        {shown ? 'Hide' : 'Show'}
      </Button>
      <Button size="compact" intent="quiet" onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true))}>
        Copy
      </Button>
      <span role="status">{copied ? 'Copied' : ''}</span>
    </Row>
  );
}
```

Fetch the secret only when the reader asks for it (a command that returns it once), not with the page's reads.

## A printable document

A sheet that prints on its own: the Print button prints the page, and the stylesheet hides everything but the sheet. Give the stylesheet to the component (an imported stylesheet is scoped to it, and its classes are named `c-<component>-…`; see [custom components](/docs/custom-components/)).

```tsx
export function Sheet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="c-sheet" aria-label={title}>
      <Row align="center" className="c-sheet-actions">
        <Button size="compact" onClick={() => window.print()}>
          Print
        </Button>
      </Row>
      <Heading>{title}</Heading>
      {children}
    </article>
  );
}
```

```css
@media print {
  body * { visibility: hidden; }
  .c-sheet, .c-sheet * { visibility: visible; }
  .c-sheet { position: absolute; inset: 0; }
  .c-sheet-actions { display: none; }
}
```

## Related

- [Custom components](/docs/custom-components/): the page, the SDK and its rules.
- [Blocks gallery](/docs/blocks/): the platform's own blocks, to rule out first.
