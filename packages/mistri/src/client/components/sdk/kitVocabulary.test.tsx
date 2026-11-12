/**
 * The page kit's rc.43 vocabulary (a field report), each as a page meets it: a Card's description and tone, an Item's
 * lead column and tone, Items nested in a Card, `Loaded` with `loading` and `empty={null}`, `Skeleton`, a Button with an
 * address, and the roles a viewer holds.
 */
import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderSection } from './testing.js';
import { Button, Card, Item, Items, Loaded, Skeleton } from './kit.js';
import { useViewer } from './index.js';

afterEach(cleanup);

const drawn = (children: React.ReactNode) => renderSection(() => <>{children}</>, { component: { id: 'vocabulary' } });
const read = (data: unknown, more: object = {}) => ({ data, isError: false, error: null, refetch: () => undefined, ...more }) as never;

describe('Card', () => {
  test('a description is one quiet line under the title, and a tone says the title in its ink', () => {
    drawn(
      <Card title="Overdue" description="Nothing has moved in a week" tone="bad">
        body
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Overdue' }).className).toBe('kit-card-title kit-card-title-bad');
    expect(screen.getByText('Nothing has moved in a week').className).toBe('kit-card-description');
  });

  test('with neither, the title is as it was', () => {
    drawn(<Card title="Plain" />);
    expect(screen.getByRole('heading', { name: 'Plain' }).className).toBe('kit-card-title');
    expect(document.querySelector('.kit-card-description')).toBeNull();
  });
});

describe('Item', () => {
  test('a tone alone is a mark in the lead column; beside a lead it says the lead in its ink', () => {
    drawn(
      <Items label="Jobs">
        <Item title="Marked" tone="warn" />
        <Item title="Led" lead="09:30" tone="good" />
        <Item title="Bare" />
      </Items>,
    );
    const [marked, led, bare] = screen.getAllByRole('listitem');
    expect(marked!.querySelector('.kit-item-lead-warn .kit-item-mark')).not.toBeNull();
    expect(led!.querySelector('.kit-item-lead-good')?.textContent).toBe('09:30');
    expect(led!.querySelector('.kit-item-mark')).toBeNull();
    expect(bare!.querySelector('.kit-item-lead')).toBeNull();
  });

  test('an action is the action’s own click and never opens the row', () => {
    let opened = 0;
    let acted = 0;
    drawn(
      <Items>
        <Item title="Row" onClick={() => opened++} action={<button onClick={() => acted++}>Act</button>} />
      </Items>,
    );
    fireEvent.click(screen.getByText('Act'));
    expect([opened, acted]).toEqual([0, 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Row' }));
    expect(opened).toBe(1);
  });
});

describe('Items', () => {
  test('an empty list inside a Card is flush; on its own it is not', () => {
    drawn(
      <>
        <Card title="In">
          <Items empty="Nothing in the card" />
        </Card>
        <Items empty="Nothing alone" />
      </>,
    );
    expect(screen.getByText('Nothing in the card').className).toBe('kit-items-empty kit-items-empty-flush');
    expect(screen.getByText('Nothing alone').className).toBe('kit-items-empty');
  });
});

describe('Loaded', () => {
  test('`loading` is drawn in place of the bar while the read is out, announced once', () => {
    drawn(
      <Loaded query={read(undefined)} loading={<Skeleton lines={2} />} height={80}>
        {() => <p>data</p>}
      </Loaded>,
    );
    const status = screen.getByRole('status');
    expect(status.querySelectorAll('.kit-skeleton-bar')).toHaveLength(2);
    expect(status.querySelector('.kit-loading')).toBeNull();
  });

  test('without `loading` the bar holds the height', () => {
    drawn(
      <Loaded query={read(undefined)} height={80}>
        {() => <p>data</p>}
      </Loaded>,
    );
    expect(screen.getByRole('status').className).toContain('kit-loading');
  });

  test('`empty={null}` draws nothing; `empty` left out is the house sentence', () => {
    const { container } = render(
      <Loaded query={read([])} empty={null}>
        {() => <p>data</p>}
      </Loaded>,
    );
    expect(container.textContent).toBe('');
    cleanup();
    drawn(<Loaded query={read([])}>{() => <p>data</p>}</Loaded>);
    expect(document.body.textContent).not.toBe('');
    cleanup();
    drawn(
      <Loaded query={read(undefined, { refused: true })} empty={null}>
        {() => <p>data</p>}
      </Loaded>,
    );
    expect(document.body.textContent).toBe('');
  });
});

describe('Skeleton', () => {
  test('is hidden from assistive technology, sized as asked, and a paragraph ends short', () => {
    drawn(
      <>
        <span data-testid="one">
          <Skeleton height={32} width={120} />
        </span>
        <span data-testid="many">
          <Skeleton lines={3} />
        </span>
      </>,
    );
    const one = screen.getByTestId('one').querySelector<HTMLElement>('.kit-skeleton')!;
    expect(one.getAttribute('aria-hidden')).toBe('true');
    const bar = one.querySelector<HTMLElement>('.kit-skeleton-bar')!;
    expect([bar.style.blockSize, bar.style.inlineSize]).toEqual(['32px', '120px']);
    const bars = screen.getByTestId('many').querySelectorAll<HTMLElement>('.kit-skeleton-bar');
    expect([...bars].map((b) => b.style.inlineSize)).toEqual(['', '', '60%']);
  });
});

describe('Button', () => {
  test('without an address it is a button; with one it is a link in the button’s dress', () => {
    drawn(
      <>
        <Button>Save</Button>
        <Button href="https://example.test/x">Docs</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link.getAttribute('href')).toBe('https://example.test/x');
    expect(link.className).toContain('btn');
  });

  test('an address of this App is followed in place; a modified click or another origin keeps the browser’s', () => {
    const view = drawn(
      <>
        <Button href="/leads/127">Open</Button>
        <Button href="//evil.test/x">Elsewhere</Button>
      </>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Open' }));
    expect(view.navigations).toEqual([{ kind: 'address', href: '/leads/127' }]);
    fireEvent.click(screen.getByRole('link', { name: 'Open' }), { ctrlKey: true });
    fireEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    expect(view.navigations).toHaveLength(1);
  });
});

describe('useViewer', () => {
  test('carries the roles the reader holds here, none when signed out', () => {
    let viewer!: ReturnType<typeof useViewer>;
    function Who() {
      viewer = useViewer();
      return null;
    }
    renderSection(Who, { component: { id: 'who' } }, { viewer: { signedIn: true, account: '4', roles: ['agent', 'lead'] } as never });
    expect(viewer.roles).toEqual(['agent', 'lead']);
    cleanup();
    renderSection(Who, { component: { id: 'who' } });
    expect(viewer.roles).toEqual([]);
  });

  test('hands the same roles array on every draw, so an effect that depends on it does not run again', () => {
    const seen: unknown[] = [];
    function Who() {
      const [, again] = useState(0);
      seen.push(useViewer().roles);
      return <button onClick={() => again((count) => count + 1)}>again</button>;
    }
    renderSection(Who, { component: { id: 'who' } }, { viewer: { signedIn: true, account: '4', roles: ['agent'] } as never });
    fireEvent.click(screen.getByText('again'));
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
  });
});
