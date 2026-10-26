/**
 * DKIM (RFC 6376) for the mail a tenant App sends: rsa-sha256, relaxed
 * header and body canonicalization, one key for the deployment.
 *
 * One key, many domains: every domain mail is sent from publishes the same
 * public key under the same selector (`mistri mail-dns` prints the
 * record for each), and a message is signed with `d=` its From address's
 * domain. node:crypto holds the RSA; the rest is the two canonical forms,
 * which a known-answer test pins (test/email-dkim.test.ts), because a
 * signature over the wrong bytes is still a signature — it just never
 * verifies, and nobody is told.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/** The headers signed when present, in this order. Each is signed once: its last instance, as a verifier reads it. */
const SIGNED = [
  'from',
  'to',
  'cc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
];

export interface DkimKey {
  /** The selector its public key is published under: `<selector>._domainkey.<domain>`. */
  readonly selector: string;
  readonly privateKey: KeyObject;
}

/** A PEM private key read for signing, refused unless it is RSA of at least 1024 bits (2048 is what a new one gets). */
export function dkimKey(selector: string, pem: string): DkimKey {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(selector)) throw new Error('A DKIM selector is one DNS label, like "tw1".');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error('The DKIM private key is not a PEM private key.');
  }
  const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (privateKey.asymmetricKeyType !== 'rsa' || bits < 1024) throw new Error('The DKIM private key must be RSA, 1024 bits or more.');
  return Object.freeze({ selector, privateKey });
}

/** A new 2048-bit key, as PEM: what `mistri mail-dns` writes when the config names none yet. */
export function generateDkimKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

/** The TXT record's value for a key: `v=DKIM1; k=rsa; p=<the public key, base64 DER>`. */
export function dkimRecord(key: DkimKey): string {
  const der = createPublicKey(key.privateKey).export({ type: 'spki', format: 'der' });
  return `v=DKIM1; k=rsa; p=${der.toString('base64')}`;
}

/** The relaxed body: whitespace runs as one space, none at a line's end, no empty lines at the end, and one CRLF closing a body that has words. */
export function relaxedBody(body: string): string {
  const lines = body.split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

/** One relaxed header line: the name in lower case, the value unfolded, whitespace runs as one space, none at either end. */
export function relaxedHeader(name: string, value: string): string {
  return `${name.trim().toLowerCase()}:${value
    .replace(/\r\n(?=[ \t])/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()}`;
}

/** A message's headers as name and raw value, folded continuation lines kept with their header. */
function headersOf(head: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].value += `\r\n${line}`;
    else {
      const colon = line.indexOf(':');
      if (colon > 0) out.push({ name: line.slice(0, colon), value: line.slice(colon + 1) });
    }
  }
  return out;
}

/**
 * The message with a DKIM-Signature header first, signed for `domain`.
 * `message` is RFC 5322 text with CRLF line ends, as composeMessage writes it.
 */
export function dkimSign(message: string, key: DkimKey, domain: string, now = new Date()): string {
  const split = message.indexOf('\r\n\r\n');
  const head = split < 0 ? message : message.slice(0, split);
  const body = split < 0 ? '' : message.slice(split + 4);
  const headers = headersOf(head);
  const signed: string[] = [];
  const lines: string[] = [];
  for (const name of SIGNED) {
    const found = headers.filter((header) => header.name.toLowerCase() === name).pop();
    if (!found) continue;
    signed.push(name);
    lines.push(relaxedHeader(found.name, found.value));
  }
  const bodyHash = createHash('sha256').update(relaxedBody(body), 'utf8').digest('base64');
  const tags =
    `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain.toLowerCase()}; s=${key.selector}; ` +
    `t=${Math.floor(now.getTime() / 1000)}; h=${signed.join(':')}; bh=${bodyHash}; b=`;
  // The signature header signs itself with b= empty, and without its closing CRLF.
  const input = `${lines.map((line) => `${line}\r\n`).join('')}${relaxedHeader('DKIM-Signature', tags)}`;
  const signature = sign('sha256', Buffer.from(input, 'utf8'), key.privateKey).toString('base64');
  return `DKIM-Signature: ${tags}${signature}\r\n${message}`;
}
