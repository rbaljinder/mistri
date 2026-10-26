/**
 * decisions.lock, beside authority.lock in the App's directory: each
 * decision's contract, and the models trusted to apply its answers.
 *
 *   decision triageCategory v1 5f0c3a91d2e4
 *   pin triageCategory v1 anthropic claude-sonnet-5-5 error 0.012 n 500 at 2026-10-23
 *
 * A contract is what a decision asks, from which fields, of what type and of
 * whom (decisionModule.ts `decisionContract`). Its version is the one each
 * decision row records, so the rows of one question are never read as the
 * rows of another. A change at the same version is a problem `check` names
 * until `check --bump <decision>` raises it, which also drops its pins: an
 * evaluation of one question says nothing of another.
 *
 * A pin is written by `mistri decide eval --pin` only, when the answers it
 * would have applied were wrong no more often than `maxError` allows. It
 * names the provider and the model version the provider reported. Applying
 * needs one: an answer from any other provider or version, or from a
 * contract the pin was not made for, only suggests (design §5, "model
 * drift"). The lock is read when the server starts; a new pin takes a
 * restart.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderName } from './providers/decisionProvider.js';

const DECISIONS_LOCK = 'decisions.lock';

const HEAD = /^decision ([A-Za-z][A-Za-z0-9_]{0,55}) v([1-9][0-9]{0,8}) ([0-9a-f]{12})$/;
const PIN =
  /^pin ([A-Za-z][A-Za-z0-9_]{0,55}) v([1-9][0-9]{0,8}) (jev|anthropic) (\S{1,128}) error ([0-9]+(?:\.[0-9]+)?) n ([0-9]{1,9}) at ([0-9]{4}-[0-9]{2}-[0-9]{2})$/;

interface DecisionPin {
  readonly version: number;
  readonly provider: ProviderName;
  readonly modelVersion: string;
  readonly error: number;
  readonly n: number;
  readonly at: string;
}
export interface LockedDecision {
  readonly version: number;
  readonly digest: string;
  readonly pins: readonly DecisionPin[];
}

/** The lock's decisions, by name. Lines it does not know are kept by whoever writes it, and read as nothing. */
export function readDecisionLock(text: string | undefined): Map<string, LockedDecision> {
  const found = new Map<string, { version: number; digest: string; pins: DecisionPin[] }>();
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const head = HEAD.exec(line);
    if (head) {
      found.set(head[1], { version: Number(head[2]), digest: head[3], pins: found.get(head[1])?.pins ?? [] });
      continue;
    }
    const pin = PIN.exec(line);
    if (!pin) continue;
    const entry = found.get(pin[1]) ?? { version: Number(pin[2]), digest: '', pins: [] };
    entry.pins.push({
      version: Number(pin[2]),
      provider: pin[3] as ProviderName,
      modelVersion: pin[4],
      error: Number(pin[5]),
      n: Number(pin[6]),
      at: pin[7],
    });
    found.set(pin[1], entry);
  }
  return found;
}

/** The lock beside an App's authority.lock, or beside its directory's app.ts; undefined when there is none yet. */
export function decisionLockPath(appDirectory: string): string {
  return join(appDirectory, DECISIONS_LOCK);
}
export function readDecisionLockFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** What the server trusts of one decision: its contract version, and whether this provider and version may apply. */
interface DecisionTrust {
  readonly contractVersion: number;
  /** The lock's digest is the declaration's: the contract was not changed under its version. */
  readonly current: boolean;
  readonly pinned: (provider: ProviderName, modelVersion: string) => boolean;
}
export function decisionTrust(lock: ReadonlyMap<string, LockedDecision>, name: string, digest: string): DecisionTrust {
  const locked = lock.get(name);
  if (!locked) return { contractVersion: 1, current: false, pinned: () => false };
  const current = locked.digest === digest;
  return {
    contractVersion: locked.version,
    current,
    pinned: (provider, modelVersion) =>
      current &&
      locked.pins.some((pin) => pin.version === locked.version && pin.provider === provider && pin.modelVersion === modelVersion),
  };
}

const headLine = (name: string, version: number, digest: string) => `decision ${name} v${version} ${digest}`;
const pinLine = (name: string, pin: DecisionPin) =>
  `pin ${name} v${pin.version} ${pin.provider} ${pin.modelVersion} error ${pin.error} n ${pin.n} at ${pin.at}`;

const HEADER = [
  '# decisions.lock: each decision contract, and the models pinned to apply its answers.',
  '# Contracts are written by `mistri check --write-authority` (a change needs `--bump <decision>`);',
  '# pins only by `mistri decide eval --pin`. Commit it beside authority.lock.',
];

/** The lock's text from its entries, sorted, so a rewrite that changes nothing changes no byte. */
export function decisionLockText(entries: ReadonlyMap<string, LockedDecision>): string {
  const lines = [...HEADER];
  for (const name of [...entries.keys()].sort()) {
    const entry = entries.get(name)!;
    lines.push(headLine(name, entry.version, entry.digest));
    for (const pin of entry.pins) lines.push(pinLine(name, pin));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The lock as `check` judges and writes it. A new decision is written at v1
 * (with `write`); a changed one is a problem unless `bump` names it, which
 * writes it at the next version without its pins; a decision no longer
 * declared keeps its lines, so its rows still say what they were.
 */
export function decisionLockLines(
  declared: ReadonlyMap<string, string>,
  lock: ReadonlyMap<string, LockedDecision>,
  bump: ReadonlySet<string>,
): { entries: Map<string, LockedDecision>; problems: string[]; unwritten: string[] } {
  const entries = new Map(lock);
  const problems: string[] = [],
    unwritten: string[] = [];
  for (const [name, digest] of declared) {
    const before = lock.get(name);
    if (!before) {
      entries.set(name, { version: 1, digest, pins: [] });
      unwritten.push(name);
      continue;
    }
    if (before.digest === digest) continue;
    if (bump.has(name)) {
      entries.set(name, { version: before.version + 1, digest, pins: [] });
      continue;
    }
    problems.push(
      `decision "${name}" changed its contract (its question, inputs, answer type or providers) under v${before.version} in decisions.lock: ` +
        `bump it with check --bump ${name}, which moves it to v${before.version + 1} and drops its pins; until then it only suggests.`,
    );
  }
  return { entries, problems, unwritten };
}

/** Write the lock when its text changes; the path written, or nothing. */
export async function writeDecisionLock(path: string, entries: ReadonlyMap<string, LockedDecision>, before: string | undefined) {
  const text = decisionLockText(entries);
  if (text === before) return undefined;
  await writeFile(path, text);
  return path;
}

/** The lock with a pin added for a decision at its version, replacing one for the same provider and model version. */
export function withPin(lock: ReadonlyMap<string, LockedDecision>, name: string, digest: string, pin: Omit<DecisionPin, 'version'>) {
  const entries = new Map(lock);
  const before = lock.get(name) ?? { version: 1, digest, pins: [] };
  const version = before.version;
  entries.set(name, {
    version,
    digest: before.digest || digest,
    pins: [
      ...before.pins.filter(
        (each) => !(each.version === version && each.provider === pin.provider && each.modelVersion === pin.modelVersion),
      ),
      { ...pin, version },
    ],
  });
  return entries;
}
