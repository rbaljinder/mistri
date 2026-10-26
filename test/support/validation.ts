import { CHECK_VALIDATION } from '../../packages/engine/src/server/cli/args.js';

/**
 * Stands in an argument list where a test wants the raw validation a `mistri check`
 * child reports (the child is told by an environment variable, not a flag: the one
 * spelling a person types is `mistri check`). A CLI helper passes its arguments and
 * environment through `validating`, which drops the marker and sets the variable.
 */
export const VALIDATE = '<validation>';

export function validating(args: readonly string[], env: NodeJS.ProcessEnv = process.env): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!args.includes(VALIDATE)) return { args: [...args], env };
  return { args: args.filter((a) => a !== VALIDATE), env: { ...env, [CHECK_VALIDATION]: '1' } };
}
