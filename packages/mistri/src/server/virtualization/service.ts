/** One isolated virtual HTTP service. Handlers serialize atomic state updates;
 * scenario selection is captured at admission, and shutdown fences late work. */
import { createServer } from 'node:http';
import { createVirtualClock, seededRandom } from './clock.js';
import { defineService, type ServiceDefinition, type ServiceRoute, type VirtualClock } from './definition.js';
import { captureRequestMatcher, matchRequest, type RequestMatcher, type VirtualRequest } from './matching.js';
import { encodeVirtualReply, readVirtualBody, sendVirtualReply } from './transport.js';

export interface ServiceJournalEntry extends VirtualRequest {
  readonly sequence: number;
  readonly scenario: string | null;
  readonly receivedAt: number;
  readonly route: string | null;
  readonly outcome: 'pending' | 'replied' | 'fault' | 'failed';
  readonly status?: number;
  readonly error?: string;
}
export interface StartServiceOptions {
  readonly port?: number;
  readonly seed?: number;
  readonly now?: number;
  readonly handlerTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly maxJournalEntries?: number;
}
export interface VirtualService<State> extends AsyncDisposable {
  readonly url: string;
  readonly clock: VirtualClock;
  journal(): readonly ServiceJournalEntry[];
  state(): State;
  scenario(name: string | null): void;
  verify(matcher: RequestMatcher, expectation?: { readonly times: number }): void;
  assertSatisfied(): void;
  reset(): void;
  close(): Promise<void>;
}
function bounded(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${label}.`);
  return value;
}

export async function startService<State>(
  input: ServiceDefinition<State>,
  options: StartServiceOptions = {},
): Promise<VirtualService<State>> {
  const definition = defineService(input);
  const name = definition.name,
    seed = options.seed ?? 1;
  const initial = structuredClone(definition.state);
  let state = structuredClone(initial),
    activeScenario: string | null = null,
    sequence = 0,
    closed = false;
  let random = seededRandom(seed),
    tail: Promise<void> = Promise.resolve();
  const clock = createVirtualClock(options.now ?? 0);
  const timeout = bounded(options.handlerTimeoutMs ?? 5000, 300000, 'handler timeout');
  const bodyLimit = bounded(options.maxBodyBytes ?? 1024 * 1024, 16 * 1024 * 1024, 'body limit');
  const journalLimit = bounded(options.maxJournalEntries ?? 10000, 1000000, 'journal limit');
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid service port.');
  // Capture route containers now; caller edits cannot swap active scenarios.
  const captureRoute = (route: ServiceRoute<State>): ServiceRoute<State> => ({
    ...route,
    match: captureRequestMatcher(route.match),
    reply: typeof route.reply === 'function' ? route.reply : structuredClone(route.reply),
  });
  const base = definition.routes.map(captureRoute),
    scenarios = new Map(Object.entries(definition.scenarios ?? {}).map(([name, routes]) => [name, routes.map(captureRoute)]));
  const entries: ServiceJournalEntry[] = [],
    failures: Error[] = [];
  const active = new Map<AbortController, Promise<void>>();
  const routesFor = (name: string | null): ServiceRoute<State>[] => {
    const overrides = name === null ? [] : scenarios.get(name)!;
    const ids = new Set(overrides.map((route) => route.id));
    return [...base.filter((route) => !ids.has(route.id)), ...overrides];
  };
  const assertSatisfied = () => {
    if (active.size) throw new Error(`${name}: ${active.size} request(s) still active.`);
    if (failures.length)
      throw new AggregateError(
        [...failures],
        `${name}: ${failures.length} virtual service failure(s). ${failures.map((error) => error.message).join('; ')}`,
      );
  };
  const server = createServer((req, res) => {
    if (closed) {
      res.writeHead(503);
      res.end();
      return;
    }
    const controller = new AbortController(),
      { signal } = controller;
    const scenario = activeScenario,
      routes = routesFor(scenario),
      receivedAt = clock.now(),
      requestSequence = ++sequence;
    const abort = () => {
      if (!res.writableFinished) controller.abort(new Error('Virtual request cancelled.'));
    };
    req.once('aborted', abort);
    res.once('close', abort);
    const timer = setTimeout(() => {
      controller.abort(new Error(`Virtual request exceeded ${timeout}ms.`));
      if (!req.complete) req.destroy();
    }, timeout);
    let index = -1;
    let delayedTransport = false;
    const run = async () => {
      try {
        if (entries.length >= journalLimit) throw new Error(`Journal limit ${journalLimit} exceeded; reset between tests.`);
        const request: VirtualRequest = { method: req.method ?? 'GET', url: req.url ?? '/', headers: { ...req.headers }, body: undefined };
        index = entries.length;
        entries.push({ ...request, sequence: requestSequence, scenario, receivedAt, route: null, outcome: 'pending' });
        const { body, rawBody } = await readVirtualBody(req, bodyLimit);
        const parsed = { ...request, body, rawBody };
        entries[index] = { ...entries[index], body: structuredClone(body), rawBody };
        signal.throwIfAborted();
        const operation = async () => {
          signal.throwIfAborted();
          const inspected = routes.map((route) => ({ route, match: matchRequest(route.match, parsed) }));
          const matched = inspected
            .filter((value) => value.match.matched)
            .sort((a, b) => (b.route.priority ?? 0) - (a.route.priority ?? 0));
          if (!matched.length)
            throw new Error(
              `Unexpected ${parsed.method} ${new URL(parsed.url, 'http://virtual.invalid').pathname}. ${inspected.map((value) => `${value.route.id}: ${value.match.differences.join(', ')}`).join('; ')}`,
            );
          if (matched.length > 1 && (matched[0].route.priority ?? 0) === (matched[1].route.priority ?? 0))
            throw new Error(
              `Ambiguous routes: ${matched
                .filter((value) => (value.route.priority ?? 0) === (matched[0].route.priority ?? 0))
                .map((value) => value.route.id)
                .join(', ')}. Set explicit priorities or disjoint matchers.`,
            );
          const { route, match } = matched[0],
            transaction = structuredClone(state);
          entries[index] = { ...entries[index], route: route.id };
          let ownerOpen = true;
          const current = () => {
            signal.throwIfAborted();
            if (!ownerOpen) throw new Error('Virtual handler context retired.');
          };
          const ownedClock = Object.freeze({
            now: clock.now,
            advance(ms: number) {
              current();
              clock.advance(ms);
            },
            sleep(ms: number, callerSignal?: AbortSignal) {
              current();
              return clock.sleep(ms, callerSignal ? AbortSignal.any([signal, callerSignal]) : signal);
            },
          });
          const context = {
            ...structuredClone(parsed),
            params: match.params,
            query: new URL(parsed.url, 'http://virtual.invalid').searchParams,
            state: transaction,
            clock: ownedClock,
            random: () => {
              current();
              return random();
            },
            signal,
          };
          try {
            const reply = encodeVirtualReply(typeof route.reply === 'function' ? await route.reply(context) : route.reply);
            current();
            // Clone again: a retained context cannot mutate committed state later.
            state = structuredClone(transaction);
            entries[index] = { ...entries[index], status: reply.status, outcome: reply.fault ? 'fault' : 'replied' };
            return reply;
          } finally {
            ownerOpen = false;
          }
        };
        const cancelled = new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const scheduled = tail.then(() => Promise.race([operation(), cancelled]));
        tail = scheduled.then(
          () => {},
          () => {},
        );
        const reply = await Promise.race([scheduled, cancelled]);
        delayedTransport = reply.delayMs > 0;
        await sendVirtualReply(res, reply, signal);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        // Expected network faults belong in the journal, not teardown failures.
        if (index >= 0 && delayedTransport && signal.aborted) {
          entries[index] = { ...entries[index], outcome: 'fault', error: 'Delayed response cancelled by caller or request deadline.' };
        } else if (index < 0 || entries[index].outcome !== 'fault') {
          failures.push(error);
          if (index >= 0) entries[index] = { ...entries[index], outcome: 'failed', error: error.message };
        }
        if (!res.destroyed && !res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        } else res.destroy();
      } finally {
        clearTimeout(timer);
        req.off('aborted', abort);
        res.off('close', abort);
      }
    };
    const task = run().finally(() => active.delete(controller));
    active.set(controller, task);
  });
  server.requestTimeout = timeout;
  server.headersTimeout = timeout;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Virtual service failed to bind.');
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      clock.close();
      for (const controller of active.keys()) controller.abort(new Error('Virtual service closed with active requests.'));
      const stopped = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      server.closeAllConnections();
      await Promise.all([...active.values()]);
      await stopped;
      assertSatisfied();
    })());
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    clock: Object.freeze({ now: clock.now, advance: clock.advance, sleep: clock.sleep }),
    journal: (): readonly ServiceJournalEntry[] => structuredClone(entries),
    state: (): State => structuredClone(state),
    scenario(name: string | null) {
      if (closed) throw new Error('Virtual service closed.');
      if (name !== null && !scenarios.has(name)) throw new Error(`Unknown scenario: ${name}.`);
      activeScenario = name;
    },
    verify(matcher: RequestMatcher, expectation: { readonly times: number } = { times: 1 }) {
      if (!Number.isSafeInteger(expectation.times) || expectation.times < 0) throw new Error('Expected request count must be nonnegative.');
      const count = entries.filter((entry) => matchRequest(matcher, entry).matched).length;
      if (count !== expectation.times)
        throw new Error(
          `${name}: expected ${expectation.times} matching request(s), received ${count}. Journal: ${entries.map((entry) => `${entry.method} ${new URL(entry.url, 'http://virtual.invalid').pathname} (${entry.outcome})`).join(', ')}`,
        );
    },
    assertSatisfied,
    reset() {
      if (closed) throw new Error('Virtual service closed.');
      assertSatisfied();
      state = structuredClone(initial);
      activeScenario = null;
      sequence = 0;
      entries.length = 0;
      random = seededRandom(seed);
      clock.reset();
    },
    close,
    [Symbol.asyncDispose]: close,
  });
}
