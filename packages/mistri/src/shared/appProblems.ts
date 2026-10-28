/**
 * Every refusal a load can name, in one throw.
 *
 * The parsers refuse by throwing, which once meant an author fixed one line,
 * reloaded, and met the next: a dashboard metric, then a page's tab, then a
 * resource's display rule — three runs for three typos. Each independent
 * part (a resource block, a view, a page) is now parsed on its own, and what
 * each refuses is gathered here. A part that depends on one that failed is
 * not judged, since its refusal would only restate the first.
 *
 * The message is the problems one to a line, so a reader that knows only
 * `Error` still says all of them; `problems` is the list for the ones that
 * print them their own way.
 */
import { faultFrames } from '@mistriwork/engine/shared/refusal.js';

export class AppProblems extends Error {
  readonly problems: string[];
  constructor(
    problems: string[],
    readonly partial?: unknown,
  ) {
    const once = [...new Set(problems)];
    super(once.join('\n'));
    this.problems = once;
    this.name = 'AppProblems';
  }
}

/** The problems an error carries: its list, or its one message. */
export function problemsOf(err: unknown): string[] {
  if (err instanceof AppProblems) return err.problems;
  const message = (err as Error)?.message ?? String(err);
  /* A TypeError gathered here is a fault in the code that read the App, and its sentence alone ("Cannot read
     properties of undefined (reading 'realm')") names nothing to fix; its stack was lost with it (a field report).
     The frame it happened at rides with it, so `mistri check` says where. */
  const [frame] = faultFrames(err);
  return [frame ? `${message} (an internal error, ${frame})` : message];
}

/** Run one independent part, gathering what it refuses instead of stopping at it. */
export function gather<T>(into: string[], parse: () => T): T | undefined {
  try {
    return parse();
  } catch (err) {
    into.push(...problemsOf(err));
    return undefined;
  }
}

/** Like gather, but says whether the part parsed — for a part whose answer may itself be undefined. */
export function attempt<T>(into: string[], parse: () => T): { value: T } | undefined {
  try {
    return { value: parse() };
  } catch (err) {
    into.push(...problemsOf(err));
    return undefined;
  }
}
