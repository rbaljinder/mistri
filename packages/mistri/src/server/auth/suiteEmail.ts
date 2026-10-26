/** Delivery only: the caller has committed a subject-bound invitation and
 * resolved that native subject's email on the server before calling here.
 * Mail configuration and its environment belong to the caller's transport,
 * independently of identity-store secrets. No account or grant access here. */
import { parseBasePath } from '@mistriwork/engine/shared/mount.js';
import type { EmailTransport } from '../email/email.js';

export interface SuiteInvitationEmail {
  /** Server-resolved native subject email, never a request-supplied recipient. */
  subjectEmail: string;
  appName: string;
  /** Trusted configured serialized origin, never derived from request Host. */
  publicOrigin: string;
  /** Canonical suite base path: empty for root, otherwise `/segment[/segment]`. */
  basePath: string;
  invitation: { readonly appId: string; readonly token: string };
}

/** Accepted by the transport (including `log:`), not proof of inbox delivery.
 * Unknown never rolls back issuance, retries mail, or issues another token. */
type SuiteInvitationEmailResult = { status: 'accepted' } | { status: 'unknown'; error: 'invalid-invitation-email' | 'email-send-failed' };

const APP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// A deliberately bounded mailbox: one unquoted dot-atom and DNS domain.
const MAILBOX =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function validOrigin(origin: string): boolean {
  const url = new URL(origin);
  // Comparing the serialization rejects even an empty query/hash, default
  // ports, trailing slash, whitespace and URL parser normalization tricks.
  if (url.origin !== origin || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
  );
}

/** One best-effort delivery attempt. Results contain neither tokens, URLs,
 * recipients nor SMTP error text. Invalid input is refused before sending. */
export async function sendSuiteInvitationEmail(
  transport: EmailTransport,
  input: SuiteInvitationEmail,
): Promise<SuiteInvitationEmailResult> {
  let text: string, subject: string, to: string;
  try {
    const { subjectEmail, appName, publicOrigin, basePath, invitation } = input;
    if (
      typeof subjectEmail !== 'string' ||
      subjectEmail.trim() !== subjectEmail ||
      subjectEmail.length > 254 ||
      subjectEmail.split('@')[0].length > 64 ||
      !MAILBOX.test(subjectEmail) ||
      typeof appName !== 'string' ||
      !appName.trim() ||
      appName.length > 256 ||
      /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(appName) ||
      typeof publicOrigin !== 'string' ||
      !validOrigin(publicOrigin) ||
      typeof basePath !== 'string' ||
      parseBasePath(basePath) !== basePath ||
      typeof invitation?.appId !== 'string' ||
      invitation.appId.trim() !== invitation.appId ||
      !APP_ID.test(invitation.appId) ||
      typeof invitation.token !== 'string' ||
      invitation.token.length !== 43 ||
      !TOKEN.test(invitation.token)
    ) {
      return { status: 'unknown', error: 'invalid-invitation-email' };
    }
    const url = `${publicOrigin}${basePath}/_mistri/apps#invite=${invitation.appId}.${invitation.token}`;
    to = subjectEmail;
    subject = `Invitation to ${appName}`;
    text = `You have been invited to ${appName}.\n\nSign in with the account this invitation was issued to, then accept it:\n${url}\n\nThis invitation does not grant access until it is accepted.\n`;
  } catch {
    return { status: 'unknown', error: 'invalid-invitation-email' };
  }
  try {
    await transport.send({ to, subject, text, sensitive: true });
    return { status: 'accepted' };
  } catch {
    return { status: 'unknown', error: 'email-send-failed' };
  }
}
