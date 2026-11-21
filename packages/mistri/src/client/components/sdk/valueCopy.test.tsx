/**
 * The custom components' `<Value>` honors a display rule's `copy` as the record does: the record's copy button
 * (CopyValue), the stored value to the clipboard as stored, and what happened said through the host. A field report
 * found the rule ignored on a page of the App's own. Never a button inside a target of its own.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Value } from './kit.js';
import { UiHostContext, type UiHost } from './context.js';

const announced: Array<[string, string]> = [];
const host = {
  app: true,
  column: (resource: string, column: string) =>
    resource === 'shipment' && column === 'tracking_number' ? { label: 'Tracking number', rule: { copy: true } } : undefined,
  announce: (text: string, tone: string) => announced.push([text, tone]),
} as unknown as UiHost;
const withHost = (node: ReactNode) => render(<UiHostContext.Provider value={host}>{node}</UiHostContext.Provider>);

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  announced.length = 0;
  writeText.mockReset();
  writeText.mockImplementation(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

test("a column's copy rule puts the record's named button beside a string, and copying it says so", async () => {
  withHost(<Value value="1Z999AA10123456784" resource="shipment" column="tracking_number" />);
  const button = screen.getByRole('button', { name: 'Copy Tracking number' });
  expect(button).toHaveClass('value-copy');
  expect(button.closest('.value-copyable')?.textContent).toContain('1Z999AA10123456784');
  await userEvent.click(button);
  expect(writeText).toHaveBeenCalledWith('1Z999AA10123456784');
  expect(announced).toEqual([['Copied Tracking number.', 'ok']]);
});

test('a rule said here copies a number as its digits, and a value with no column is named a value', async () => {
  withHost(<Value value={42} display={{ copy: true }} />);
  await userEvent.click(screen.getByRole('button', { name: 'Copy value' }));
  expect(writeText).toHaveBeenCalledWith('42');
});

test('an id past 2^53 is copied as stored, every digit', async () => {
  withHost(<Value value="9007199254740993" display={{ copy: true }} />);
  expect(screen.getByText('9007199254740993')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Copy value' }));
  expect(writeText).toHaveBeenCalledWith('9007199254740993');
});

test('nothing to copy: an empty value is the dash and no button', () => {
  withHost(<Value value={null} display={{ copy: true }} />);
  expect(screen.getByText('—')).toHaveClass('null');
  expect(screen.queryByRole('button')).toBeNull();
});

test('the button is a button to the keyboard: Tab reaches it and Enter copies', async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  withHost(<Value value="A-17" display={{ copy: true }} />);
  await user.tab();
  expect(screen.getByRole('button', { name: 'Copy value' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(writeText).toHaveBeenCalledWith('A-17');
});

test('a refused clipboard is said as a refusal, and no clipboard at all is the same refusal', async () => {
  writeText.mockRejectedValueOnce(new Error('denied'));
  withHost(<Value value="A-17" display={{ copy: true }} />);
  const button = screen.getByRole('button', { name: 'Copy value' });
  await userEvent.click(button);
  expect(announced).toHaveLength(1);
  expect(announced[0]![1]).toBe('error');
  expect(announced[0]![0]).toMatch(/clipboard/i);
  Reflect.deleteProperty(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  await userEvent.click(button);
  expect(announced).toHaveLength(2);
  expect(announced[1]).toEqual(announced[0]);
});

test('never a button inside a target of its own: a link, a button, a row that opens', () => {
  const { container } = withHost(
    <>
      <a href="/shipments/1">
        <Value value="A-1" display={{ copy: true }} />
      </a>
      <div role="button" tabIndex={0}>
        <Value value="A-2" display={{ copy: true }} />
      </div>
      <table>
        <tbody>
          <tr className="clickable">
            <td>
              <Value value="A-3" display={{ copy: true }} />
            </td>
          </tr>
        </tbody>
      </table>
    </>,
  );
  expect(container.querySelectorAll('.value-copy')).toHaveLength(0);
  expect(container.textContent).toContain('A-1');
});

test('a masked value has no button, and no rule no button', () => {
  withHost(
    <>
      <Value value="ENC:abc" display={{ copy: true, masked: { prefix: 'ENC:' } }} />
      <Value value="plain" />
    </>,
  );
  expect(screen.queryByRole('button')).toBeNull();
});
