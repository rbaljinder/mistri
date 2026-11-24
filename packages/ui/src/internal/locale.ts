/**
 * Resolves an explicit BCP 47 locale tag or falls back to the active document's `<html lang>`
 * (which Mistri stamps with the App's / tenant's / viewer's locale) before the runtime default.
 */
export function resolveLocale(locale?: string): string | undefined {
  if (locale && locale.trim()) return locale.trim();
  if (typeof document !== 'undefined') {
    const docLang = document.documentElement?.lang?.trim();
    if (docLang) return docLang;
  }
  return undefined;
}
