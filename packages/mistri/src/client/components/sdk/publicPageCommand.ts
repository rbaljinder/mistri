/**
 * A public page's command (`definePage({ public: true, commands })`), as its `useCommand` holds it: run through the
 * page's own door (server http/pageCommandRoutes.ts) as the public principal, whoever is signed in. The input is
 * checked by the command's declaration first, as a form's submit checks it; the page's ticket is asked when the
 * handle is made and sent with the run, held back until it is old enough to be a person's (3 seconds); a refused
 * ticket is asked again once. A challenge's token, where the page draws a human check, is `run(record, input,
 * { challenge })`. The answer is the door's public shape — the reference to quote — never the input. An answer that
 * never came, or a server that could not say, is `unknown`: its `check()` sends the same submission again, which the
 * door answers with the run it already has, so nothing is sent twice under two keys (`attempt` keeps the key across a
 * reload).
 */
import type { AppFormCommandReference } from '../../../shared/command.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { commandInput, prefilledCommandValues, readyToJudge } from '../CommandFields.js';
import type { UiCommandHandle, UiCommandOptions, UiCommandOutcome } from './context.js';
import { attemptKey } from './formCommandRun.js';
import { say } from '../../copy/components/components/sdk/publicPageCommand.js';

/* The ticket's floor (server forms/publicTicket.ts), and a margin for the two clocks. */
const TICKET_AGE_MS = 3_200;

/* What the door refuses before it runs anything (http/pageCommandRoutes.ts): said again on a check, they prove nothing. */
const BEFORE_THE_RUN = new Set(['rate_limited', 'ticket_refused', 'challenge_failed']);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Ticket {
  ticket: string;
  at: number;
}

async function askTicket(page: string): Promise<Ticket | undefined> {
  try {
    const res = await fetchServer(`/api/pages/${encodeURIComponent(page)}/ticket`, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ticket?: unknown };
    return typeof body.ticket === 'string' ? { ticket: body.ticket, at: Date.now() } : undefined;
  } catch {
    return undefined;
  }
}

/** The public command `id` of the public page `page`, served as `reference`. */
export function publicPageCommand(page: string, id: string, reference: AppFormCommandReference): UiCommandHandle {
  let ticket: Promise<Ticket | undefined> = askTicket(page);
  const label = humanName(id);

  const send = async (input: Record<string, unknown>, submission: string, options: UiCommandOptions) => {
    let held = await ticket;
    if (!held) held = await (ticket = askTicket(page));
    if (!held) return { status: 0, body: {} as Record<string, unknown> };
    const young = TICKET_AGE_MS - (Date.now() - held.at);
    if (young > 0) await wait(young);
    const res = await fetchServer(`/api/pages/${encodeURIComponent(page)}/commands/${encodeURIComponent(id)}`, {
      method: 'POST',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        'x-mistri-ticket': held.ticket,
        ...(options.challenge ? { 'x-mistri-challenge': options.challenge } : {}),
      },
      body: JSON.stringify({ input, submission }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  };

  /* One run, one submission key: sent again under it, the door answers a run it already has with its receipt. A
     check sends it again, so what the door refuses before any run (this client's budget, a human check's spent token)
     says nothing of the first send: it is still not known. */
  const deliver = async (
    input: Record<string, unknown>,
    submission: string,
    options: UiCommandOptions,
    checking: boolean,
  ): Promise<UiCommandOutcome> => {
    const said = options.label || label;
    const unknown = (message = say('publicNotKnown', { label: said })): UiCommandOutcome => ({
      status: 'unknown',
      message,
      check: (again) => deliver(input, submission, { ...options, ...again }, true),
    });
    let answer: Awaited<ReturnType<typeof send>>;
    try {
      answer = await send(input, submission, options);
      /* A ticket the server no longer takes (a restart, a day open): asked again, and the run sent once more under the
         same submission key, so it can never be two. */
      if (answer.status === 403 && answer.body.code === 'ticket_refused') {
        ticket = askTicket(page);
        answer = await send(input, submission, options);
      }
    } catch {
      // Sent, and no answer came: whether it ran is not known, and only the same submission asked again can say.
      return unknown();
    }
    if (answer.status === 200 && typeof answer.body.reference === 'string')
      return { status: 'applied', output: { reference: answer.body.reference, receipt: answer.body.receipt } };
    // No ticket, so nothing was sent this time: on a first run that is a refusal, on a check the first is still not known.
    if (answer.status === 0) return checking ? unknown() : { status: 'refused', message: say('publicNotSent', { label: said }) };
    if (answer.status >= 500) return unknown();
    const message = typeof answer.body.error === 'string' ? answer.body.error : say('isNotSomethingYouCanDo', { label: said });
    if (checking && BEFORE_THE_RUN.has(String(answer.body.code))) return unknown(message);
    return { status: 'refused', message };
  };

  const run = async (
    _record: Readonly<Record<string, unknown>>,
    given?: Readonly<Record<string, unknown>>,
    options: UiCommandOptions = {},
  ): Promise<UiCommandOutcome> => {
    const submission = attemptKey(options);
    // The declaration's own rules, once what judges a `when` is here; the command's rules over the draft are the server's.
    const judging = readyToJudge(reference.input);
    if (judging) await judging;
    let input: Record<string, unknown>;
    try {
      input = commandInput(reference.input, prefilledCommandValues(reference.input, given ?? {}));
    } catch (error) {
      return { status: 'refused', message: (error as Error).message };
    }
    return deliver(input, submission, options, false);
  };

  return { label, granted: true, available: async () => true, run, open: run };
}
