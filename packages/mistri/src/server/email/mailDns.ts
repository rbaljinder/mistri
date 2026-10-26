/**
 * `mistri mail-dns <config.json>`: the DNS records a deployment's tenant
 * mail needs, per sending domain — the service's own and each tenant's
 * (`domains`) — so a receiving server believes the mail is theirs.
 *
 * - DKIM: one key for the deployment, the same TXT record under the same
 *   selector in every domain; a message is signed `d=` its From domain.
 *   When the config names a key file that is not there yet, a 2048-bit key
 *   is made and written there (mode 0600) and its record printed.
 * - SPF: on the domain bounces return to (the envelope sender, `returnPath`,
 *   else the service's own domain), naming the relay's include (`spf`).
 * - DMARC: a starting record, `p=none`, to tighten once reports are clean.
 *
 * Nothing is sent and no server starts: it reads the config, and at most
 * writes the key.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { serviceConnectionOf } from '@mistriwork/engine/server/configSections.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';
import { dkimKey, dkimRecord, generateDkimKey } from './dkim.js';
import type { EmailServiceConfig } from './email.js';

/** A TXT value in quoted strings of at most 255 characters, as DNS holds one. */
const quoted = (value: string) => (value.match(/.{1,255}/g) ?? ['']).map((part) => `"${part}"`).join(' ');

/** The records as lines, and whether a key was written. Throws naming what is missing. */
export function mailDnsRecords(path: string, environment: NodeJS.ProcessEnv = process.env): { lines: string[]; wrote?: string } {
  const config = JSON.parse(readFileSync(path, 'utf8')) as { connections?: unknown };
  const entry = (Array.isArray(config.connections) ? config.connections : []).find(
    (each): each is Record<string, unknown> => !!each && typeof each === 'object' && (each as { kind?: unknown }).kind === 'email',
  );
  if (!entry) throw new Error(`${path} names no email service (a connection of "kind": "email").`);
  const service = serviceConnectionOf(CONFIG_SECTIONS, entry, path) as EmailServiceConfig;
  if (!service.dkim)
    throw new Error(
      `The email service in ${path} has no "dkim". Add "dkim": { "selector": "tw1", "key": "dkim-tw1.pem" } and run this again.`,
    );
  const keyPath = expandEnvReferences(service.dkim.key, environment);
  const file = isAbsolute(keyPath) ? keyPath : resolve(dirname(resolve(path)), keyPath);
  let wrote: string | undefined;
  if (!existsSync(file)) {
    writeFileSync(file, generateDkimKey(), { mode: 0o600, flag: 'wx' });
    wrote = file;
  }
  const key = dkimKey(service.dkim.selector, readFileSync(file, 'utf8'));
  const record = quoted(dkimRecord(key));
  const own = service.from.match(/@([^>\s]+)>?\s*$/)![1].toLowerCase();
  const bounce = service.returnPath ?? own;
  const lines = [
    `Bounces return to ${service.returnPath ? `bounce+<tenant>@${service.returnPath}` : `${own} (the service's "from")`}: its SPF names the relay.`,
    `  ${bounce}  TXT  "v=spf1 include:${service.spf ?? "<your relay's SPF include>"} ~all"`,
    ...(service.returnPath ? [`  ${bounce}  MX   <your relay's bounce host>`] : []),
    '',
  ];
  for (const [domain, tenant] of [[own, undefined], ...Object.entries(service.domains ?? {})] as Array<[string, string | undefined]>) {
    lines.push(
      tenant ? `${domain} (tenant ${tenant}):` : `${domain} (the service's own; every other tenant's mail is sent From it):`,
      `  ${service.dkim.selector}._domainkey.${domain}  TXT  ${record}`,
      `  _dmarc.${domain}  TXT  "v=DMARC1; p=none"`,
      '',
    );
  }
  return { lines, ...(wrote ? { wrote } : {}) };
}

export function runMailDns(args: readonly string[]): number {
  const path = args[0] ?? 'mistri.json';
  if (args.length > 1 || path.startsWith('-')) {
    console.error('Usage: mistri mail-dns [<config.json>]');
    return 2;
  }
  try {
    const { lines, wrote } = mailDnsRecords(path);
    if (wrote) console.error(`mistri: wrote a new DKIM key to ${wrote}. Keep it secret; every record below names its public half.`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (error) {
    console.error(`mistri: ${(error as Error).message}`);
    return 1;
  }
}
