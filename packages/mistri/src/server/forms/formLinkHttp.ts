/**
 * Adding an application to an account, over HTTP (formLink.ts says why each
 * rule is what it is). Three paths under a saved form's key:
 *
 *   POST …/claim  {}                 signed in: the receipt this browser's claim names → { claim: { reference } | null }
 *   POST …/claim  { answer: 'yes' }  signed in: link it, burn the claim              → { linked: { reference } }
 *   POST …/claim  { answer: 'no' }   anyone: burn the claim                         → { claim: null }
 *   POST …/link   { receipt, confirm }  signed in: the status check, then the link  → { linked: { reference }, status }
 *   POST …/mine   {}                 signed in: the account's own applications      → { applications: [{ reference, status }] }
 *   POST …/found  {}                 signed in, a verified email: link those proved in the form, offer the rest
 *                                    → { linked: [reference], found: [reference] }
 *   POST …/found  { reference }      signed in, a verified email: Yes, that one is mine → { linked: { reference } }
 *   POST …/verify-email { email }        the draft's applicant: a code to that address       → { sent: true }
 *   POST …/verify-email { email, code }  the code: the draft holds the address as proved     → { verified: true }
 *
 * The account is the verified session's, handed in by the route, never a
 * request's. Every answer that ends a claim clears its cookie. A link is
 * written as the account's own act, so a record history names them, and the
 * account is told by email that it happened, where the server sends mail.
 */
import type { IncomingMessage } from 'node:http';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { attributeWrites } from '@mistriwork/engine/adapters/writeAttribution.js';
import type { AppFormView } from '../../shared/app.js';
import type { CommandCatalog } from '../commands/commandDb.js';
import {
  ALREADY_LINKED,
  CLAIM_GONE,
  claimCookie,
  burnClaim,
  linkByReceipt,
  ownedApplications,
  peekClaim,
  readClaim,
  recordLink,
  spendClaim,
  type LinkForm,
} from './formLink.js';
import { checkApplicationStatus, parseStatusRequest, settle, statusNotFound } from './statusCheck.js';
import type { SavedFormReply } from './savedFormHttp.js';
import type { EmailTransport } from '../email/email.js';
import { applicationsByEmail, linkByEmail, stampVerifiedEmail } from './formLink.js';
import { CODE_MINUTES, issueCode, spendCode } from './oneTimeCode.js';
import { draftTokenHash, readDraftToken } from './savedForms.js';

/** Who is signed in, from the verified session: the id a link writes, and the words a history says.
    `verifiedEmail` is the account's address when its sign-in store says it is verified, and absent otherwise. */
export interface LinkAccount {
  id: string;
  who?: string;
  name?: string;
  verifiedEmail?: string;
}
export type LinkedForm = AppFormView & LinkForm;

interface Linking {
  req: Pick<IncomingMessage, 'headers'>;
  key: string;
  form: LinkedForm;
  body: unknown;
  roots: readonly string[];
  catalog: CommandCatalog;
  secure: boolean;
  account?: LinkAccount;
  reading: <T>(run: (records: WriteTransaction) => Promise<T>) => Promise<T>;
  /** Where the server's mail goes, and the App's name it is sent in; absent, nothing is mailed. */
  mail?: EmailTransport;
  appName?: string;
  /** The App whose form this is (formKey.ts, statusCheck.ts). */
  appId?: string;
}

/* The account is told, after the fact, that an application is now in it: a
   link it did not make would not go unnoticed. Not waited on, never failing the link. */
function tellLinked(linking: Pick<Linking, 'mail' | 'appName' | 'form'>, account: LinkAccount, reference: string): void {
  const to = account.who;
  if (!linking.mail || !to || !/^[^\s@]+@[^\s@]+$/.test(to)) return;
  const app = linking.appName ?? 'the App';
  void linking.mail
    .send({
      to,
      subject: `${reference} was added to your ${app} account`,
      text:
        `Your ${linking.form.label} application ${reference} is now in your ${app} account, where you can follow it.\n\n` +
        `If you did not add it, tell ${app}'s staff: they can see how it was added and remove it.`,
    })
    .catch(() => {});
}

const SIGN_IN = 'Sign in to add an application to your account.';
const unauthenticated = (): SavedFormReply => ({ status: 401, body: { code: 'unauthenticated', message: SIGN_IN, error: SIGN_IN } });
const invalid = (message: string): SavedFormReply => ({ status: 400, body: { code: 'invalid_input', message, error: message } });

/** The account's writes, attributed to it: the history says who added the application, and by which path. */
const asAccount = <T>(account: LinkAccount, work: () => Promise<T>): Promise<T> =>
  attributeWrites(
    {
      ...(account.who ? { actor: account.who } : {}),
      ...(account.name ? { name: account.name } : {}),
      via: 'app',
      action: 'Add to account',
    },
    work,
  );

/** This browser's claim: peek at it, spend it, or burn it. */
export async function claimReply(linking: Linking): Promise<SavedFormReply> {
  const { req, key, form, body, roots, catalog, secure, account, reading } = linking;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((name) => name !== 'answer')) {
    return invalid('Answer yes or no.');
  }
  const answer = (body as { answer?: unknown }).answer;
  if (answer !== undefined && answer !== 'yes' && answer !== 'no') return invalid('Answer yes or no.');
  const claim = readClaim(req, key);
  const clear = [claimCookie(key, null, secure)];
  const now = new Date();
  if (answer === 'no') {
    // Declined, or a shared computer: the claim is burned whoever asks, signed in or not.
    if (claim) await reading((records) => burnClaim(records, catalog, roots, form, claim));
    recordLink(key, 'form.claim', claim ? 'declined' : 'none', account ? { account: account.id } : {});
    return { status: 200, body: { claim: null }, cookies: clear };
  }
  if (!account) return unauthenticated();
  if (!claim)
    return answer === 'yes'
      ? { status: 404, body: { code: 'not_found', message: CLAIM_GONE, error: CLAIM_GONE }, cookies: clear }
      : { status: 200, body: { claim: null } };
  if (answer === undefined) {
    const reference = await reading((records) => peekClaim(records, catalog, roots, form, claim, now));
    return reference ? { status: 200, body: { claim: { reference } } } : { status: 200, body: { claim: null }, cookies: clear };
  }
  const linked = await asAccount(account, () => reading((records) => spendClaim(records, catalog, roots, form, claim, account.id, now)));
  recordLink(key, 'form.link', linked ? 'linked' : 'refused', {
    account: account.id,
    via: 'same-device',
    ...(linked ? { receipt: linked } : {}),
  });
  if (!linked) return { status: 404, body: { code: 'not_found', message: CLAIM_GONE, error: CLAIM_GONE }, cookies: clear };
  tellLinked(linking, account, linked);
  return { status: 200, body: { linked: { reference: linked } }, cookies: clear };
}

/**
 * The status check, signed in, and then the link, in one transaction and to
 * the status check's floor of time: a wrong receipt or detail reads exactly
 * as the check's own refusal, and counts toward its lockout.
 */
export async function linkReply(linking: Linking): Promise<SavedFormReply> {
  const { key, form, body, roots, catalog, account, reading } = linking;
  if (!account) return unauthenticated();
  const started = Date.now();
  try {
    const request = parseStatusRequest(body, form.statusCheck);
    if (!request) return invalid('Give the reference and each detail asked.');
    let linked: 'linked' | 'owned' | 'gone' = 'gone';
    const answer = await asAccount(account, () =>
      reading(async (records) => {
        const checked = await checkApplicationStatus({
          check: form.statusCheck,
          save: form.save,
          roots,
          records,
          request,
          form: key,
          catalog,
          link: form.link,
          account: account.id,
          ...(linking.appId ? { appId: linking.appId } : {}),
        });
        if (checked.found) linked = await linkByReceipt(records, catalog, roots, form, checked.receipt, account.id, new Date());
        return checked;
      }),
    );
    if (!answer.found || linked === 'gone') return { status: 404, body: statusNotFound(true) };
    recordLink(key, 'form.link', linked, { account: account.id, via: 'status-check', receipt: answer.receipt });
    if (linked === 'owned') return { status: 409, body: { code: 'already_linked', message: ALREADY_LINKED, error: ALREADY_LINKED } };
    tellLinked(linking, account, answer.receipt);
    return { status: 200, body: { linked: { reference: answer.receipt }, status: answer.status } };
  } finally {
    await settle(started);
  }
}

/** The signed-in account's own applications: by the owner column, which only a link writes. */
export async function mineReply({ form, roots, account, reading, body }: Linking): Promise<SavedFormReply> {
  if (!account) return unauthenticated();
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return invalid('This takes no details.');
  const applications = await reading((records) => ownedApplications(records, roots, form, account.id));
  return { status: 200, body: { applications } };
}

const NOT_FOUND_BY_EMAIL = 'There is no application with your email waiting to be added. It may have been added already.';

/**
 * Applications found by the account's verified email: those the applicant
 * proved the same address for in the form are linked now, and the rest are
 * offered, each linked only by its own Yes. An account whose email is not
 * verified finds nothing — it is asked to verify, and nothing is matched.
 */
export async function foundReply(linking: Linking): Promise<SavedFormReply> {
  const { key, form, body, roots, catalog, account, reading } = linking;
  if (!account) return unauthenticated();
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((name) => name !== 'reference'))
    return invalid('Name the application, or nothing.');
  const reference = (body as { reference?: unknown }).reference;
  if (reference !== undefined && (typeof reference !== 'string' || !reference.trim() || reference.length > 64))
    return invalid('Name the application, or nothing.');
  const email = account.verifiedEmail;
  if (!email) return { status: 200, body: { linked: [], found: [], verify: true } };
  const now = new Date();
  if (reference === undefined) {
    const found = await reading((records) => applicationsByEmail(records, roots, form, email));
    const linked: string[] = [];
    for (const silent of found.silent) {
      const outcome = await asAccount(account, () =>
        reading((records) => linkByEmail(records, catalog, roots, form, silent, account.id, email, now)),
      );
      recordLink(key, 'form.link', outcome, { account: account.id, via: 'email', receipt: silent });
      if (outcome === 'linked') {
        linked.push(silent);
        tellLinked(linking, account, silent);
      }
    }
    return { status: 200, body: { linked, found: found.offer } };
  }
  const outcome = await asAccount(account, () =>
    reading((records) => linkByEmail(records, catalog, roots, form, reference.trim(), account.id, email, now)),
  );
  recordLink(key, 'form.link', outcome, { account: account.id, via: 'email', receipt: reference.trim() });
  if (outcome === 'owned') return { status: 409, body: { code: 'already_linked', message: ALREADY_LINKED, error: ALREADY_LINKED } };
  if (outcome === 'gone') return { status: 404, body: { code: 'not_found', message: NOT_FOUND_BY_EMAIL, error: NOT_FOUND_BY_EMAIL } };
  tellLinked(linking, account, reference.trim());
  return { status: 200, body: { linked: { reference: reference.trim() } } };
}

const VERIFY_REFUSED = 'That code is not right for this address, or it has expired or been used. Ask for a new one.';
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * The applicant proves the address they typed, in the form, before
 * submitting: a code to it, then the code back. The draft is this browser's
 * (its resume cookie); what is stamped is the address proved, on the draft's
 * root, where a link by email may later trust it. Three codes a draft an hour,
 * to whatever address, so the form is no way to flood a mailbox.
 */
export async function verifyEmailReply(linking: Linking): Promise<SavedFormReply> {
  const { req, key, form, body, roots, catalog, reading } = linking;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((name) => name !== 'email' && name !== 'code'))
    return invalid('Give the email, and the code when you have one.');
  const { email, code } = body as { email?: unknown; code?: unknown };
  if (typeof email !== 'string' || !ADDRESS.test(email.trim()) || email.length > 254 || (code !== undefined && typeof code !== 'string')) {
    return invalid('Give the email, and the code when you have one.');
  }
  const cookie = readDraftToken(req, key);
  if (!cookie) return { status: 404, body: { code: 'not_found', message: 'Start the application first: the address is proved for it.' } };
  const token = draftTokenHash(cookie);
  const address = email.trim().toLowerCase();
  const subject = `verify\u0000${key}\u0000${token}`;
  if (code === undefined) {
    const issued = issueCode(subject, Date.now(), address);
    if ('limited' in issued) {
      const message = 'Several codes were sent for this application in the last hour. Use the newest one, or try again later.';
      return { status: 429, body: { code: 'rate_limited', message, error: message } };
    }
    const app = linking.appName ?? 'the App';
    if (linking.mail) {
      void linking.mail
        .send({
          to: address,
          subject: `${app}: your code is ${issued.code}`,
          text:
            `Your code is ${issued.code}.\n\nEnter it in the ${form.label} form on ${app} to confirm this is your email. It works once, for ${CODE_MINUTES} minutes.\n\n` +
            'If you did not ask for it, you can ignore this email.',
        })
        .catch(() => {});
    }
    return { status: 200, body: { sent: true } };
  }
  if (!spendCode(subject, code, Date.now(), address))
    return { status: 404, body: { code: 'code_refused', message: VERIFY_REFUSED, error: VERIFY_REFUSED } };
  const stamped = await reading((records) => stampVerifiedEmail(records, catalog, roots, form, token, address));
  if (!stamped) return { status: 404, body: { code: 'not_found', message: 'Start the application first: the address is proved for it.' } };
  return { status: 200, body: { verified: true } };
}
