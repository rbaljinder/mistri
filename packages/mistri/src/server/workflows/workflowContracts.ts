/**
 * A workflow's lines in authority.lock, and what a change to it means.
 *
 *   workflow creditDecision v1 5f0c3a91d2e4
 *   workflow creditDecision v1 step call credit-provider request-check
 *   workflow creditDecision v1 step waitFor creditReported@1 credit-result
 *
 * The version is the author's: it is what an instance is pinned to when it
 * starts, and what `w.version` shows. Instances already running follow the
 * code that is deployed, so a change they cannot follow, a step removed or
 * renamed, or a step that now runs another command, must come with a new
 * version, where the code can branch on `w.version`. At the same version it is
 * a problem `check` names step by step, and the lock keeps the old lines
 * rather than accepting it. A step that is added is not breaking: the lines
 * are simply written again.
 *
 * Like a command's contract lines, these are the lock's record and never its
 * authority: the server does not refuse to start over them (authorityDiff skips
 * them), and mistri check judges them here.
 */
import { createHash } from 'node:crypto';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import type { ProbedStep, WorkflowShape } from './workflowProbe.js';

/** A lock line's word, as `contract ` is the commands'. */
export const WORKFLOW_LINE_PREFIX = 'workflow ';
const HEAD = /^workflow ([A-Za-z][A-Za-z0-9_-]*) v([1-9][0-9]{0,8}) ([0-9a-f]{12})$/;
const STEP = /^workflow ([A-Za-z][A-Za-z0-9_-]*) v([1-9][0-9]{0,8}) step (run|call|sleep|until|waitFor|now) (\S+) (.+)$/;

interface LockedWorkflow {
  version: number;
  digest: string;
  steps: ProbedStep[];
}

export function lockedWorkflows(lock: string | undefined): Map<string, LockedWorkflow> {
  const found = new Map<string, LockedWorkflow>();
  for (const raw of (lock ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const head = HEAD.exec(line);
    if (head) {
      found.set(head[1], { version: Number(head[2]), digest: head[3], steps: found.get(head[1])?.steps ?? [] });
      continue;
    }
    const step = STEP.exec(line);
    if (!step) continue;
    const entry = found.get(step[1]) ?? { version: Number(step[2]), digest: '', steps: [] };
    entry.steps.push({ name: step[5], kind: step[3] as ProbedStep['kind'], ...(step[4] === '-' ? {} : { target: step[4] }) });
    found.set(step[1], entry);
  }
  return found;
}

const digestOf = (shape: WorkflowShape): string =>
  createHash('sha256')
    .update(
      canonicalCommandJson(
        {
          start: shape.workflow.start,
          listens: shape.workflow.listens,
          // A step's identity, not its `timeout`: a timeout computed per instance does not move the lock.
          steps: shape.steps.map(({ name, kind, target }) => (target === undefined ? { name, kind } : { name, kind, target })),
        },
        1 << 20,
      ),
    )
    .digest('hex')
    .slice(0, 12);
const linesOf = (shape: WorkflowShape, version: number, digest: string): string[] => [
  `${WORKFLOW_LINE_PREFIX}${shape.workflow.name} v${version} ${digest}`,
  ...shape.steps.map(
    (step) => `${WORKFLOW_LINE_PREFIX}${shape.workflow.name} v${version} step ${step.kind} ${step.target ?? '-'} ${step.name}`,
  ),
];

/** The lock's workflow lines for these workflows, and the problems a breaking change makes. */
export function workflowLines(shapes: readonly WorkflowShape[], lock: string | undefined): { lines: string[]; problems: string[] } {
  const locked = lockedWorkflows(lock);
  const lines: string[] = [],
    problems: string[] = [];
  for (const shape of [...shapes].sort((a, b) => (a.workflow.name < b.workflow.name ? -1 : 1))) {
    const { name, version } = shape.workflow;
    const digest = digestOf(shape),
      before = locked.get(name);
    const keep = () => {
      lines.push(...linesOf({ ...shape, steps: before!.steps }, before!.version, before!.digest));
    };
    if (!before || before.version < version) {
      lines.push(...linesOf(shape, version, digest));
      continue;
    }
    if (before.version > version) {
      problems.push(
        `workflow "${name}" declares version ${version}, below the ${before.version} authority.lock records: a version only goes up.`,
      );
      keep();
      continue;
    }
    const now = new Map(shape.steps.map((step) => [step.name, step]));
    const broken: string[] = [];
    // A probe that saw nothing (code that throws on a permissive value) judges nothing.
    if (shape.steps.length) {
      for (const old of before.steps) {
        const current = now.get(old.name);
        if (!current) broken.push(`step "${old.name}" was removed or renamed`);
        else if (current.kind !== old.kind || current.target !== old.target) {
          broken.push(
            `step "${old.name}" ${old.kind}${old.target ? ` of ${old.target}` : ''} is now a ${current.kind}${current.target ? ` of ${current.target}` : ''}`,
          );
        }
      }
    }
    if (broken.length) {
      problems.push(
        `workflow "${name}" v${version} changed in a way instances already running cannot follow: ${broken.join('; ')}. ` +
          `Raise its version in defineWorkflow (version: ${version + 1}), and branch on w.version where the old steps must still run.`,
      );
      keep();
    } else lines.push(...linesOf(shape, version, digest));
  }
  return { lines, problems };
}
