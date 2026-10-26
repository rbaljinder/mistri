/**
 * A status check's step-up (`statusCheck.stepUp`): more than the state, for
 * a person who proves they hold the email on the application.
 *
 *   POST …/stepup  { receipt, confirm }         the check, then a code to the address on file → { sent: true }
 *   POST …/stepup  { receipt, confirm, code }   the check and the code → { status, details }, and a session
 *   POST …/details {}                           while the session lives → { status, details }
 *
 * The receipt and its confirmations are asked again with the code, so the
 * code alone opens nothing and every wrong detail still counts toward the
 * check's lockout, with its one refusal and its floor of time. The code goes
 * to the root's own email column, never an address the request names: it is
 * one-time, ten minutes, three to an application an hour (oneTimeCode.ts).
 * A wrong, reused or expired code is one answer too. Sending is not waited
 * on — a slow relay must not tell a found application from a missing one by
 * the clock — and a send that fails says nothing different.
 *
 * Passing mints a session for that one application: a random token in an
 * HttpOnly, SameSite=Strict cookie scoped to the form's API path for fifteen
 * minutes, kept in this process as a digest. It shows the declared details
 * (`stepUp.show`) and nothing else, and only while the application is not an
 * account's — once linked, it is read by its owner's session alone.
 */
import { resetSignInState, signInState } from '../auth/signInState.js';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { statusWords, type AppFormLink, type AppFormSave, type AppStatusCheck } from '../../shared/appSavedForms.js';
import type { CommandCatalog } from '../commands/commandDb.js';
import type { EmailTransport } from '../email/email.js';
import { CODE_MINUTES, issueCode, spendCode } from './oneTimeCode.js';
import { checkApplicationStatus, parseStatusRequest, settle, statusNotFound } from './statusCheck.js';
import type { SavedFormReply } from './savedFormHttp.js';

type StepUp = NonNullable<AppStatusCheck['stepUp']>;
export interface StepUpForm {
  label: string;
  save: AppFormSave;
  statusCheck: AppStatusCheck & { stepUp: StepUp };
  link?: AppFormLink;
}

interface StepUpRequest {
  req: Pick<IncomingMessage, 'headers'>;
  key: string;
  form: StepUpForm;
  body: unknown;
  roots: readonly string[];
  catalog: CommandCatalog;
  secure: boolean;
  account?: string;
  appName: string;
  mail: EmailTransport | undefined;
  /** The App whose form this is (formKey.ts, statusCheck.ts). */
  appId?: string;
  reading: <T>(run: (records: WriteTransaction) => Promise<T>) => Promise<T>;
}

const CODE_REFUSED = 'That code is not right, or it has expired or been used. Ask for a new one.';
const SESSION_MINUTES = 15;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/* A session lives in the deployment's sign-in state (auth/signInState.ts), so
   a step-up proved on one instance opens the details on another. It names
   its App and form: a suite's Apps share one store and may share a form name. */
interface Session {
  app?: string;
  form: string;
  receipt: string;
  until: number;
}
const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const cookieName = (form: string) => `tw_stepup_${form}`;

/** Forget every step-up session: tests use it. */
export function resetStepUpSessions(): void {
  resetSignInState();
}

function sessionCookie(form: string, token: string | null, secure: boolean): string {
  const parts = [
    `${cookieName(form)}=${token ?? ''}`,
    `Path=/api/forms/${form}`,
    'HttpOnly',
    'SameSite=Strict',
    token === null ? 'Max-Age=0' : `Max-Age=${SESSION_MINUTES * 60}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function readSession(
  req: Pick<IncomingMessage, 'headers'>,
  form: string,
  now: number,
  app: string | undefined,
): Promise<Session | undefined> {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return undefined;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName(form)}=`));
  const token = values.length === 1 ? values[0].slice(cookieName(form).length + 1) : '';
  if (!TOKEN.test(token)) return undefined;
  const session = await signInState.read<Session>('stepup', hashOf(token));
  if (!session || session.form !== form || session.app !== app || typeof session.receipt !== 'string') return undefined;
  if (!(session.until > now)) {
    await signInState.remove('stepup', hashOf(token));
    return undefined;
  }
  return session;
}

// One App's codes are its own: a suite's Apps share this process and may share a form name.
const receiptSubject = (form: string, receipt: string, app?: string) =>
  `stepup\u0000${createHash('sha256')
    .update(app === undefined ? `${form}\u0000${receipt}` : `${app}\u0000${form}\u0000${receipt}`)
    .digest('hex')}`;

/** The declared details, in the author's words where they gave some. */
const detailsOf = (check: AppStatusCheck & { stepUp: StepUp }, values: Record<string, unknown>) =>
  Object.fromEntries(check.stepUp.show.map((name) => [name, statusWords(check, name, values[name])]));

function sendCode(mail: EmailTransport | undefined, to: unknown, code: string, appName: string, label: string, form: string): void {
  if (!mail || typeof to !== 'string' || !EMAIL.test(to.trim())) {
    process.stderr.write(`${JSON.stringify({ event: 'form.step_up', form, outcome: 'undeliverable' })}\n`);
    return;
  }
  void mail
    .send({
      to: to.trim(),
      subject: `${appName}: your code is ${code}`,
      text:
        `Your code is ${code}.\n\nIt opens the details of your ${label} application on ${appName}, once, for ${CODE_MINUTES} minutes.\n\n` +
        'If you did not ask for it, you can ignore this email: nothing opens without it.',
    })
    .catch(() => process.stderr.write(`${JSON.stringify({ event: 'form.step_up', form, outcome: 'send_failed' })}\n`));
}

/** The step-up: a code to the address on file, or the code spent for a session and the details. */
export async function stepUpReply({
  key,
  form,
  body,
  roots,
  catalog,
  secure,
  account,
  appName,
  mail,
  reading,
  appId,
}: StepUpRequest): Promise<SavedFormReply> {
  const started = Date.now();
  const check = form.statusCheck;
  try {
    const given = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
    const { code, ...details } = given ?? {};
    const request = given ? parseStatusRequest(details, check) : undefined;
    if (!request || (code !== undefined && typeof code !== 'string')) {
      return {
        status: 400,
        body: { code: 'invalid_input', message: 'Give the reference, each detail asked, and the code when you have one.' },
      };
    }
    const answer = await reading((records) =>
      checkApplicationStatus({
        check,
        save: form.save,
        roots,
        records,
        request,
        form: key,
        catalog,
        ...(appId ? { appId } : {}),
        ...(form.link ? { link: form.link } : {}),
        ...(account ? { account } : {}),
        more: [check.stepUp.email, ...check.stepUp.show],
      }),
    );
    if (!answer.found) return { status: 404, body: statusNotFound(Boolean(form.link)) };
    const subject = receiptSubject(key, answer.receipt, appId);
    if (code === undefined) {
      const issued = issueCode(subject);
      if ('limited' in issued) {
        const message = 'Several codes were sent for this application in the last hour. Use the newest one, or try again later.';
        return { status: 429, body: { code: 'rate_limited', message, error: message } };
      }
      sendCode(mail, answer.more?.[check.stepUp.email], issued.code, appName, form.label, key);
      return { status: 200, body: { sent: true } };
    }
    if (!spendCode(subject, code)) return { status: 404, body: { code: 'code_refused', message: CODE_REFUSED, error: CODE_REFUSED } };
    const token = randomBytes(32).toString('base64url');
    const until = Date.now() + SESSION_MINUTES * 60_000;
    await signInState.put(
      'stepup',
      hashOf(token),
      { ...(appId === undefined ? {} : { app: appId }), form: key, receipt: answer.receipt, until } satisfies Session,
      until,
    );
    process.stderr.write(`${JSON.stringify({ event: 'form.step_up', form: key, outcome: 'opened' })}\n`);
    return {
      status: 200,
      body: { status: answer.status, details: detailsOf(check, answer.more ?? {}) },
      cookies: [sessionCookie(key, token, secure)],
    };
  } finally {
    await settle(started);
  }
}

/** The details again, while this browser's step-up session lives and the application is nobody else's. */
export async function detailsReply({
  req,
  key,
  form,
  body,
  roots,
  secure,
  account,
  reading,
  appId,
}: StepUpRequest): Promise<SavedFormReply> {
  const gone = {
    status: 404,
    body: { code: 'not_found', message: 'This view has ended. Check the application again for a new code.' },
    cookies: [sessionCookie(key, null, secure)],
  };
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
    return { status: 400, body: { code: 'invalid_input', message: 'This takes no details.' } };
  }
  const session = await readSession(req, key, Date.now(), appId);
  if (!session) return gone;
  const check = form.statusCheck;
  const row = await reading(async (records) => {
    const found: Array<Record<string, unknown>> = [];
    for (const table of roots) {
      const result = await records.query({
        table,
        limit: 2,
        offset: 0,
        filter: { groups: [[{ column: check.receipt, op: '=', value: session.receipt }]] },
        columns: [...new Set([form.save.draft.column, ...check.show, ...check.stepUp.show, ...(form.link ? [form.link.owner] : [])])],
      });
      found.push(...result.rows);
    }
    return found.length === 1 && String(found[0][form.save.draft.column]) !== form.save.draft.value ? found[0] : undefined;
  });
  const owner = form.link ? row?.[form.link.owner] : undefined;
  if (!row || (owner !== null && owner !== undefined && owner !== '' && String(owner) !== account)) return gone;
  return {
    status: 200,
    body: {
      status: Object.fromEntries(check.show.map((name) => [name, statusWords(check, name, row[name])])),
      details: detailsOf(check, row),
    },
  };
}
