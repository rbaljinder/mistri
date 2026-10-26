/**
 * A form saved on every step, as the page speaks to it (server/forms/savedFormHttp.ts).
 * Each answer names a step, never a value: the server is write-only to the
 * applicant, so the page is the only place what was typed can be read back,
 * and it is held in memory alone (SavedFormSurface.tsx).
 *
 *
 * The leave guard is formLeaveGuard.ts: FormSurface arms it on the first
 * page, and this module is fetched with the surfaces that save.
 */
import type { CommandInputValue } from '../commandState.js';
import { say } from '../copy/forms/components/savedFormApi.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

export interface SavedFormFailure extends Error {
  status?: number;
  code?: string;
  field?: string;
  retryAfter?: number;
  gone?: boolean;
}

async function post(path: string, body: unknown, challenge?: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchServer(path, {
      method: 'POST',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(30_000),
      // The App's human check's token, where it names one: every step writes, so each asks it (http/formRoutes.ts).
      headers: { 'content-type': 'application/json', ...(challenge ? { 'x-mistri-challenge': challenge } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    // No answer at all: "Failed to fetch", or the timeout's abort, is the browser's sentence, not the visitor's.
    throw new Error(say('couldNotReach'));
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* the status is the answer */
  }
  if (res.ok) return data;
  const retryAfter = Number(res.headers.get('retry-after') ?? data.retryAfter);
  throw Object.assign(new Error(String(data.message || data.error || say('theFormCouldNotBeSaved', { status: res.status }))), {
    status: res.status,
    code: typeof data.code === 'string' ? data.code : undefined,
    field: typeof data.field === 'string' ? data.field : undefined,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    // Forged, expired, submitted or another's: the one answer, and the cookie is already cleared.
    gone: res.status === 404 && data.code === 'not_found',
  }) as SavedFormFailure;
}

const base = (form: string) => `/api/forms/${encodeURIComponent(form)}`;

/**
 * The intake address the page was published with (a tenant App's `?via=…`),
 * or none. Every step, the resume and the submit carry it on as it was: the
 * server resolves it each time, and a draft is found only where it resolves.
 * Nothing on the page reads it otherwise, and an ordinary App ignores it.
 */
export const intakeAddress = (): string | undefined => new URLSearchParams(window.location.search).get('via') ?? undefined;
const carried = (): string => {
  const via = intakeAddress();
  return via ? `?via=${encodeURIComponent(via)}` : '';
};

/** Save one step; the answer is only that it was saved. */
export async function saveStep(
  form: string,
  step: string,
  submission: string,
  input: CommandInputValue,
  challenge?: string,
): Promise<void> {
  await post(`${base(form)}/steps/${encodeURIComponent(step)}${carried()}`, { input, submission }, challenge);
}

/** Which steps of this browser's application are saved, by id; none for no application at all. */
export async function savedSteps(form: string): Promise<string[]> {
  const data = await post(`${base(form)}/resume${carried()}`, {});
  return Array.isArray(data.saved) ? data.saved.filter((step): step is string => typeof step === 'string') : [];
}

/* ---------- the status check, and an application added to an account (server/forms/formLinkHttp.ts) ---------- */

/** A status as the check answers it: each shown column, in the author's words. */
export type ApplicationStatus = Record<string, string | null>;

/** The details a status check asks, by the column each confirms. */
interface StatusDetails {
  receipt: string;
  confirm: Record<string, string>;
}

/** The state of the application these details open. Any wrong detail throws the one refusal, whichever it was. */
export async function checkStatus(form: string, details: StatusDetails): Promise<ApplicationStatus> {
  const data = await post(`${base(form)}/status`, details);
  return (data.status ?? {}) as ApplicationStatus;
}

/** Signed in: the same check, then the application added to this account. */
export async function addByStatus(form: string, details: StatusDetails): Promise<string> {
  const data = await post(`${base(form)}/link`, details);
  return String((data.linked as { reference?: unknown } | undefined)?.reference ?? details.receipt);
}

/** What this browser's claim names: the receipt, none, or that nobody is signed in to add it. */
export async function readClaim(form: string): Promise<{ signedIn: false } | { signedIn: true; reference: string | null }> {
  try {
    const data = await post(`${base(form)}/claim`, {});
    const claim = data.claim as { reference?: unknown } | null | undefined;
    return { signedIn: true, reference: typeof claim?.reference === 'string' ? claim.reference : null };
  } catch (error) {
    if ((error as SavedFormFailure).status === 401) return { signedIn: false };
    throw error;
  }
}

/** Yes adds the claimed application to the signed-in account and answers its receipt; No burns the claim. */
export async function answerClaim(form: string, answer: 'yes' | 'no'): Promise<string | null> {
  const data = await post(`${base(form)}/claim`, { answer });
  return typeof (data.linked as { reference?: unknown } | undefined)?.reference === 'string'
    ? (data.linked as { reference: string }).reference
    : null;
}

/** The signed-in account's own applications; null when nobody is signed in. */
export async function myApplications(form: string): Promise<Array<{ reference: string; status: ApplicationStatus }> | null> {
  try {
    const data = await post(`${base(form)}/mine`, {});
    return Array.isArray(data.applications) ? (data.applications as Array<{ reference: string; status: ApplicationStatus }>) : [];
  } catch (error) {
    if ((error as SavedFormFailure).status === 401) return null;
    throw error;
  }
}

/* ---------- email: a status check's step-up, an address proved, and applications found by it (statusStepUp.ts, formLinkHttp.ts) ---------- */

/** The check's details, and a code to the address on the application. Wrong details throw the check's one refusal. */
export async function askStepUpCode(form: string, details: StatusDetails): Promise<void> {
  await post(`${base(form)}/stepup`, details);
}

/** The details again with the code: the state and the declared details. A wrong, used or expired code throws one refusal. */
export async function openStepUp(
  form: string,
  details: StatusDetails,
  code: string,
): Promise<{ status: ApplicationStatus; details: ApplicationStatus }> {
  const data = await post(`${base(form)}/stepup`, { ...details, code });
  return { status: (data.status ?? {}) as ApplicationStatus, details: (data.details ?? {}) as ApplicationStatus };
}

/** Signed in: the applications that captured this account's verified email — linked, and to confirm — or that it must be verified first. */
export async function foundByEmail(form: string): Promise<{ linked: string[]; found: string[]; verify: boolean } | null> {
  try {
    const data = await post(`${base(form)}/found`, {});
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    return { linked: list(data.linked), found: list(data.found), verify: data.verify === true };
  } catch (error) {
    if ((error as SavedFormFailure).status === 401) return null;
    throw error;
  }
}

/** Yes: that application, found by this account's email, is theirs. */
export async function claimFound(form: string, reference: string): Promise<void> {
  await post(`${base(form)}/found`, { reference });
}

/** A code to the address the applicant typed, to prove it is theirs; then the code back. */
export async function sendEmailProof(form: string, email: string): Promise<void> {
  await post(`${base(form)}/verify-email`, { email });
}
export async function confirmEmailProof(form: string, email: string, code: string): Promise<void> {
  await post(`${base(form)}/verify-email`, { email, code });
}
