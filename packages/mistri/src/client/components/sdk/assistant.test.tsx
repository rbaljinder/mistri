/**
 * `useAssistant()` from a page: it opens the App's assistant about the record the person is on, with words in the
 * box and nothing sent; it is offered only where the App serves the reader one, and a record named any other way than
 * by its table and id is the author's mistake, said at once.
 */
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderSection } from './testing.js';
import { Button, useAssistant } from './index.js';

afterEach(cleanup);

function Checkout({ visit }: { visit: number }) {
  const assistant = useAssistant();
  if (!assistant.offered) return <p>No assistant</p>;
  return <Button onClick={() => assistant.open({ about: { table: 'visit', id: visit }, text: 'Check out this visit' })}>Ask</Button>;
}

test('open hands the assistant the record and words for its box', () => {
  const view = renderSection(() => <Checkout visit={12} />, { component: { id: 'checkout' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  expect(view.navigations).toEqual([{ kind: 'assistant', about: { table: 'visit', id: 12 }, text: 'Check out this visit' }]);
});

test('where the reader is served no assistant, it is not offered and opening does nothing', () => {
  let opened: boolean | undefined;
  function Probe() {
    const assistant = useAssistant();
    opened = assistant.open({ text: 'hello' });
    return <p>{assistant.offered ? 'offered' : 'not offered'}</p>;
  }
  const view = renderSection(Probe, { component: { id: 'probe' } }, { assistant: false });
  expect(screen.getByText('not offered')).toBeInTheDocument();
  expect(opened).toBe(false);
  expect(view.navigations).toEqual([]);
});

test('a record named by anything but its table and id is refused at the call', () => {
  let open: ReturnType<typeof useAssistant>['open'] | undefined;
  function Probe() {
    open = useAssistant().open;
    return null;
  }
  renderSection(Probe, { component: { id: 'probe' } });
  expect(() => open!({ about: { table: 'visit', id: { id: 1 } as never } })).toThrow(/table and its id/);
  expect(() => open!({ about: { table: '', id: 1 } })).toThrow(/table and its id/);
});
