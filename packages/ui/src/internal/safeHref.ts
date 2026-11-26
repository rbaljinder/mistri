/**
 * Guard anchor `href` values against executable URL schemes (`javascript:`, `vbscript:`, `data:`),
 * including whitespace- or control-character-obfuscated variants, while preserving relative paths,
 * fragments, query links, `https:`, `http:`, `mailto:`, `tel:`, and `blob:`.
 */
export function safeHref(href: string | undefined): string | undefined {
  if (typeof href !== 'string') return undefined;
  const trimmed = href.trim();
  if (!trimmed) return undefined;
  // Strip ASCII control characters and spaces when checking the scheme (browsers ignore them before ':').
  let normalized = '';
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) > 0x20) normalized += trimmed[i];
  }
  const colon = normalized.indexOf(':');
  if (colon !== -1) {
    const slash = normalized.search(/[/?#]/);
    if (slash === -1 || colon < slash) {
      const scheme = normalized.slice(0, colon).toLowerCase();
      if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto' && scheme !== 'tel' && scheme !== 'blob') {
        return undefined;
      }
    }
  }
  return href;
}
