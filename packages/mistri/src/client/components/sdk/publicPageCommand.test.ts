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
  expect(outcome).toEqual({ status: 'applied', output: { reference: 'ENR-0001', receipt: { id: 'r1' } } });
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
