/**
 * Which theme a page wears: one function, read by the server where it
 * projects an App for a principal (appViewRoles.ts) and guesses a first
 * paint's sheets (clientSurface.ts), and by the browser where it applies the
 * look (client visualTheme.ts), so the two never disagree about a page.
 *
 * The order (docs/theming.md, Precedence):
 *
 * 1. A public surface — a landing, the sign-in screen, a public form, or any
 *    page a signed-out visitor sees — wears `ui.theme.for.public` where the
 *    App names one, whatever a reader picked once: public pages are a
 *    storefront, the same for everyone, and so can be cached.
 * 2. Otherwise the reader's own pick, where the App offers a picker.
 * 3. Otherwise the first `for.roles` entry, in the order it is written, that
 *    the account holds: a portal's look is the App's design.
 * 4. Otherwise the tenant's saved theme: its staff's default.
 * 5. Otherwise the App's `ui.theme.preset`, and Workshop where it names none.
 *
 * Each id is taken only where the App offers it (a built-in look or one of
 * its own), so a theme removed since a pick was saved falls through to the
 * next rank instead of to nothing.
 */

/** `ui.theme.for`: a theme for signed-out visitors, and one per role. */
export interface ThemeAudiences {
  public?: string;
  roles?: Readonly<Record<string, string>>;
}

/** Where a page's theme came from. */
type ThemeSource = 'public' | 'reader' | 'role' | 'tenant' | 'app' | 'default';

export interface ThemeAsk {
  /** A public surface, or a visitor who is not signed in. */
  public?: boolean;
  /** The account's roles; none when signed out. */
  roles?: readonly string[];
  /** The reader's own pick. */
  pick?: string;
  for?: ThemeAudiences;
  /** The tenant's saved theme (tenant branding's `theme`). */
  tenant?: string;
  /** `ui.theme.preset`. */
  preset?: string;
  /** Whether the App offers a theme by this id: a built-in look, or one of `ui.customThemes`. */
  offered: (id: string) => boolean;
}

/** The look in force when the App says nothing and nobody picked. */
const DEFAULT_THEME = 'workshop';

/** The theme a page wears, where it came from and, for a role's, which role. */
export function resolveTheme(ask: ThemeAsk): { id: string; source: ThemeSource; role?: string } {
  const offered = (id: string | undefined): id is string => typeof id === 'string' && ask.offered(id);
  if (ask.public && offered(ask.for?.public)) return { id: ask.for!.public!, source: 'public' };
  if (offered(ask.pick)) return { id: ask.pick, source: 'reader' };
  if (!ask.public && ask.roles?.length)
    for (const [role, id] of Object.entries(ask.for?.roles ?? {}))
      if (ask.roles.includes(role) && offered(id)) return { id, source: 'role', role };
  if (offered(ask.tenant)) return { id: ask.tenant, source: 'tenant' };
  if (offered(ask.preset)) return { id: ask.preset, source: 'app' };
  return { id: DEFAULT_THEME, source: 'default' };
}

/** The role theme a principal holding `roles` wears, if `for.roles` maps one it holds: the first in written order. */
export function roleTheme(audiences: ThemeAudiences | undefined, roles: readonly string[]): string | undefined {
  for (const [role, id] of Object.entries(audiences?.roles ?? {})) if (roles.includes(role)) return id;
  return undefined;
}

/** Every theme a mapping can dress a page in: the public one, then each role's, once each. */
export function audienceThemes(audiences: ThemeAudiences | undefined): string[] {
  return [...new Set([...(audiences?.public ? [audiences.public] : []), ...Object.values(audiences?.roles ?? {})])];
}
