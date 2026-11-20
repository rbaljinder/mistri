/**
 * A public page's quiet language switch: the App's languages, each named in itself, at the foot of a public form,
 * a saved form and a status check (the link page draws the same on the server, links/linkPage.ts). Drawn only where
 * the App has two catalogs or more; one language has nothing to switch to, and an App names none of this.
 *
 * Each choice is a link to this page with `?locale=`, so it works before any script and a shared address says the
 * language it was read in. The click also keeps the pick in the App's language cookie (kit messages.ts reads the
 * same one), so the App's own pages and the next visit open in it.
 */
import { localeCookieName } from '@mistriwork/engine/shared/appLocale.js';
import { appWord } from '@mistriwork/kit/client/messages.js';
import { setHostCookie } from '@mistriwork/kit/client/shellHost.js';
import { say } from '../copy/public/components/LanguageSwitch.js';

/** The languages a public page may be read in (commands/formHttp.ts publicFormParts), and the one it is read in. */
export interface PublicLanguages {
  offered: readonly string[];
  locale: string;
}

/** A language as it names itself ("Español", "English"), which is how a reader who cannot read the page finds theirs. */
function ownName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return tag;
  }
}

/** This page's address with `locale` set and every other parameter (a tenant's `via`) kept. */
export function addressIn(tag: string, search: string = window.location.search): string {
  const params = new URLSearchParams(search);
  params.set('locale', tag);
  return `?${params.toString()}`;
}

export function LanguageSwitch({ appId, languages }: { appId: string | undefined; languages: PublicLanguages | undefined }) {
  if (!appId || !languages || languages.offered.length < 2) return null;
  const current = languages.locale.toLowerCase();
  return (
    <footer className="form-page-languages">
      <nav aria-label={appWord('mistri.language', say('language'))}>
        {languages.offered.map((tag) => (
          <a
            key={tag}
            href={addressIn(tag)}
            lang={tag}
            hrefLang={tag}
            {...(tag.toLowerCase() === current ? { 'aria-current': 'true' as const } : {})}
            onClick={() => setHostCookie(localeCookieName(appId), tag)}
          >
            {ownName(tag)}
          </a>
        ))}
      </nav>
    </footer>
  );
}
