import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommandOutcome } from './CommandOutcome.js';
import { fieldWord, outcomeOfOperation, pendingOf, refusalNext } from './outcomeModel.js';
import { resultLinks, toastDone } from './commandResult.js';
import { toast } from '@mistriwork/kit/client/core.js';

vi.mock('@mistriwork/kit/client/core.js', async (original) => ({ ...(await original<object>()), toast: vi.fn() }));
import { formFailureOutcome } from './FormSurface.js';

afterEach(cleanup);

const view = (container: HTMLElement) => container.querySelector('.command-outcome')!;
const text = (container: HTMLElement, part: string) => container.querySelector(`.command-outcome-${part}`)?.textContent;

test('done: the command’s own words for what changed, and a way to the record when the person is not on it', () => {
  const outcome = outcomeOfOperation(
    { phase: 'success', message: 'Booked Ana for 2026-11-09.', said: 'Booked Ana for 2026-11-09.' },
    { record: { label: 'Smoke alarm chirping' } },
  );
  expect(outcome).toEqual({ state: 'done', said: 'Booked Ana for 2026-11-09.', changed: { label: 'Smoke alarm chirping' } });
  const open = vi.fn();
  const { container } = render(<CommandOutcome outcome={outcome} onOpen={open} />);
  expect(view(container).getAttribute('data-state')).toBe('done');
  expect(text(container, 'title')).toBe('Done');
  expect(text(container, 'body')).toBe('Booked Ana for 2026-11-09.');
  fireEvent.click(screen.getByRole('button', { name: 'Open Smoke alarm chirping' }));
  expect(open).toHaveBeenCalledOnce();
  cleanup();
  // A handler that says nothing still says the change is saved; on the record itself there is nothing to open.
  const { container: plain } = render(<CommandOutcome outcome={outcomeOfOperation({ phase: 'success', message: 'Completed.' })} />);
  expect(text(plain, 'body')).toBe('The change is saved.');
  expect(screen.queryByRole('button')).toBeNull();
});

test('pending: on its way, checking a lost answer, queued, or awaiting approval — the handler says which it accepted', () => {
  expect(outcomeOfOperation({ phase: 'pending', message: 'Submitting…' })).toEqual({ state: 'pending', waiting: 'sending' });
  expect(outcomeOfOperation({ phase: 'pending', message: 'Checking…', checking: true })).toEqual({ state: 'pending', waiting: 'checking' });
  expect(pendingOf({ message: 'x', pending: 'approval' })).toBe('approval');
  expect(pendingOf({ pending: 'later' })).toBeUndefined();
  const queued = outcomeOfOperation({ phase: 'success', message: 'Done', output: { pending: 'queued' } });
  expect(queued).toMatchObject({ state: 'pending', waiting: 'queued' });
  const approval = outcomeOfOperation({
    phase: 'success',
    message: 'Sent to a manager.',
    said: 'Sent to a manager.',
    output: { message: 'Sent to a manager.', pending: 'approval' },
  });
  const { container } = render(<CommandOutcome outcome={approval} />);
  expect(view(container).getAttribute('data-state')).toBe('pending');
  expect(view(container).getAttribute('data-waiting')).toBe('approval');
  expect(text(container, 'title')).toBe('Awaiting approval');
  expect(text(container, 'body')).toBe('Sent to a manager.');
});

test('refused: the refusal’s own words, then the way on by its code', () => {
  const outcome = outcomeOfOperation({ phase: 'error', message: 'Only $12.00 is left to refund.', code: 'refused' });
  const { container } = render(<CommandOutcome outcome={outcome} />);
  expect(view(container).getAttribute('data-state')).toBe('refused');
  expect(text(container, 'title')).toBe('Not done');
  expect(text(container, 'body')).toBe('Only $12.00 is left to refund.');
  expect(text(container, 'next')).toBe('Nothing was changed. Review and send again.');
  expect(refusalNext('stale_record')).toMatch(/Refresh and review/);
  expect(refusalNext('forbidden')).toMatch(/Ask someone who may/);
  // A label read from a column's name is lower-cased inside the sentence; an initialism keeps its capitals; what an
  // author wrote stays as written.
  expect(refusalNext('invalid_input', fieldWord('Your last name', { name: 'your_last_name', label: 'Your last name' }))).toBe(
    'Change your last name and send again.',
  );
  expect(refusalNext('invalid_input', fieldWord('VIN', { name: 'vin', label: 'VIN' }))).toBe('Change VIN and send again.');
  expect(refusalNext('invalid_input', { label: 'VIN number', derived: true })).toBe('Change VIN number and send again.');
  expect(refusalNext('invalid_input', { label: 'McLaren trim', derived: true })).toBe('Change McLaren trim and send again.');
  expect(refusalNext('invalid_input', fieldWord('Toyota model', { name: 'model', label: 'Toyota model' }))).toBe(
    'Change Toyota model and send again.',
  );
  expect(refusalNext('invalid_input', 'Toyota model')).toBe('Change Toyota model and send again.');
  // A submission changes no record to refresh: its state and not-found refusals point at the answers.
  expect(refusalNext('ineligible_state')).toMatch(/Refresh to see where it stands/);
  expect(refusalNext('ineligible_state', undefined, true)).toMatch(/Review your answers/);
  expect(refusalNext('not_found', undefined, true)).toMatch(/your answers name/);
  expect(formFailureOutcome({ message: 'Closed', status: 409, code: 'ineligible_state' }, 'Closed', undefined, true)).toMatchObject({
    next: refusalNext('ineligible_state', undefined, true),
  });
  // A signed-in command form keeps the record's wording.
  expect(formFailureOutcome({ message: 'Closed', status: 409, code: 'ineligible_state' }, 'Closed')).toMatchObject({
    next: expect.stringMatching(/Refresh to see where it stands/),
  });
  // A public form's refusal reads the same way; a wait is a wait.
  expect(formFailureOutcome({ message: 'Slow down', status: 429 }, 'Slow down')).toMatchObject({
    state: 'refused',
    next: refusalNext('rate_limited'),
  });
});

test('unknown: the answer was lost, and Check again reads what was kept instead of sending twice', () => {
  const outcome = outcomeOfOperation({ phase: 'unknown', message: 'The result is not yet known.' });
  const check = vi.fn();
  const { container } = render(<CommandOutcome outcome={outcome} onCheck={check} />);
  expect(view(container).getAttribute('data-state')).toBe('unknown');
  expect(text(container, 'title')).toBe('Result not confirmed');
  expect(text(container, 'next')).toMatch(/never sends twice/);
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(check).toHaveBeenCalledOnce();
  // An action that keeps no receipt is checked on its record.
  expect(outcomeOfOperation({ phase: 'unknown', message: '' }, { untracked: true })).toMatchObject({
    next: expect.stringMatching(/no receipt/),
  });
  // A public form: no answer at all, or a server fault with no refusal code, is unknown; a coded 5xx is a refusal.
  expect(formFailureOutcome({ message: 'x' }, 'The form could not be sent.').state).toBe('unknown');
  expect(formFailureOutcome({ message: 'x', status: 502 }, 'x').state).toBe('unknown');
  expect(formFailureOutcome({ message: 'x', status: 503, code: 'temporarily_unavailable' }, 'x').state).toBe('refused');
});

test('done: an address the command handed back is shown, with a Copy that puts it on the clipboard', async () => {
  const url = 'https://app.example.com/l/mstl1.abc';
  const outcome = outcomeOfOperation({
    phase: 'success',
    message: '',
    said: 'Invitation ready.',
    output: { message: 'Invitation ready.', url },
  });
  expect(outcome).toMatchObject({ state: 'done', links: [url] });
  const write = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
  render(<CommandOutcome outcome={outcome} />);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(url);
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(write).toHaveBeenCalledWith(url);
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
});

test('done: a result with no address, or text that only looks like one, adds nothing', () => {
  expect(outcomeOfOperation({ phase: 'success', message: '', output: { id: 4, note: 'see https://x.test later' } })).not.toHaveProperty(
    'links',
  );
  expect(resultLinks('https://a.test/x')).toEqual(['https://a.test/x']);
  expect(resultLinks({ a: 'https://a.test', b: ['https://b.test'], c: 'javascript:alert(1)' })).toEqual([
    'https://a.test',
    'https://b.test',
  ]);
});

test('the notice of a one-click command carries the address with a Copy beside it', () => {
  toastDone('Done.', { url: 'https://a.test/x' });
  expect(toast).toHaveBeenCalledWith('Done. https://a.test/x', 'ok', expect.objectContaining({ label: 'Copy' }));
  toastDone('Done.', { id: 1 });
  expect(toast).toHaveBeenLastCalledWith('Done.', 'ok');
});
