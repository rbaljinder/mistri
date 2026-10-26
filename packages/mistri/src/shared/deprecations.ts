/**
 * App DSL spellings that still work and are on their way out
 * (docs/compatibility.md, "Deprecation"). From 1.0 a public key is never
 * removed in a minor release: it is listed here first, `mistri check` and
 * startup print one `[deprecated]` warning for each place an App writes it,
 * naming what to say instead, and it goes no sooner than the next major.
 *
 * Before 1.0 nothing was promised, so a spelling renamed then is refused
 * outright where it is met (pageConfig.ts and recordview.ts `RENAMED`, which
 * say the new word). Those refusals stay: an App written against 0.x has one
 * spelling to move to, and a refusal says it at once.
 *
 * A `key` is written as test/fixtures/public-surface.json names it, so the
 * guard can hold the two together: a deprecated key is still a public name
 * (it works), and the inventory keeps it until the major that removes it.
 * The walk reads the raw App, before features merge, so a key a feature slice
 * writes is found under `features[]` as well.
 */
export interface Deprecation {
  /** The inventory's name for the key: `app: views.*[kind=list].oldKey`, or for one value of it
   * `app: resources.*.display.*.format = "old"`. `*` is any key, `[]` any item, `[kind=x]` a branch. */
  key: string;
  /** The minor release that deprecated it: `'1.3'`. */
  since: string;
  /** What to write instead, as a sentence an author can act on. */
  instead: string;
}

/** Empty: nothing is deprecated yet. An entry is added in the minor release that deprecates a key. */
export const DEPRECATIONS: readonly Deprecation[] = [];

type Step = { key: string } | { any: true } | { item: true } | { branch: string; value: string };

function steps(path: string): Step[] {
  const out: Step[] = [];
  for (const match of path.matchAll(/\.?([A-Za-z_$][\w$]*|\*)|\[\]|\[([a-z]+)=([^\]]+)\]/g)) {
    if (match[0] === '[]') out.push({ item: true });
    else if (match[2]) out.push({ branch: match[2], value: match[3] });
    else if (match[1] === '*') out.push({ any: true });
    else out.push({ key: match[1] });
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every concrete path in `root` that `path` names and that is written (not undefined), or written as `value`. */
function written(root: unknown, path: Step[], value: unknown, at = ''): string[] {
  if (!path.length) return root === undefined || (value !== undefined && root !== value) ? [] : [at];
  const [step, ...rest] = path;
  if ('branch' in step) return isRecord(root) && root[step.branch] === step.value ? written(root, rest, value, at) : [];
  if ('item' in step) return Array.isArray(root) ? root.flatMap((item, i) => written(item, rest, value, `${at}[${i}]`)) : [];
  if (!isRecord(root)) return [];
  const join = (key: string) => (at ? `${at}.${key}` : key);
  if ('any' in step) return Object.entries(root).flatMap(([key, entry]) => written(entry, rest, value, join(key)));
  return Object.hasOwn(root, step.key) ? written(root[step.key], rest, value, join(step.key)) : [];
}

const major = (since: string) => Number(since.split('.')[0]) + 1;

/** One `[deprecated]` warning per place the raw App writes a deprecated key. */
export function deprecatedKeys(raw: unknown, deprecations: readonly Deprecation[] = DEPRECATIONS): string[] {
  const found: string[] = [];
  for (const { key, since, instead } of deprecations) {
    const [name, said] = key.split(' = ');
    const path = name.replace(/^app: /, '');
    if (path === name) continue; // a page file's or a theme's own key: matched where those are parsed, once one is deprecated
    const value = said === undefined ? undefined : JSON.parse(said);
    for (const where of [...written(raw, steps(path), value), ...written(raw, steps(`features[].${path}`), value)])
      found.push(`"${where}" [deprecated]: deprecated since ${since}, and removed in ${major(since)}.0. ${instead}`);
  }
  return found;
}

/* Found where the raw App is still in hand (parseAppConfig), read where advisories are printed (apps.ts appAdvisories). */
const noted = new WeakMap<object, readonly string[]>();
export const noteDeprecated = (app: object, raw: unknown): void => {
  const found = deprecatedKeys(raw);
  if (found.length) noted.set(app, found);
};
export const deprecatedOf = (app: object): readonly string[] => noted.get(app) ?? [];
