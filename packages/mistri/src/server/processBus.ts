/**
 * The process bus: what one process tells the others serving the same start, such as "forget this cached thing".
 *
 * A start with `--workers` (cli/workers.ts) is several processes behind one port, each with its own memory, so a cache
 * one of them drops on a change the others would go on serving until it expires. `publish` runs this process's own
 * subscribers at once and, in a worker, sends the message to the primary, which hands it to every other worker; one
 * process alone has nothing to send, so the bus is a loopback there and costs a function call.
 *
 * Messages are hints to forget, never the state itself: a worker that missed one (it was starting, or restarting) has
 * an empty cache anyway, and replicas, which share no bus, keep the time-to-live each cache already has as their bound.
 * A payload is whatever the structured clone of an IPC message carries; keep it small (a key, a hash).
 *
 * One exchange waits for an answer: `ask`, a worker's question to its primary (the counters a start's workers share,
 * cli/primaryCounters.ts), which the primary answers with `answer`. A question carries a deadline, because a worker
 * must not hang a request on a primary that is stuck; what a late answer means is the asker's to decide.
 *
 * Topics in use:
 * - `cache.evict` — a key of the Registry's in-process cache store (engine connections.ts `cache()`).
 * - `preferences.evict` — an account's recent-picks entry (app/appPreferences.ts).
 * - `session.evict` — a short digest of an auth store's URL (never the URL, which carries credentials) and the
 *   publishing pid, for the in-process session cache (auth/authStoreReads.ts): a change to the store in one worker
 *   moves that store's epoch on in the others, so none answers from what it kept before a sign-out or revocation.
 */
import cluster, { type Worker } from 'node:cluster';

type Listener = (payload: unknown) => void;

/** The IPC message a worker sends the primary and the primary relays: one shape, so a stray message is never read as one. */
type BusMessage = { mistriBus: { topic: string; payload: unknown } };

/** A worker's question to its primary, and the primary's answer to it, matched by `id`. */
type AskMessage = { mistriAsk: { id: number; op: string; args: unknown[] } };
type AnswerMessage = { mistriAnswer: { id: number; value?: unknown; error?: string } };

const listeners = new Map<string, Set<Listener>>();
let wired = false;
let asked = 0;
const waiting = new Map<number, { settle: (answer: AnswerMessage['mistriAnswer']) => void }>();

/** A question the primary did not answer in time, or could not be sent: the asker decides what that means. */
export class NoAnswer extends Error {}

export function busMessage(message: unknown): BusMessage['mistriBus'] | undefined {
  if (typeof message !== 'object' || message === null || !('mistriBus' in message)) return undefined;
  const said = (message as BusMessage).mistriBus;
  return typeof said === 'object' && said !== null && typeof said.topic === 'string' ? said : undefined;
}

function deliver(topic: string, payload: unknown): void {
  for (const listener of listeners.get(topic) ?? []) {
    // One subscriber's mistake does not keep the message from the rest, nor reach the publisher.
    try {
      listener(payload);
    } catch (error) {
      console.error(`mistri: a ${topic} subscriber failed: ${(error as Error).message}`);
    }
  }
}

/* In a worker, what the primary relays from the others. Wired at the first subscribe, and the channel left unref'd as
   the worker found it: a listener must not keep alive a worker that is otherwise done. */
function wire(): void {
  if (wired || !cluster.isWorker) return;
  wired = true;
  process.on('message', (message) => {
    const said = busMessage(message);
    if (said) return deliver(said.topic, said.payload);
    const answer = answerMessage(message);
    if (answer) waiting.get(answer.id)?.settle(answer);
  });
}

function answerMessage(message: unknown): AnswerMessage['mistriAnswer'] | undefined {
  if (typeof message !== 'object' || message === null || !('mistriAnswer' in message)) return undefined;
  const said = (message as AnswerMessage).mistriAnswer;
  return typeof said === 'object' && said !== null && typeof said.id === 'number' ? said : undefined;
}

/** Tells this process's subscribers to `topic`, then every other worker's. */
export function publish(topic: string, payload: unknown): void {
  deliver(topic, payload);
  if (cluster.isWorker && process.connected)
    process.send?.({ mistriBus: { topic, payload } } satisfies BusMessage, undefined, undefined, () => {});
}

/** Runs `listener` for every `topic` message, this process's own included. Returns the unsubscribe. */
export function subscribe(topic: string, listener: Listener): () => void {
  wire();
  let set = listeners.get(topic);
  if (!set) listeners.set(topic, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** In the primary: relays one worker's bus message to every other live worker. False when `message` is not one. */
export function relay(message: unknown, from: Worker, workers: Iterable<Worker | undefined>): boolean {
  const said = busMessage(message);
  if (!said) return false;
  for (const worker of workers)
    if (worker && worker.id !== from.id && worker.isConnected()) worker.send({ mistriBus: said } satisfies BusMessage, undefined, () => {});
  return true;
}

/**
 * In a worker: asks the primary `op` with `args` and resolves with its answer. Rejects with NoAnswer when this is not
 * a worker, the question cannot be sent, or no answer comes within `timeoutMs`; with the primary's error when it
 * answered with one.
 */
export function ask(op: string, args: unknown[], timeoutMs: number): Promise<unknown> {
  if (!cluster.isWorker || !process.connected || !process.send) return Promise.reject(new NoAnswer('no primary to ask.'));
  wire();
  const id = ++asked;
  return new Promise((resolve, reject) => {
    const settle = (answer: AnswerMessage['mistriAnswer'] | NoAnswer) => {
      if (!waiting.delete(id)) return;
      clearTimeout(timer);
      if (answer instanceof NoAnswer) reject(answer);
      else if (answer.error !== undefined) reject(new Error(answer.error));
      else resolve(answer.value);
    };
    // Unref'd: a question in flight belongs to a request, which keeps the worker alive itself.
    const timer = setTimeout(() => settle(new NoAnswer(`the primary did not answer ${op} within ${timeoutMs} ms.`)), timeoutMs);
    timer.unref();
    waiting.set(id, { settle });
    process.send!({ mistriAsk: { id, op, args } } satisfies AskMessage, undefined, undefined, (error: Error | null) => {
      if (error) settle(new NoAnswer(`the primary could not be asked ${op}: ${error.message}`));
    });
  });
}

/**
 * In the primary: answers one worker's question with `handler`. False when `message` is not a question. A handler's
 * throw is answered as an error, so the worker's request fails rather than waits for its deadline.
 */
export function answer(message: unknown, from: Worker, handler: (op: string, args: unknown[]) => unknown): boolean {
  if (typeof message !== 'object' || message === null || !('mistriAsk' in message)) return false;
  const said = (message as AskMessage).mistriAsk;
  if (typeof said !== 'object' || said === null || typeof said.id !== 'number' || typeof said.op !== 'string') return false;
  const reply = (body: AnswerMessage['mistriAnswer']) => {
    if (from.isConnected()) from.send({ mistriAnswer: body } satisfies AnswerMessage, undefined, () => {});
  };
  Promise.resolve()
    .then(() => handler(said.op, Array.isArray(said.args) ? said.args : []))
    .then(
      (value) => reply({ id: said.id, value }),
      (error: unknown) => reply({ id: said.id, error: error instanceof Error ? error.message : String(error) }),
    );
  return true;
}
