/**
 * A DKIM verifier written apart from packages/mistri/src/server/email/dkim.ts, from RFC 6376
 * §3.4.2, §3.4.4 and §3.7, so a test that signs with one and checks with the
 * other is two readings of the RFC agreeing — not one function agreeing with
 * itself. Relaxed/relaxed and rsa-sha256 only, which is all the platform signs.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

const canonHeader = (name: string, value: string) =>
  `${name.toLowerCase().trim()}:${value
    .replace(/\r\n/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/^ | $/g, '')}`;

function canonBody(body: string): string {
  let out = body
    .split('\r\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').replace(/ $/, ''))
    .join('\r\n');
  out = out.replace(/(\r\n)*$/, '');
  return out === '' ? '' : `${out}\r\n`;
}

export interface DkimVerdict {
  ok: boolean;
  bodyOk: boolean;
  tags: Record<string, string>;
}

/** Whether the first DKIM-Signature of a CRLF message verifies under the public key in `record` (`v=DKIM1; k=rsa; p=…`) or a key. */
export function verifyDkim(raw: string, key: string | KeyObject): DkimVerdict {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split),
    body = raw.slice(split + 4);
  const fields: Array<[string, string]> = [];
  for (const line of head.split('\r\n')) {
    if (/^[\t ]/.test(line)) fields[fields.length - 1][1] += `\r\n${line}`;
    else fields.push([line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]);
  }
  const signature = fields.find(([name]) => name.toLowerCase() === 'dkim-signature');
  if (!signature) return { ok: false, bodyOk: false, tags: {} };
  const tags = Object.fromEntries(
    signature[1]
      .replace(/\r\n/g, '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => [part.slice(0, part.indexOf('=')).trim(), part.slice(part.indexOf('=') + 1).replace(/\s+/g, '')]),
  ) as Record<string, string>;
  const bodyOk = createHash('sha256').update(canonBody(body)).digest('base64') === tags.bh;
  // Each name in h= takes the next instance from the bottom, as §5.4.2 says.
  const used = new Map<string, number>();
  const lines: string[] = [];
  for (const name of tags.h.split(':')) {
    const all = fields.filter(([field]) => field.toLowerCase() === name.toLowerCase() && field.toLowerCase() !== 'dkim-signature');
    const taken = used.get(name.toLowerCase()) ?? 0;
    const field = all[all.length - 1 - taken];
    used.set(name.toLowerCase(), taken + 1);
    if (field) lines.push(`${canonHeader(field[0], field[1])}\r\n`);
  }
  const unsigned = signature[1].replace(/(\bb=)[^;]*$/, '$1');
  const input = lines.join('') + canonHeader(signature[0], unsigned);
  const publicKey =
    typeof key === 'string'
      ? createPublicKey({ key: Buffer.from(/p=([^;\s]+)/.exec(key)![1], 'base64'), format: 'der', type: 'spki' })
      : key;
  const ok = bodyOk && verify('sha256', Buffer.from(input), publicKey, Buffer.from(tags.b, 'base64'));
  return { ok, bodyOk, tags };
}
