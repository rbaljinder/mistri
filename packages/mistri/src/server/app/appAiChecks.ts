/**
 * What `mistri check` advises about an App's AI, from what the App declares (the component and page sources are
 * read in componentLint.ts, which says the same word-AI rule for markup).
 *
 * `aiTextWarnings`: a label or title in the declarations (a command's, an action's, a view's, a menu entry's) that
 * says the word AI as a whole word, case-sensitive. The word is the App's to say once, through `ai.label`, so the
 * App's own `ai` and `assistant` settings are not read.
 *
 * `aiApprovalWarnings`: a command an AI makes calls that is not `approval: 'ai'`. Only what the declarations show is
 * known: the commands the assistant may run (its `run` tool, an action's command that its `exclude` leaves in), and
 * the answer command of a decision that only suggests (no `apply`). A job's own command, an endpoint's or a
 * workflow's is no AI's by its declaration, and a decision that applies is the author's choice, so none is advised.
 */
import type { AppDef } from '../../shared/app.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { CapturedDecision } from '../decide/decisionModule.js';

const AI_WORD = /\bAI\b/;
/* The keys a person reads as words; a `name`, `id` or `description` is not a label. */
const TEXT_KEYS = new Set(['label', 'title', 'submit', 'button', 'heading']);
/* The App's own say about AI: its word, and its assistant's instructions. */
const SKIP_KEYS = new Set(['ai', 'assistant']);

function textFindings(node: unknown, path: string, seen: WeakSet<object>, out: string[]): void {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((each, i) => textFindings(each, `${path}[${i}]`, seen, out));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key) && path === '') continue;
    const at = path ? `${path}.${key}` : key;
    if (typeof value === 'string') {
      if (TEXT_KEYS.has(key) && AI_WORD.test(value))
        out.push(
          `${at} says "${value.slice(0, 60)}" [ai-text-bare]: the word AI is the App's to say once; ` +
            `set ai: { label } and draw <AiMark/> where a page says it, rather than spelling AI in a label`,
        );
    } else textFindings(value, at, seen, out);
  }
}

/** Labels and titles in the declarations, and in the commands, that say AI as a word. */
export function aiTextWarnings(app: AppDef, commands: BusinessCommandRegistry | undefined): string[] {
  const out: string[] = [];
  textFindings(app, '', new WeakSet(), out);
  for (const [id, command] of Object.entries(commands ?? {}))
    if (typeof command.label === 'string' && AI_WORD.test(command.label))
      out.push(
        `command "${id}" is labeled "${command.label.slice(0, 60)}" [ai-text-bare]: the word AI is the App's to say once; ` +
          `set ai: { label } and draw <AiMark/> where a page says it, rather than spelling AI in a label`,
      );
  return out;
}

const commandId = (command: unknown): string | undefined =>
  typeof command === 'string' ? command : command && typeof command === 'object' ? (command as { id?: string }).id : undefined;

/** Commands an AI makes calls to, without `approval: 'ai'`: the call runs at once where a person would approve it. */
export function aiApprovalWarnings(
  app: AppDef,
  commands: BusinessCommandRegistry | undefined,
  decisions: ReadonlyMap<string, CapturedDecision> | undefined,
): string[] {
  if (!commands) return [];
  const makers = new Map<string, string>();
  const assistant = app.assistant;
  if (assistant?.tools.includes('run')) {
    const excluded = new Set(assistant.exclude);
    for (const [name, resource] of Object.entries(app.resources ?? {}))
      for (const action of resource.actions ?? []) {
        const id = commandId((action as { command?: unknown }).command);
        if (id !== undefined && !excluded.has(`${name}.${action.id}`) && !makers.has(id))
          makers.set(id, `the assistant can run it from ${name}.${action.id}`);
      }
  }
  for (const decision of decisions?.values() ?? []) {
    const id = decision.answer.command.id;
    if (decision.apply === undefined && !makers.has(id)) makers.set(id, `the decision "${decision.name}" only suggests through it`);
  }
  const out: string[] = [];
  for (const [id, why] of makers) {
    if (!Object.hasOwn(commands, id) || commands[id]!.approval === 'ai') continue;
    out.push(
      `command "${id}" is made by AI (${why}) and is not approval: 'ai' [ai-command-unreviewed]: ` +
        `a call no person made is not held for approval; add approval: 'ai' so every such call (a job's, a decision's, a flow's) ` +
        `becomes a proposal a person approves in For review`,
    );
  }
  return out;
}
