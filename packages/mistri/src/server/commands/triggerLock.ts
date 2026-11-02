/**
 * The triggers half of authority.lock (docs/trigger-effects.md): one line per trigger a row-policy App names in
 * `resources.<t>.triggers`, with the digest of its definition as the database holds it and, beneath, the effects
 * the platform read from it.
 *
 *   trigger entries.post_balance on insert sha256:3f1c…
 *     writes account.posted_minor where account.id = NEW.account_id
 *
 * Naming is the approval and the line is the review, so an App that names a trigger needs the lock. A named trigger
 * whose definition is not the one a line approved (changed since, never written, or no lock at all) is a problem
 * `mistri check` names, the server refuses to start over it, and a write that fires it is refused (a digest no
 * definition has is pinned into the transaction, triggerProof.ts). `mistri check --write-authority` writes the
 * lines, as it writes the rest of the lock. The effect lines are for the reader: the digest is what is compared.
 */
import type { ScopeTrigger } from '@mistriwork/engine/adapters/scoped/scopedTransaction.js';
import type { AppDef } from '../../shared/app.js';

type TriggerEffect = NonNullable<ScopeTrigger['effects']>[number];
type EffectTerm = NonNullable<TriggerEffect['values']>[string];

export const TRIGGER_LINE_PREFIX = 'trigger ';
const LINE = /^trigger (.+) on ((?:insert|update|delete)(?:, (?:insert|update|delete))*) (sha256:[0-9a-f]{64})$/;
/** An effect line beneath a trigger line: indented, and never a fact of the authority report. */
export const EFFECT_LINE = /^\s+(writes|inserts|deletes|reads) /;

/** Whether a resource of `app` names triggers: the App's commands then run under the lock's trigger lines. */
export const namesTriggers = (app: Pick<AppDef, 'auth' | 'resources'>): boolean =>
  app.auth?.rows === 'policy' && Object.values(app.resources ?? {}).some((resource) => resource.triggers?.length);

/** The lock's approved digests, by `resource.trigger`; undefined where the App keeps no lock. */
export function lockedTriggers(lock: string | undefined): Map<string, string> | undefined {
  if (lock === undefined) return undefined;
  const found = new Map<string, string>();
  for (const raw of lock.split(/\r?\n/)) {
    const match = LINE.exec(raw.trim());
    if (match) found.set(match[1], match[3]);
  }
  return found;
}

const term = (value: EffectTerm): string =>
  'row' in value
    ? `${value.row === 'new' ? 'NEW' : 'OLD'}.${value.column}`
    : 'literal' in value
      ? value.literal === null
        ? 'NULL'
        : typeof value.literal === 'number'
          ? String(value.literal)
          : `'${value.literal.replaceAll("'", "''")}'`
      : '(computed)';

/** One effect as the lock says it. */
export function sayEffect(effect: TriggerEffect): string {
  const where = Object.entries(effect.key ?? {})
    .map(([column, ref]) => `${effect.table}.${column} = ${term(ref)}`)
    .join(' and ');
  const values = Object.entries(effect.values ?? {});
  switch (effect.kind) {
    case 'update':
      return `writes ${values.map(([column]) => `${effect.table}.${column}`).join(', ')} where ${where}`;
    case 'read':
      return `reads ${values.map(([column]) => `${effect.table}.${column}`).join(', ')} where ${where}`;
    case 'delete':
      return `deletes ${effect.table} where ${where}`;
    case 'insert':
      return `inserts ${effect.table}${values.length ? ` with ${values.map(([column, value]) => `${column} = ${term(value)}`).join(', ')}` : ''}`;
  }
}

export interface TriggerLockFindings {
  /** The lines --write-authority writes, sorted. */
  readonly lines: string[];
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * The lock's trigger lines for the App as its database holds the named triggers now, and what is wrong with them
 * against the lock it keeps (`locked`, undefined where it keeps none, which approves nothing). `triggersOf` is each resource's triggers by its logical name, undefined where they could
 * not be read (left to the write, which reads them again and fails closed).
 */
export function triggerLockFindings(
  app: Pick<AppDef, 'auth' | 'resources'>,
  triggersOf: (resource: string) => readonly ScopeTrigger[] | undefined,
  locked: ReadonlyMap<string, string> | undefined,
): TriggerLockFindings {
  const lines: string[] = [],
    problems: string[] = [],
    warnings: string[] = [];
  if (!namesTriggers(app)) return { lines, problems, warnings };
  for (const resource of Object.keys(app.resources ?? {}).sort()) {
    const named = app.resources![resource].triggers;
    if (!named?.length) continue;
    const triggers = triggersOf(resource);
    if (!triggers) continue;
    for (const name of named) {
      const at = `resources "${resource}" triggers "${name}"`;
      const trigger = triggers.find((each) => each.name === name);
      if (!trigger) {
        problems.push(
          `${at}: the database has no trigger by that name on "${resource}" [trigger-unknown]. ` +
            `Its triggers there: ${triggers.map((each) => `"${each.name}"`).join(', ') || 'none'}. A name is matched exactly, case included.`,
        );
        continue;
      }
      if (trigger.validates) {
        warnings.push(
          `${at}: it only checks NEW and OLD and raises, which runs under the row policy unnamed [trigger-unknown]: drop the name.`,
        );
        continue;
      }
      if (!trigger.effects || !trigger.digest) {
        problems.push(
          `${at}: ${trigger.why ? `${trigger.why}, ` : ''}outside the keyed-effect grammar [command-trigger], so naming it accepts nothing and a write that fires it is refused. ` +
            'An accepted trigger writes, inserts, deletes or reads one row of another table by a key equal to columns of NEW or OLD (docs: Row access).',
        );
        continue;
      }
      if (trigger.unaccepted) problems.push(`${at}: ${trigger.unaccepted} [command-trigger]: a write that fires it is refused.`);
      const key = `${resource}.${name}`;
      lines.push(`${TRIGGER_LINE_PREFIX}${key} on ${trigger.events.join(', ')} ${trigger.digest}`);
      for (const effect of trigger.effects) lines.push(`  ${sayEffect(effect)}`);
      const approved = locked?.get(key);
      if (approved !== trigger.digest)
        problems.push(
          `${at}: ${approved ? 'its definition changed since authority.lock approved it' : locked ? 'authority.lock has not approved it' : 'the App keeps no authority.lock, so nothing has approved it'} [trigger-lock]. ` +
            'Review what it does, then accept it with mistri check --write-authority; until then the server does not start, ' +
            'and a write that fires it is refused.',
        );
    }
  }
  return { lines, problems, warnings };
}

/** The server's start: the lock's refusal, or undefined when the App names no trigger or the lock approves every one it names. */
export function triggerLockProblem(
  app: Pick<AppDef, 'auth' | 'resources' | 'approvedTriggers'>,
  triggersOf: (resource: string) => readonly ScopeTrigger[] | undefined,
): string | undefined {
  const locked = app.approvedTriggers ? new Map(Object.entries(app.approvedTriggers)) : undefined;
  const stale = triggerLockFindings(app, triggersOf, locked).problems.filter((problem) => problem.includes('[trigger-lock]'));
  return stale.length ? `authority.lock: ${stale.join('\n    ')}` : undefined;
}

/**
 * The digest a scoped transaction pins for a named trigger (triggerProof.ts): the lock's, and one no definition has
 * where the lock never approved the trigger or the App keeps no lock, so a write that fires it is refused.
 */
export const pinnedDigest = (app: Pick<AppDef, 'approvedTriggers'>, resource: string, trigger: string): string =>
  app.approvedTriggers?.[`${resource}.${trigger}`] ?? 'sha256:unapproved';
