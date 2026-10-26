/**
 * Provenance: a refusal or a problem about something a feature wrote names
 * that feature. The parsers and resolvers speak in the flattened App's
 * locations (`views "new-leads"`, `nav entry 3 (lending): nav entry 2`,
 * `"home", rule 4`, `resources "lead", action 2`), and composeFeatures kept
 * who wrote each. This moves the location at the head of a message to its
 * contributor, numbered as that contributor wrote it: `features "leads",
 * views "new-leads"`, `features "leads", nav entry 1`, `features "leads",
 * "home", rule 1`, `features "leads", resources "lead", action 1`.
 *
 * Only the head moves, and only for what a feature wrote. The parsers are
 * untouched, so every rule keeps one voice, and a message about the App's
 * own words — or any message of a flat App — reads exactly as it did.
 */
import { THE_APP, type AppOrigins, type ResourceOrigins } from './appFeatures.js';
import { AppProblems } from './appProblems.js';

/** Run a parse over a composed root; a refusal about what a feature wrote is re-addressed to it. */
export function withProvenance<T>(origins: AppOrigins | undefined, where: string, parse: () => T): T {
  if (!origins?.features.length) return parse();
  try {
    return parse();
  } catch (err) {
    const head = `${where}: `;
    if (err instanceof AppProblems) {
      const located = err.problems.map((problem) =>
        problem.startsWith(head) ? `${head}${locate(origins, problem.slice(head.length)) ?? problem.slice(head.length)}` : problem,
      );
      throw new AppProblems(located, err.partial);
    }
    if (err instanceof Error && err.message.startsWith(head)) {
      const moved = locate(origins, err.message.slice(head.length));
      if (moved !== undefined) err.message = `${head}${moved}`;
    }
    throw err;
  }
}

/** A resolve-time problem as the resolvers phrase it (`view "x": …`, `resources "r": …`, `display "r.c": …`), re-addressed the same way. */
export function locateProblem(origins: AppOrigins | undefined, problem: string): string {
  return origins?.features.length ? (locate(origins, problem) ?? problem) : problem;
}

/** The message re-addressed to the feature that wrote what it names, or undefined when the App wrote it. */
function locate(origins: AppOrigins, text: string): string | undefined {
  const to = (by: string | undefined, rest: string) => (by !== undefined && by !== THE_APP ? `${by}, ${rest}` : undefined);
  const feature = (id: string | undefined) => (id === undefined ? undefined : `features "${id}"`);
  let m: RegExpExecArray | null;
  if ((m = /^views? "([^"]+)"/.exec(text))) return to(feature(origins.views[m[1]]), text);
  if ((m = /^pages "([^"]+)"/.exec(text))) return to(feature(origins.pages[m[1]]), text);
  if ((m = /^"home", rule (\d+)/.exec(text))) {
    const rule = origins.home?.[Number(m[1]) - 1];
    return rule && to(rule.by, `"home", rule ${rule.n}${text.slice(m[0].length)}`);
  }
  if ((m = /^nav entry \d+(?: \([^)]*\): nav entry \d+)*/.exec(text))) {
    /* The parser's path through the spliced tree; the fragment entry it
       passes through, renumbered as the fragment has it, and the rest of
       the path inside it unchanged. */
    const steps = [...m[0].matchAll(/nav entry (\d+)(?: \(([^)]*)\))?/g)].map((step) => ({ n: Number(step[1]), group: step[2] }));
    const origin = origins.nav.find((entry) => entry.path.length <= steps.length && entry.path.every((n, i) => n === steps[i].n));
    if (!origin) return undefined;
    const own = steps.slice(origin.path.length - 1);
    const at = own.map((step, i) => `nav entry ${i ? step.n : origin.n}${i < own.length - 1 ? ` (${step.group}): ` : ''}`).join('');
    return to(origin.by, `${at}${text.slice(m[0].length)}`);
  }
  if ((m = /^resources "([^"]+)"/.exec(text))) return resourceFact(origins.resources[m[1]], m[1], text.slice(m[0].length), text, to);
  if ((m = /^display "([^"]+)\.([^".]+)"/.exec(text))) return to(origins.resources[m[1]]?.display[m[2]], text);
  if ((m = /^"auth", role "([^"]+)", "(read|write|fields)" names "([^"]+)"/.exec(text))) {
    const who = origins.authority[`roles.${m[1]}.${m[2]}.${m[3]}`];
    return to(who && !who.includes(THE_APP) ? who[0] : undefined, text);
  }
  return undefined;
}

/** A message about one merged resource block, by the fact it names; a block one feature wrote alone is that feature's. */
function resourceFact(
  origin: ResourceOrigins | undefined,
  _name: string,
  rest: string,
  text: string,
  to: (by: string | undefined, rest: string) => string | undefined,
): string | undefined {
  if (!origin) return undefined;
  let f: RegExpExecArray | null;
  if ((f = /^, display "([^"]+)"/.exec(rest))) return to(origin.display[f[1]], text);
  if ((f = /^, "labels" gives "([^"]+)"/.exec(rest))) return to(origin.labels[f[1]], text);
  if ((f = /^, action "([^"]+)"/.exec(rest))) return to(Object.hasOwn(origin.actions, f[1]) ? origin.actions[f[1]] : undefined, text);
  if (rest.startsWith(', validation')) return to(new Set(origin.validation).size === 1 ? origin.validation[0] : undefined, text);
  if (rest.startsWith(': recordLabel ')) return to(origin.recordLabel, text);
  if (/^(, "form"|: )/.test(rest)) return to(origin.form, text);
  if (/^(, "page"| has a "page")/.test(rest)) return to(origin.page, text);
  return to(origin.by.length === 1 ? origin.by[0] : undefined, text);
}
