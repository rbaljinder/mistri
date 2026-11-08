/**
 * A signed-in form saved on every step, as the page speaks to it (server/forms/draftHttp.ts): the route
 * `/api/commands/draft`, under the reader's own session and grant. SavedFormSurface draws the form and this is
 * what it saves, resumes, reviews and submits through; the public form's cookie transport is savedFormApi.ts.
 *
 * Each step and the submit travel as the ordinary command envelope with an idempotency key. The key in flight is
 * kept in sessionStorage by command, so a reload after a save whose answer was lost asks the server about the same
 * key rather than writing twice. It is cleared once the step is answered, and for every step the server already has.
 */
import { api } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { COMMAND_ROUTES } from '../../shared/commandRoutes.js';
import type { CommandInputValue } from '../commandState.js';
import type { FormReceipt } from './FormSurface.js';
import { say } from '../copy/forms/components/draftFormApi.js';

/** What the person's open draft says of itself: the steps saved, where today's rules reopen it, and what it holds. */
interface DraftSummary {
  saved: string[];
  /** The first saved step that today's rules refuse, or null. */
  reopen: string | null;
  /** The saved answers by the steps' input names, as input (a lines field is its rows): the earlier steps and the review start from them. */
  values: Record<string, unknown>;
  /** When the server lets the draft go, where it said: a page's `useForm` shows it. */
  expiresAt?: string;
}

/** What SavedFormSurface needs of a signed-in form's server. */
export interface DraftTransport {
  /** The open draft, or null: opening the form lands straight in it. */
  resume(): Promise<DraftSummary | null>;
  step(step: string, key: string, input: CommandInputValue): Promise<void>;
  /** The version of the draft's rows as they are now: the submit carries it back, and a draft changed since is refused. */
  review(): Promise<string>;
  submit(key: string, input: CommandInputValue, version: string): Promise<FormReceipt>;
  /** Start over: the draft and its rows are discarded. */
  discard(): Promise<void>;
  /** The key in flight for a step (or the submit, `#review`), held across a reload. */
  keyFor(step: string): string;
  /** Whether a key is held for a step without making one: a held `#review` key is a submit not yet known to have landed. */
  holds(step: string): boolean;
  clearKey(step: string): void;
  clearKeys(): void;
}

interface DraftForm {
  id: string;
  command: { id: string; version: number };
  steps?: Array<{ id: string; command?: { id: string; version: number } }>;
}

const SUBMIT = '#review';

export function draftTransport(connection: string | null | undefined, form: DraftForm): DraftTransport {
  const storageKey = (step: string) => `mistri:draft-key:${connection ?? ''}:${form.command.id}:${step}`;
  /* Storage may be refused (a private window, a full quota): the key then lives for the page alone, as it did. */
  const memory = new Map<string, string>();
  const read = (step: string): string | undefined => {
    try {
      return window.sessionStorage.getItem(storageKey(step)) ?? memory.get(step);
    } catch {
      return memory.get(step);
    }
  };
  const clearKey = (step: string) => {
    memory.delete(step);
    try {
      window.sessionStorage.removeItem(storageKey(step));
    } catch {
      /* nothing was kept */
    }
  };
  const keyFor = (step: string) => {
    let key = read(step);
    if (!key) {
      key = crypto.randomUUID();
      memory.set(step, key);
      try {
        window.sessionStorage.setItem(storageKey(step), key);
      } catch {
        /* held in memory above */
      }
    }
    return key;
  };
  const envelope = (command: { id: string; version: number }, key: string, input: CommandInputValue) => ({
    command: command.id,
    commandVersion: command.version,
    key: {},
    expectedVersion: 0,
    idempotencyKey: key,
    input,
  });
  const call = (body: Record<string, unknown>) => api(COMMAND_ROUTES.draft, { form: form.id, ...ownedBy(connection), ...body });
  return {
    keyFor,
    holds: (step) => read(step) !== undefined,
    clearKey,
    clearKeys() {
      for (const step of [...(form.steps ?? []).map((item) => item.id), SUBMIT]) clearKey(step);
    },
    async resume() {
      const answer = (await call({ op: 'resume' })) as {
        draft?: { saved?: unknown; reopen?: unknown; values?: unknown; expiresAt?: unknown } | null;
      };
      const draft = answer?.draft;
      if (!draft) return null;
      return {
        saved: Array.isArray(draft.saved) ? draft.saved.filter((id): id is string => typeof id === 'string') : [],
        reopen: typeof draft.reopen === 'string' ? draft.reopen : null,
        values:
          draft.values && typeof draft.values === 'object' && !Array.isArray(draft.values) ? (draft.values as Record<string, unknown>) : {},
        ...(typeof draft.expiresAt === 'string' ? { expiresAt: draft.expiresAt } : {}),
      };
    },
    async step(step, key, input) {
      const command = form.steps?.find((item) => item.id === step)?.command;
      if (!command) throw new Error(say('noStep', { step }));
      await call({ op: 'step', step, request: envelope(command, key, input) });
    },
    async review() {
      const answer = (await call({ op: 'review' })) as { version?: unknown };
      if (typeof answer?.version !== 'string') throw new Error(say('theReviewHadNoVersion'));
      return answer.version;
    },
    async submit(key, input, version) {
      const answer = (await call({ op: 'submit', version, request: envelope(form.command, key, input) })) as {
        receiptId: string;
        status: string;
        result?: { reference?: unknown; message?: unknown };
      };
      const reference = answer.result?.reference;
      const said = answer.result?.message;
      return {
        ...(typeof reference === 'string' && reference.trim() ? { reference } : {}),
        ...(typeof said === 'string' && said.trim() ? { message: said.trim() } : {}),
        receipt: { id: answer.receiptId, status: answer.status },
      } as FormReceipt;
    },
    async discard() {
      await call({ op: 'discard' });
    },
  };
}
