/**
 * A public page's command (`definePage({ public: true, commands })`), as its `useCommand` holds it: run through the
 * page's own door (server http/pageCommandRoutes.ts) as the public principal, whoever is signed in. The input is
 * checked by the command's declaration first, as a form's submit checks it; the page's ticket is asked when the
 * handle is made and sent with the run, held back until it is old enough to be a person's (3 seconds); a refused
 * ticket is asked again once. A challenge's token, where the page draws a human check, is `run(record, input,
 * { challenge })`. The answer is the door's public shape — the reference to quote — never the input.
 */
import type { AppFormCommandReference } from '../../../shared/command.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { commandInput, prefilledCommandValues } from '../CommandFields.js';
import type { UiCommandHandle, UiCommandOptions, UiCommandOutcome } from './context.js';
import { say } from '../../copy/components/components/sdk/publicPageCommand.js';

/* The ticket's floor (server forms/publicTicket.ts), and a margin for the two clocks. */
const TICKET_AGE_MS = 3_200;

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

  const send = async (input: Record<string, unknown>, submission: string, options: UiCommandOptions & { challenge?: string }) => {
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

  const run = async (
    _record: Readonly<Record<string, unknown>>,
    given?: Readonly<Record<string, unknown>>,
    options: UiCommandOptions & { challenge?: string } = {},
  ): Promise<UiCommandOutcome> => {
    let input: Record<string, unknown>;
    try {
      // The declaration's own rules; the command's rules over the draft are the server's to judge, as it runs.
      input = commandInput(reference.input, prefilledCommandValues(reference.input, given ?? {}));
    } catch (error) {
      return { status: 'refused', message: (error as Error).message };
    }
    const submission = crypto.randomUUID();
    try {
      let answer = await send(input, submission, options);
      /* A ticket the server no longer takes (a restart, a day open): asked again, and the run sent once more under the
         same submission key, so it can never be two. */
      if (answer.status === 403 && answer.body.code === 'ticket_refused') {
        ticket = askTicket(page);
        answer = await send(input, submission, options);
      }
      if (answer.status === 200 && typeof answer.body.reference === 'string')
        return { status: 'applied', output: { reference: answer.body.reference, receipt: answer.body.receipt } };
      const message =
        typeof answer.body.error === 'string' ? answer.body.error : say('isNotSomethingYouCanDo', { label: options.label || label });
      return { status: 'refused', message };
    } catch {
      return { status: 'refused', message: say('publicNotSent', { label: options.label || label }) };
    }
  };

  return { label, granted: true, available: async () => true, run, open: run };
}
