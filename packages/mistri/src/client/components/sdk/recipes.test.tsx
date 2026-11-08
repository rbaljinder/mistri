/**
 * Six small things a page often draws, built from the kit alone, drawn here; the docs quote them
 * (site/.../page-recipes.md) and this file holds the page to them, word for word, so what the page shows is code that
 * compiles and runs. The only style is the one a printed sheet needs (recipes.fixture.css).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { fixtures, renderPage } from './testing.js';
import { Button, Card, Cluster, definePage, Heading, Row, Stack, Table, Tone, useFormat, Value } from './page.js';

type Fields = Readonly<Record<string, unknown>>;

/* A facts list: a record's few fields, each named, said as the App says that column. */
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

/* Ordered progress: the road a record has taken and what is left, the step it is on marked for a screen reader too. */
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

/* Selected-item cards: a few options as cards, one chosen, each card's button saying whether it is the one. */
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

/* Before and after: what a change touched, each field's old value beside its new one. */
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

/* Reveal and copy: a secret kept out of sight until asked for, and one press to put it on the clipboard. */
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

/* A printable document: a sheet that prints alone, without the shell around it or its own Print button. */
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

const viewer = { signedIn: true, account: 'a' };
const draw = (node: React.ReactNode) =>
  renderPage(definePage({ label: 'Recipes', reads: ['ticket'], component: () => <>{node}</> }), { viewer, data: fixtures({ ticket: [] }) });

describe('the recipes', () => {
  test('a facts list names each field and says it as the App does', async () => {
    const view = draw(
      <Facts resource="ticket" record={{ title: 'Leak', priority: 'high' }} columns={{ title: 'Title', priority: 'Priority' }} />,
    );
    const items = await view.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('TitleLeak');
    expect(items[1]).toHaveTextContent('Priorityhigh');
  });

  test('progress marks the step the record is on and dates the ones it has taken', async () => {
    const view = draw(
      <Progress current={1} steps={[{ label: 'Reported', at: '2026-03-02T15:00:00Z' }, { label: 'Scheduled' }, { label: 'Done' }]} />,
    );
    const items = await view.findAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(items[0]).toHaveTextContent('Reported');
    expect(items[0]).toHaveTextContent('2026');
  });

  test('pick cards choose one and say which', async () => {
    const options = [
      { id: 'a', title: 'Basic', detail: '$10' },
      { id: 'b', title: 'Plus', detail: '$20' },
    ];
    function Plans() {
      const [value, setValue] = useState<string | undefined>('a');
      return <PickCards options={options} value={value} onChange={setValue} />;
    }
    const view = draw(<Plans />);
    expect(await view.findByRole('button', { name: 'Selected' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(view.getByRole('button', { name: 'Choose' }));
    await waitFor(() => expect(view.getAllByRole('button')[1]).toHaveAttribute('aria-pressed', 'true'));
    expect(view.getAllByRole('button')[0]).toHaveAttribute('aria-pressed', 'false');
  });

  test('before and after put the old value beside the new one', async () => {
    const view = draw(
      <BeforeAfter resource="ticket" changes={[{ column: 'priority', label: 'Priority', before: 'low', after: 'high' }]} />,
    );
    const row = (await view.findByRole('table', { name: 'What changed' })).querySelector('tbody tr')!;
    expect(row).toHaveTextContent('Prioritylowhigh');
  });

  test('a secret stays hidden until shown, and copies on one press', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const view = draw(<RevealCopy label="API key" secret="sk-123" />);
    expect(await view.findByLabelText('API key')).toHaveTextContent('••••••••');
    fireEvent.click(view.getByRole('button', { name: 'Show' }));
    expect(view.getByLabelText('API key')).toHaveTextContent('sk-123');
    fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('sk-123');
    expect(await view.findByText('Copied')).toBeVisible();
  });

  test('a sheet prints on its own button', async () => {
    const print = vi.fn();
    Object.defineProperty(window, 'print', { value: print, configurable: true });
    const view = draw(
      <Sheet title="Work order 12">
        <p>Replace the valve.</p>
      </Sheet>,
    );
    fireEvent.click(await view.findByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('article', { name: 'Work order 12' })).toHaveTextContent('Replace the valve.');
  });
});

describe('the recipes page', () => {
  const sdk = import.meta.dirname;
  const page = readFileSync(join(import.meta.dirname, '../../../../../../site/src/content/docs/docs/page-recipes.md'), 'utf8');
  const source = readFileSync(join(sdk, 'recipes.test.tsx'), 'utf8');
  const style = readFileSync(join(sdk, 'recipes.fixture.css'), 'utf8');
  const fences = [...page.matchAll(/^```(tsx|css)\n([\s\S]*?)^```$/gm)].map(([, language, body]) => ({ language, body: body.trim() }));

  test('quotes all six recipes', () => {
    expect(fences.filter((fence) => fence.language === 'tsx')).toHaveLength(6);
  });

  test('quotes the fixture word for word', () => {
    for (const fence of fences) expect(fence.language === 'css' ? style : source, fence.body.split('\n')[0]).toContain(fence.body);
  });
});
