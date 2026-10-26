/**
 * What `check` says of an App's decisions, and what it writes: each one's
 * inputs read against the schema it is served (a column, a rollup or
 * computed name, a label path; never a hidden or redacted field), each table
 * those reads reach inside the answer command's footprint, and its contract
 * against decisions.lock.
 *
 * The lock is written as authority.lock is, with --write-authority; a
 * changed contract is a problem until --bump names the decision. A decision
 * the lock does not hold yet is a warning, not a problem: it runs, at
 * version 1, and only suggests until an evaluation pins a model for it.
 */
import { dirname } from 'node:path';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from '../../shared/app.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { answerSpec, decisionFootprintProblems, decisionReads } from './decisionChecks.js';
import { decisionLockLines, decisionLockPath, readDecisionLock, readDecisionLockFile, writeDecisionLock } from './decisionLock.js';
import { decisionContract, type CapturedDecision } from './decisionModule.js';

/** Each decision's contract digest, from its declaration and its answer command's field: what decisions.lock records. */
export function decisionDigests(decisions: Iterable<CapturedDecision>, commands: BusinessCommandRegistry): Map<string, string> {
  const digests = new Map<string, string>();
  for (const decision of decisions) {
    const id = decision.answer.command.id;
    const command = Object.hasOwn(commands, id) ? commands[id] : undefined;
    const spec = command ? answerSpec(command, decision.answer.field) : 'unregistered';
    digests.set(decision.name, decisionContract(decision, spec));
  }
  return digests;
}

/** The directory decisions.lock lives in: beside authority.lock, else the App's own. */
export const decisionLockDirectory = (loaded: { authority?: { lockPath: string }; dir?: string }): string | undefined =>
  loaded.authority ? dirname(loaded.authority.lockPath) : loaded.dir;

interface DecisionCheck {
  readonly problems: string[];
  readonly warnings: string[];
  readonly wrote?: string;
}

export async function checkDecisions(options: {
  decisions: ReadonlyMap<string, CapturedDecision>;
  app: AppDef;
  schema: DatabaseSchema | undefined;
  commands: BusinessCommandRegistry;
  directory: string | undefined;
  bump: ReadonlySet<string>;
  write: boolean;
}): Promise<DecisionCheck> {
  const { decisions, app, schema, commands, directory, bump, write } = options;
  const problems: string[] = [],
    warnings: string[] = [];
  if (!decisions.size) return { problems, warnings };
  if (schema)
    for (const decision of decisions.values()) {
      const read = decisionReads(decision, app, schema);
      problems.push(...read.problems);
      const id = decision.answer.command.id;
      if (read.reads && Object.hasOwn(commands, id)) problems.push(...decisionFootprintProblems(decision, read.reads, commands[id], app));
    }
  if (!directory) {
    warnings.push('the App has no directory to keep decisions.lock in: its decisions only suggest.');
    return { problems, warnings };
  }
  const path = decisionLockPath(directory);
  const before = readDecisionLockFile(path);
  const judged = decisionLockLines(decisionDigests(decisions.values(), commands), readDecisionLock(before), bump);
  problems.push(...judged.problems);
  /* A bump writes the lock as --write-authority does: it is the author accepting the change. */
  const wrote = (write || bump.size) && !judged.problems.length ? await writeDecisionLock(path, judged.entries, before) : undefined;
  if (!wrote && judged.unwritten.length)
    warnings.push(
      `decisions.lock does not hold ${judged.unwritten.map((name) => `"${name}"`).join(', ')}: ` +
        'run check --write-authority to record its contract; until an eval pins a model, it only suggests.',
    );
  return { problems, warnings, ...(wrote ? { wrote } : {}) };
}
