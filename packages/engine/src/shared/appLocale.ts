/**
 * The reader's locale, one resolution for the whole server (`resolveLocale`):
 * the words an App's captions are said in and the figures Intl writes. Apart
 * from appUi.ts for the reason appZone.ts is: what a command host or the
 * notify path needs must not load every look and theme module into `--mcp`
 * (test/cli-startup.test.ts). The engine's: the client's language picker
 * keeps its choice in the cookie named here, in the database browser as in
 * an App.
 */
const canonicalTags = new Map<string, string | undefined>();
/** A language tag as Intl writes it (`es-mx` → `es-MX`); undefined for anything Intl does not take as one. */
export function canonicalLocale(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 35) return undefined;
  /* Asked on every payload of the same few tags; bounded, as a tag can be a person's own. */
  if (canonicalTags.has(value)) return canonicalTags.get(value);
  if (canonicalTags.size >= 64) canonicalTags.clear();
  let tag: string | undefined;
  try {
    [tag] = Intl.getCanonicalLocales(value.trim());
  } catch {
    tag = undefined;
  }
  canonicalTags.set(value, tag);
  return tag;
}

/** The resource and column `ui.locale: { column }` names, where it names one. */
export function localeColumn(ui: { localeColumn?: string } | undefined): { resource: string; column: string } | undefined {
  if (!ui?.localeColumn) return undefined;
  const [resource, column] = ui.localeColumn.split('.') as [string, string];
  return { resource, column };
}

/**
 * The cookie a reader's own pick of an App's language is kept in (the
 * language picker, client messages.ts), read as their preference where the
 * App names no column of their row to keep it in (server readerLocale.ts).
 * One per App, so two Apps on one server keep two choices.
 */
export const localeCookieName = (appId: string): string => `mistri-locale-${encodeURIComponent(appId)}`;

/**
 * The tag an `Accept-Language` header asks for among `available` (the locales
 * an App has a catalog for), by BCP 47 lookup: each range in the header's
 * order of preference, `es-MX` then `es`; undefined where none is offered.
 */
export function negotiateLocale(header: string | undefined, available: readonly string[]): string | undefined {
  if (!header || !available.length) return undefined;
  const offered = new Map(available.map((tag) => [tag.toLowerCase(), tag]));
  const ranges = header
    .split(',')
    .slice(0, 16)
    .map((part, index) => {
      const [range, ...params] = part.trim().split(';');
      const q = params.map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param)?.[1]).find(Boolean);
      return { range: range!.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter(({ range, q }) => range && range !== '*' && q > 0 && Number.isFinite(q))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { range } of ranges) {
    const tag = canonicalLocale(range);
    if (!tag) continue;
    /* The tag the header names is kept where its words are offered, so `es-MX` writes Mexico's figures in Spanish words. */
    const parts = tag.split('-');
    for (let n = parts.length; n > 0; n--) {
      const hit = offered.get(parts.slice(0, n).join('-').toLowerCase());
      if (hit) return n === parts.length ? hit : tag;
    }
  }
  return undefined;
}

/**
 * The one resolution, nearest first: the person's own (`ui.locale: { column }`,
 * read under their grants, else what they picked in this browser), the tenant's (`branding.allow: 'locale'`), then —
 * for nobody known, on a public page or the sign-in screen — what the browser
 * asks for among the App's catalogs, then the App's own (`ui.locale`). Undefined
 * where nothing names one: the reader's browser then decides the figures.
 */
export function resolveLocale(sources: {
  person?: string | undefined;
  tenant?: string | undefined;
  /** The `Accept-Language` negotiation, asked only for a reader nobody knows. */
  browser?: string | undefined;
  app?: string | undefined;
}): string | undefined {
  return (
    canonicalLocale(sources.person) ?? canonicalLocale(sources.tenant) ?? canonicalLocale(sources.browser) ?? canonicalLocale(sources.app)
  );
}
