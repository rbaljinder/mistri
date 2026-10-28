/**
 * What the terminal says when a row-policy App does not start. The policy
 * module's own refusal is a policy startup error; anything else is the App's
 * (AppUnderPolicyStartupError), and is said as every App error is: `App
 * error:` and its cause, placed at the file and line that wrote it as the
 * dev server places a save that did not load (appLive.ts). Framed as a policy
 * error with no place, the cause sent its author to a policy module that was
 * fine (field report S1).
 */
import { dirname } from 'node:path';
import type { LoadedApp } from '../app/apps.js';
import { placeLoadFailure, sayPlace } from '../app/appLive.js';
import { AppUnderPolicyStartupError } from '../policy/appRowPolicy.js';
import { refusalCause, refusalHeadline, refusalReasons, refusalReasonsBelow } from '@mistriwork/engine/server/evidence.js';
import { faultFrames } from '@mistriwork/engine/shared/refusal.js';

export async function policyStartupLines(error: unknown, loaded: LoadedApp | undefined): Promise<string[]> {
  const [cause, ...below] = refusalReasons(error);
  /* A fault in the code that read the App (a TypeError) is placed by its own stack: its sentence names nothing the
     author wrote to search for, and said alone it was a dead end (a field report). */
  const frames = faultFrames(error).map((frame) => `  ${frame}`);
  if (!(error instanceof AppUnderPolicyStartupError) || !cause)
    return [
      `Policy startup error: ${refusalHeadline(error)}`,
      ...refusalReasonsBelow(error).map((because) => `  because: ${because}`),
      ...frames,
    ];
  /* The catalog says the App's name first ("Spoke: resources …"); the place is found from the definition path after it. */
  const named = loaded && cause.startsWith(`${loaded.app.name}: `) ? cause.slice(loaded.app.name.length + 2) : cause;
  const place = loaded
    ? await placeLoadFailure(named, loaded.dir ?? dirname(loaded.path), refusalCause(error)).catch(() => undefined)
    : undefined;
  return [`App error: ${cause}`, ...(place?.file ? sayPlace(place) : []), ...below.map((because) => `  because: ${because}`), ...frames];
}
