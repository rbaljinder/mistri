/**
 * A public page's command through the page's own door: the ticket asked as the handle is made, the run held back until
 * the ticket is old enough to be a person's, sent with the ticket and any challenge token, asked again once under the
 * same submission key when the ticket is refused, and answered as the door's reference — never the input.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AppFormCommandReference } from '../../../shared/command.js';

const fetchServer = vi.fn();
vi.mock('@mistriwork/kit/client/transport.js', () => ({ fetchServer: (...args: unknown[]) => fetchServer(...args) }));
const { publicPageCommand } = await import('./publicPageCommand.js');

const reference = {
  id: 'enrol',
  version: 1,
  input: [{ name: 'name', label: 'Name', type: 'text', required: true, maxLength: 20 }],
} as unknown as AppFormCommandReference;
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
  vi.useFakeTimers();
  fetchServer.mockReset();
});
afterEach(() => vi.useRealTimers());

test('the ticket is asked at once, and the run waits until it is old enough, then sends it with the challenge', async () => {
  fetchServer.mockResolvedValueOnce(reply(200, { ticket: 'ticket-1' }));
  const handle = publicPageCommand('lobby', 'enrol', reference);
  expect(fetchServer).toHaveBeenCalledWith('/api/pages/lobby/ticket', expect.objectContaining({ credentials: 'same-origin' }));
  fetchServer.mockResolvedValueOnce(reply(200, { reference: 'ENR-0001', receipt: { id: 'r1' } }));
  const running = handle.run({}, { name: 'Mara' }, { challenge: 'token-1' });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fetchServer).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300);
  const outcome = await running;
  // Applied, it carries the thank-you a public form's done screen says: the reference to keep, for the page to show.
  expect(outcome).toEqual({
    status: 'applied',
    message: 'Thank you. Enrol is received; your reference is ENR-0001.',
    output: { reference: 'ENR-0001', receipt: { id: 'r1' } },
  });
  const [url, init] = fetchServer.mock.calls[1] as [string, RequestInit];
  expect(url).toBe('/api/pages/lobby/commands/enrol');
  expect(init.headers).toMatchObject({ 'x-mistri-ticket': 'ticket-1', 'x-mistri-challenge': 'token-1' });
  expect(JSON.parse(String(init.body)).input).toEqual({ name: 'Mara' });
});

test('a refused ticket is asked again once, and the run sent again under the same submission key', async () => {
  fetchServer
    .mockResolvedValueOnce(reply(200, { ticket: 'stale' }))
    .mockResolvedValueOnce(reply(403, { code: 'ticket_refused', error: 'Reload the page.' }))
    .mockResolvedValueOnce(reply(200, { ticket: 'fresh' }))
    .mockResolvedValueOnce(reply(200, { reference: 'ENR-0002' }));
  const handle = publicPageCommand('lobby', 'enrol', reference);
  const running = handle.run({}, { name: 'Ari' });
  await vi.advanceTimersByTimeAsync(7_000);
  const outcome = await running;
  expect(outcome.status).toBe('applied');
  const sends = fetchServer.mock.calls.filter(([url]) => String(url).includes('/commands/')) as Array<[string, RequestInit]>;
  expect(sends.map(([, init]) => (init.headers as Record<string, string>)['x-mistri-ticket'])).toEqual(['stale', 'fresh']);
  const keys = sends.map(([, init]) => JSON.parse(String(init.body)).submission);
  expect(keys[0]).toBe(keys[1]);
});

test("an input the declaration refuses is refused before anything is sent, and the door's refusal is said", async () => {
  fetchServer.mockResolvedValueOnce(reply(200, { ticket: 'ticket-1' }));
  const handle = publicPageCommand('lobby', 'enrol', reference);
  expect((await handle.run({}, { name: 'x'.repeat(21) })).status).toBe('refused');
  expect(fetchServer).toHaveBeenCalledTimes(1);
  fetchServer.mockResolvedValueOnce(reply(429, { code: 'rate_limited', error: 'Too many requests from this address.' }));
  const running = handle.run({}, { name: 'Mara' });
  await vi.advanceTimersByTimeAsync(3_500);
  expect(await running).toEqual({ status: 'refused', message: 'Too many requests from this address.' });
});

/* A field report: a public page's run judged its input before the draft's logic had arrived, so a question its
   condition hides was required. */
test("a run judges the command's conditions first: what a `when` hides is neither required nor sent", async () => {
  const timed = {
    id: 'book',
    version: 1,
    input: [
      { name: 'timing', type: 'text', label: 'Timing', required: true },
      { name: 'frequency', type: 'text', label: 'Frequency', default: 'once', when: "timing = 'later'" },
      { name: 'on', type: 'date', label: 'Date', required: true, when: "timing = 'later'" },
    ],
  } as unknown as AppFormCommandReference;
  fetchServer.mockResolvedValueOnce(reply(200, { ticket: 'ticket-1' })).mockResolvedValueOnce(reply(200, { reference: 'BK-1' }));
  const handle = publicPageCommand('lobby', 'book', timed);
  const running = handle.run({}, { timing: 'now' });
  await vi.advanceTimersByTimeAsync(3_500);
  expect((await running).status).toBe('applied');
  expect(JSON.parse(String((fetchServer.mock.calls[1] as [string, RequestInit])[1].body)).input).toEqual({ timing: 'now' });
});

const sentKeys = () =>
  (fetchServer.mock.calls.filter(([url]) => String(url).includes('/commands/')) as Array<[string, RequestInit]>).map(
    ([, init]) => JSON.parse(String(init.body)).submission as string,
  );

test('an answer that never came is not known, never refused; check sends the same submission again', async () => {
  fetchServer
    .mockResolvedValueOnce(reply(200, { ticket: 'ticket-1' }))
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(reply(200, { reference: 'ENR-0003' }));
  const handle = publicPageCommand('lobby', 'enrol', reference);
  const running = handle.run({}, { name: 'Mara' });
  await vi.advanceTimersByTimeAsync(3_500);
  const outcome = await running;
  expect(outcome.status).toBe('unknown');
  const checked = await (outcome as Extract<typeof outcome, { status: 'unknown' }>).check();
  expect(checked).toMatchObject({ status: 'applied', output: { reference: 'ENR-0003', receipt: undefined } });
  const keys = sentKeys();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test('a server that could not say is not known; on a check, a refusal before any run says nothing either', async () => {
  fetchServer
    .mockResolvedValueOnce(reply(200, { ticket: 'ticket-1' }))
    .mockResolvedValueOnce(reply(503, { code: 'temporarily_unavailable', error: 'Try again shortly.' }))
    .mockResolvedValueOnce(reply(429, { code: 'rate_limited', error: 'Too many requests from this address.' }));
  const handle = publicPageCommand('lobby', 'enrol', reference);
  const running = handle.run({}, { name: 'Mara' });
  await vi.advanceTimersByTimeAsync(3_500);
  const outcome = await running;
  expect(outcome.status).toBe('unknown');
  const checked = await (outcome as Extract<typeof outcome, { status: 'unknown' }>).check();
  expect(checked).toMatchObject({ status: 'unknown', message: 'Too many requests from this address.' });
});

test("a component's attempt is the submission key the run is sent under", async () => {
  fetchServer.mockResolvedValueOnce(reply(200, { ticket: 'ticket-1' })).mockResolvedValueOnce(reply(200, { reference: 'ENR-0004' }));
  const handle = publicPageCommand('lobby', 'enrol', reference);
  const attempt = '0b8d1d4e-2f3a-4c5b-9d6e-7f8a9b0c1d2e';
  const running = handle.run({}, { name: 'Mara' }, { attempt });
  await vi.advanceTimersByTimeAsync(3_500);
  expect((await running).status).toBe('applied');
  expect(sentKeys()).toEqual([attempt]);
});
