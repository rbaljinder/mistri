import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useContext } from 'react';
import { BesideDetail } from '../../../../kit/src/client/components/besideDetail.js';
import { SplitListDetail } from './SplitListDetail.js';

let mobile = false;
let mediaListeners: Array<(event: MediaQueryListEvent) => void> = [];

beforeEach(() => {
  mobile = false;
  mediaListeners = [];
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 760px)' && mobile,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      mediaListeners.push(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      mediaListeners = mediaListeners.filter((item) => item !== listener);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      mediaListeners.push(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      mediaListeners = mediaListeners.filter((item) => item !== listener);
    },
    dispatchEvent: () => true,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('keeps the list and an empty detail pane stable until a record is selected', () => {
  render(
    <SplitListDetail
      list={
        <ul>
          <li>One</li>
        </ul>
      }
    />,
  );
  expect(screen.getByRole('region', { name: 'List' })).toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: 'Details' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Select a record to see its details.');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('the list knows when it stands beside an open pane, so its grid keeps to its width', () => {
  function Probe() {
    return <p>{useContext(BesideDetail) ? 'beside' : 'alone'}</p>;
  }
  const { rerender } = render(<SplitListDetail list={<Probe />} />);
  expect(screen.getByText('alone')).toBeInTheDocument();
  rerender(<SplitListDetail list={<Probe />} selected detail={<p>Record</p>} />);
  expect(screen.getByText('beside')).toBeInTheDocument();
  cleanup();
  // A phone's detail is a dialog over the list, which keeps the whole width.
  mobile = true;
  render(<SplitListDetail list={<Probe />} selected detail={<p>Record</p>} />);
  expect(screen.getByText('alone')).toBeInTheDocument();
});

test('renders one guarded desktop detail pane and closes through the host', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const isCurrent = vi.fn(() => true);
  render(
    <SplitListDetail
      selected
      detailTitle="Task"
      list={<div>Tasks</div>}
      detail={<p>Task body</p>}
      onCloseDetail={onClose}
      isCurrent={isCurrent}
    />,
  );
  expect(screen.getByRole('complementary', { name: 'Details' })).toHaveTextContent('Task body');
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Close task' }));
  expect(isCurrent).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

test('does not close a stale owner', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<SplitListDetail selected list={<div>Tasks</div>} detail={<p>Task body</p>} onCloseDetail={onClose} isCurrent={() => false} />);
  await user.click(screen.getByRole('button', { name: 'Close details' }));
  expect(onClose).not.toHaveBeenCalled();
});

test("draws the record's own controls in the one head, between its title and Close", () => {
  render(
    <SplitListDetail
      selected
      detailTitle="Issue"
      list={<div>Issues</div>}
      detail={<p>Issue body</p>}
      detailActions={<button type="button">Details →</button>}
    />,
  );
  const pane = screen.getByRole('complementary', { name: 'Details' });
  const head = pane.querySelector('.split-list-detail-head') as HTMLElement;
  expect(head.querySelector('.split-list-detail-title')).toHaveTextContent('Issue');
  expect(
    within(head)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Details →', '×']);
  expect(pane.querySelector('.split-list-detail-body')).toHaveTextContent('Issue body');
});

test('measures itself by its own host, so a narrow room can stack the detail under the list', () => {
  const { container } = render(<SplitListDetail list={<div>Tasks</div>} />);
  expect(container.firstElementChild).toHaveClass('split-list-detail-host');
  expect(container.querySelector('.split-list-detail-host > .split-list-detail')).not.toBeNull();
});

test('uses the existing fullscreen modal as the narrow-screen fallback', async () => {
  mobile = true;
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <SplitListDetail
      selected
      detailTitle="Task"
      list={<div>Tasks</div>}
      detail={<p>Task body</p>}
      detailActions={<button type="button">Details →</button>}
      onCloseDetail={onClose}
    />,
  );
  const dialog = screen.getByRole('dialog', { name: 'Details' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(dialog).toHaveClass('modal-fullscreen-mobile');
  expect(within(dialog).getByRole('button', { name: 'Details →' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Details' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Close task' }));
  expect(onClose).toHaveBeenCalledOnce();
});

test('switches presentation when the viewport changes without duplicating detail', () => {
  const { rerender } = render(<SplitListDetail selected list={<div>Tasks</div>} detail={<p>Task body</p>} />);
  expect(screen.getByRole('complementary', { name: 'Details' })).toBeInTheDocument();
  mobile = true;
  mediaListeners.forEach((listener) => listener(new Event('change') as MediaQueryListEvent));
  rerender(<SplitListDetail selected list={<div>Tasks</div>} detail={<p>Task body</p>} />);
  expect(screen.getByRole('dialog', { name: 'Details' })).toBeInTheDocument();
  expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
});

test('compact editor layout and full collection mode are explicit reusable choices', () => {
  const { container } = render(<SplitListDetail listWidth="compact" expandList list={<p>Flags</p>} />);
  expect(container.querySelector('.split-list-detail')).toHaveClass('split-list-detail-compact', 'split-list-detail-expand');
  expect(container.querySelector('.split-list-detail')).toHaveAttribute('data-selected', 'false');
});
