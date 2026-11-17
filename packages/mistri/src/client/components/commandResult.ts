/**
 * What a command handed back that a person has to take with them: a link it minted (`await link('invite')` in a
 * handler, which the command's own answer renders as a URL — links/linkToken.ts), a sign-up address, an export's
 * address. The platform only reads it as such where the answer is an address: a string, or a string at the top of a
 * result or one level inside it. Anything else stays the handler's own business (`useCommand`'s output).
 *
 * Every place a command ends draws it from here — the form's done state (CommandOutcome.tsx), and the notice of a
 * command run on one click (Actions.tsx, BoardList.tsx, sdk/commands.tsx) — so it is one shape and one Copy.
 */
import { toast } from '@mistriwork/kit/client/core.js';
import { say } from '../copy/forms/components/commandResult.js';

const ADDRESS = /^https?:\/\/\S+$/i;
const MOST = 3;

/** The addresses in a command's result, in the order it gave them, each once. */
export function resultLinks(output: unknown): string[] {
  const found: string[] = [];
  const take = (value: unknown) => {
    if (typeof value === 'string' && ADDRESS.test(value.trim()) && !found.includes(value.trim())) found.push(value.trim());
  };
  take(output);
  if (Array.isArray(output)) output.forEach(take);
  else if (output && typeof output === 'object') {
    for (const value of Object.values(output as Record<string, unknown>)) {
      take(value);
      if (Array.isArray(value)) value.forEach(take);
    }
  }
  return found.slice(0, MOST);
}

/** Put an address on the clipboard; a refusal (an insecure origin, a denied permission) is said, since the address is on screen. */
export function copyLink(url: string): Promise<boolean> {
  return (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error())).then(
    () => true,
    () => {
      toast(say('refused'), 'error');
      return false;
    },
  );
}

/** A command's notice when it is done: its words, and where its answer carries an address, the address with a Copy beside it. */
export function toastDone(message: string, output: unknown): void {
  const [url] = resultLinks(output);
  if (url === undefined) return toast(message, 'ok');
  toast(say('withLink', { message, url }), 'ok', {
    label: say('copy'),
    run: () => void copyLink(url),
  });
}
