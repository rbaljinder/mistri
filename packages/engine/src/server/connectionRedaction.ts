/**
 * A displayable form of a target with no credential in it.
 *
 * `URL` parses out the password for us; the fallback matters because a
 * malformed URL must not fall through to printing the original string.
 */
export function redact(url: string): string {
  if (!/^[a-z][\w+.-]*:\/\//i.test(url)) {
    // A bare file path. Show the file name, not the whole tree.
    return url.split('/').pop() || url;
  }
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username}@` : '';
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${user}${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    return '(connection)';
  }
}

/**
 * Take the credentials out of anything on its way to the browser.
 *
 * `redact` produces the public form of a URL we chose to show. This is for
 * the other direction: text we did not write, going somewhere we did not
 * intend. A driver's failure message quotes what it was handed, and what it
 * was handed is the *resolved* connection string — the one with the password
 * expanded out of the keychain and into it. That message was stored on the
 * entry and served by every `GET /api/connections` from then on.
 *
 * Two passes, because there are two shapes of leak:
 *
 *   1. The whole DSN, echoed. Any `scheme://…` in the text is replaced with
 *      its redacted form, so the message keeps saying which host it could not
 *      reach — which is the useful half — without the credentials.
 *   2. The password alone, quoted without its URL. Rarer, and caught by
 *      sweeping for the literal value.
 *
 * A password shorter than four characters is swept too. It mangles a message
 * that happens to contain those letters, and that is the right trade: a
 * garbled sentence is a nuisance, and a password on screen is not.
 */
export function scrubSecrets(text: string, ...urls: Array<string | undefined>): string {
  let out = text.replace(/\b[a-z][\w+.-]*:\/\/[^\s'"`,)\]]+/gi, (match) => redact(match));

  for (const url of urls) {
    if (!url) continue;
    for (const secret of passwordsIn(url)) {
      if (!secret) continue;
      out = out.split(secret).join('\u2022\u2022\u2022\u2022');
    }
  }
  return out;
}

/**
 * The password in a URL, in both the spellings it can appear in.
 *
 * `new URL` gives it percent-decoded, and a driver may quote either that or
 * the raw form it was handed. Both are swept.
 */
function passwordsIn(url: string): string[] {
  const found = new Set<string>();
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      found.add(parsed.password);
      found.add(decodeURIComponent(parsed.password));
    }
  } catch {
    /* Not a URL — a file path, or a string with a `${VAR}` still in it. There
       is no password to find, and failing to parse is not an error here. */
  }
  return [...found];
}
