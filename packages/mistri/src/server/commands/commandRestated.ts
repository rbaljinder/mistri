/* The `restated` warnings of an App's commands: what a command says that the platform already says for it, so the author can delete it. */
import { fieldLabel } from '../../shared/command.js';
import { commandRestatements, type BusinessCommandRegistry } from './businessCommands.js';

/** An input field's key, and every field a group holds, as the command wrote them. */
function* fieldsOf(input: unknown, within = ''): Generator<{ path: string; field: Record<string, unknown> }> {
  if (!input || typeof input !== 'object') return;
  for (const [key, field] of Object.entries(input as Record<string, unknown>)) {
    if (!field || typeof field !== 'object') continue;
    const here = within ? `${within}.${key}` : key;
    yield { path: here, field: field as Record<string, unknown> };
    if ((field as { type?: unknown }).type === 'group') yield* fieldsOf((field as { fields?: unknown }).fields, here);
  }
}

/**
 * What a command's definition says that the platform says without it: a field
 * `label` that is its key made words, `targets: 'none'` beside `public: true`,
 * a handler that parses its own output. Words, never a refusal; each names
 * the deletion. Read by `check`, beside the other advice.
 */
export function commandRestatedWarnings(commands: BusinessCommandRegistry | undefined): string[] {
  if (!commands) return [];
  const warnings: string[] = [];
  for (const [id, command] of Object.entries(commands)) {
    for (const note of commandRestatements(command)) warnings.push(`command "${id}" [restated]: ${note}`);
    for (const { path, field } of fieldsOf(command.input)) {
      const key = path.slice(path.lastIndexOf('.') + 1);
      if (typeof field.label === 'string' && field.label === fieldLabel(key)) {
        warnings.push(`command "${id}" [restated]: input "${path}" says label "${field.label}", which is its key made words. Delete it.`);
      }
    }
  }
  return warnings;
}
