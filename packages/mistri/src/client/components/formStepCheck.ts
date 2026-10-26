/**
 * A public form's step checked by the server, fetched the first time a step is left (FormSurface.tsx): a form
 * without steps never asks it, so a public page's first paint carries none of it.
 */
import type { CommandInputValue } from '../commandState.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

/**
 * A public form's step checked by the server (`/api/forms/<key>/check/<step>`): the problems by field, or none. A
 * check that cannot be asked — offline, over budget, a host that has none — is no word at all: the step goes on, and
 * the submission is judged in full when it is sent.
 */
export async function checkPublicFormStep(
  id: string,
  step: string,
  input: CommandInputValue,
  via?: string,
): Promise<Record<string, string> | undefined> {
  try {
    const res = await fetchServer(
      `/api/forms/${encodeURIComponent(id)}/check/${encodeURIComponent(step)}${via ? `?via=${encodeURIComponent(via)}` : ''}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
      },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { problems?: unknown };
    const problems = data.problems && typeof data.problems === 'object' ? (data.problems as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(problems).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return undefined;
  }
}

/** A public form's one request with a body: plain fetch, no session plumbing — a public submission, whoever is signed in. */
