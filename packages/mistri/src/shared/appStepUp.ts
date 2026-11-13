/**
 * Where a step-up's one-time code goes, said as the channel and the record's
 * column it reaches: `{ email: 'email' }`, `{ sms: 'mobile' }`. A status
 * check's step-up (appSavedForms.ts) adds its `show` beside that one key; a
 * capability link's (appLinks.ts) may also be a bare column, which is email.
 *
 * Email is the platform's own channel and the default; any other key is the
 * channel an integration declares (server/integrations/integrationModule.ts),
 * which sends the code under the tenant's own secrets. Whether an integration
 * declares it is a startup check (integrationChecks.ts), since the
 * declarations here do not see the App's jobs.
 */
import { isRecord } from '@mistriwork/engine/shared/model.js';
import { effectiveDisplay } from '@mistriwork/engine/shared/displayDefaults.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppDisplayRule } from '@mistriwork/engine/shared/servedApp.js';

/** The channel the platform sends on itself (adapters/inbox/inbox.ts `EMAIL_CHANNEL`). */
const EMAIL_CODE_CHANNEL = 'email';
/* An integration's channel name, as integrationModule.ts accepts it. */
const CHANNEL = /^[a-z][a-z0-9-]{0,31}$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** A step-up's code address: the record's column, and the channel when it is not email. */
export interface StepUpTarget {
  column: string;
  channel?: string;
}

/**
 * The one channel key of a step-up, read beside the keys the caller reads
 * itself (`others`, a status check's `show`). Exactly one: the code goes to
 * one address, so two keys would leave which one to guess.
 */
export function parseStepUpTarget(raw: Record<string, unknown>, at: string, others: readonly string[] = []): StepUpTarget {
  const keys = Object.keys(raw).filter((key) => !others.includes(key));
  const shape = `{ email: '<column>' }, or { <channel>: '<column>' } for a channel an integration declares, such as { sms: 'mobile' }`;
  if (keys.length !== 1) throw new Error(`${at} names ${keys.length ? 'more than one channel' : 'no channel'}: one key, ${shape}.`);
  const channel = keys[0]!;
  if (!CHANNEL.test(channel)) throw new Error(`${at} names "${channel}", which is not a channel: ${shape}.`);
  const column = raw[channel];
  if (typeof column !== 'string' || !COLUMN.test(column))
    throw new Error(`${at}, "${channel}" names the record's column the one-time code goes to.`);
  return { column, ...(channel === EMAIL_CODE_CHANNEL ? {} : { channel }) };
}

/** A link's `stepUp`: a bare column, which is email, or the one channel key. */
export function parseLinkStepUp(raw: unknown, at: string): StepUpTarget {
  if (typeof raw === 'string') {
    if (!COLUMN.test(raw)) throw new Error(`${at} names the record's email column the one-time code goes to.`);
    return { column: raw };
  }
  if (!isRecord(raw)) throw new Error(`${at} is the record's email column, or { <channel>: '<column>' } such as { sms: 'mobile' }.`);
  return parseStepUpTarget(raw, at);
}

/**
 * Why a step-up's column cannot be its code's address, if it cannot. Email
 * sends to a column drawn as an email address, and any other channel to one
 * drawn as a phone number: by its name (`email`, `mobile`) or by the
 * resource's display rule. A code sent to a name or a note goes nowhere, or
 * to someone else. A channel that reaches people by another handle is held to
 * a phone number too, until one asks for something else.
 */
export function stepUpAddressProblem(
  target: StepUpTarget,
  table: TableMeta,
  display: Readonly<Record<string, AppDisplayRule>> | undefined,
): string | undefined {
  const want = target.channel ? 'phone' : 'email';
  if (effectiveDisplay(display, table)[target.column]?.format === want) return undefined;
  const on = target.channel ? `the "${target.channel}" channel` : 'email';
  return (
    `sends its code by ${on} to "${target.column}", which is not ${want === 'email' ? 'an email' : 'a phone'} column: ` +
    `name it like one (${want === 'email' ? 'email' : 'phone, mobile'}) or give it display { format: '${want}' }.`
  );
}
