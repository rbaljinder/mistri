/**
 * The cut a sensitive input takes (`sensitive: { keep }`), and the keyed hash
 * `keep: 'hash'` keeps: the last four digits of an SSN a status check confirms,
 * say. The value is replaced right after the declaration's own rules pass —
 * before `validate`, the handler, the idempotency fingerprint or the audit
 * see it — so the plaintext is never written, logged or journalled.
 *
 * Keyed (HMAC under `MISTRI_FORM_KEY`), not a bare digest: four digits are
 * ten thousand guesses, and anyone holding the table but not the key must not
 * be able to try them. The key is derived per purpose, read from the
 * environment, never printed or stored; a deployment with a keyed input and
 * no key refuses to start rather than falling back to a digest.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { AppCommandField } from '../../shared/command.js';

const FORM_KEY_VARIABLE = 'MISTRI_FORM_KEY';

export class FormKeyMissing extends Error {
  constructor() {
    super(
      `A public form keeps an input as a keyed hash, which needs ${FORM_KEY_VARIABLE}: a secret of at least 32 bytes, ` +
        'kept apart from BETTER_AUTH_SECRET and MISTRI_AUDIT_KEY. It is read, never printed or stored; changing it ' +
        'makes every stored hash unmatched.',
    );
    this.name = 'FormKeyMissing';
  }
}

/* A suite App's secrets come from its own captured environment, never the
   process's: each App that a suite hosts is given its key here, by App id,
   and only an App nobody configured (`mistri serve`'s one) reads the
   process environment. The derivation is the same either way, so an App
   moved between serve and a suite keeps matching its stored hashes. */
const configured = new Map<string, string | undefined>();
const derived = new Map<string, Buffer>();

/** Bind an App's form key to the environment its deployment captured; `undefined` means it has none. */
export function configureFormKey(appId: string, environment: NodeJS.ProcessEnv): () => void {
  const secret = environment[FORM_KEY_VARIABLE];
  configured.set(appId, secret);
  return () => {
    if (configured.get(appId) === secret) configured.delete(appId);
  };
}

function formKey(appId?: string): Buffer {
  const secret = appId !== undefined && configured.has(appId) ? configured.get(appId) : process.env[FORM_KEY_VARIABLE];
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new FormKeyMissing();
  let key = derived.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'mistri.form-key', 'keyed-input.v1', 32));
    if (derived.size > 64) derived.clear();
    derived.set(secret, key);
  }
  return key;
}

/** Whether the deployment has a key; startup asks before serving a form that needs one. */
export function assertFormKey(appId?: string): void {
  formKey(appId);
}

/** The stored form of a keyed value: the input's own name salts it, so one value in two inputs does not visibly match. */
export function keyedHash(name: string, value: string, appId?: string): string {
  return `keyed:${createHmac('sha256', formKey(appId))
    .update(JSON.stringify(['mistri.keyed-input.v1', name, value.trim()]))
    .digest('hex')}`;
}

/** Compare a typed value with a stored hash in constant time; anything not a hash never matches. */
export function keyedMatches(name: string, value: string, stored: unknown, appId?: string): boolean {
  if (typeof stored !== 'string' || !/^keyed:[0-9a-f]{64}$/.test(stored)) return false;
  const expected = Buffer.from(keyedHash(name, value, appId).slice(6), 'hex');
  return timingSafeEqual(expected, Buffer.from(stored.slice(6), 'hex'));
}

/** Whether any field, however deep in a group, keeps a sensitive value as a keyed hash (`keep: 'hash'` or `'handler'`,
    whose hash is what everything but the handler holds): a deployment serving one needs the form key. */
export function hasKeyedInput(fields: readonly AppCommandField[]): boolean {
  return fields.some((field) =>
    field.type === 'group'
      ? hasKeyedInput(field.fields)
      : field.type === 'text' && (field.sensitive?.keep === 'hash' || field.sensitive?.keep === 'handler'),
  );
}

/** Whether any field, however deep in a group, is sensitive. */
function hasSensitiveInput(fields: readonly AppCommandField[]): boolean {
  return fields.some((field) =>
    field.type === 'group' ? hasSensitiveInput(field.fields) : field.type === 'text' && field.sensitive !== undefined,
  );
}

/** What a sensitive value is kept as: its last four characters, its keyed hash, or nothing (undefined). */
function kept(field: Extract<AppCommandField, { type: 'text' | 'textarea' }>, value: string, appId?: string): string | undefined {
  switch (field.sensitive!.keep) {
    case 'last4':
      return value.slice(-4);
    case 'none':
      return undefined;
    default:
      return keyedHash(field.name, value, appId);
  }
}

/**
 * The parsed input with every sensitive value cut to what its field keeps, groups and their rows included — the
 * one place a whole value leaves the request. What follows (validate, the rules, the handler, the idempotency
 * fingerprint, the journal, the audit, events, flags, logs) holds only what is kept. A `keep: 'handler'` value is
 * kept as its hash too, and handed back whole through `reveal`, which only the executor's call to the handler reads.
 */
export function cutSensitive(
  fields: readonly AppCommandField[],
  parsed: unknown,
  appId?: string,
  reveal?: (name: string, value: string) => void,
): unknown {
  if (!hasSensitiveInput(fields) || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  for (const field of fields) {
    const value = out[field.name];
    if (field.type === 'text' && field.sensitive && typeof value === 'string') {
      if (field.sensitive.keep === 'handler') reveal?.(field.name, value);
      const keep = kept(field, value, appId);
      if (keep === undefined) delete out[field.name];
      else out[field.name] = keep;
    } else if (field.type === 'group' && value !== undefined && value !== null) {
      // keep: 'handler' is a field of the input itself (command.ts), so a group's rows reveal nothing.
      out[field.name] = Array.isArray(value)
        ? value.map((row) => cutSensitive(field.fields, row, appId))
        : cutSensitive(field.fields, value, appId);
    }
  }
  return out;
}
