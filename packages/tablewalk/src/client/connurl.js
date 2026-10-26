/**
 * A connection string, taken apart and put back together.
 *
 * One box asking for `postgres://user:password@host:5432/db  or  /path/to/file.db`
 * is fine if you already know the shape and unhelpful if you do not — and the
 * people most likely not to know are the ones a tool like this is for. It is
 * also the box that quietly encourages the worst habit available: typing a
 * password into a string that then travels wherever the string travels.
 *
 * So the dialog offers both, and this is the part that lets them be the same
 * thing rather than two forms that disagree. Pure — no DOM, no state — so the
 * fiddly half can be tested directly, which it needs to be: the fiddly half
 * is percent-encoding and it is where a password containing `@` turns into a
 * connection to a host that does not exist.
 */

/** What each driver assumes when a port is not given. */
export const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306 };

/** The drivers a connection can name, in the order the picker offers them. */
export const DRIVERS = ['postgres', 'mysql', 'mariadb', 'sqlite'];

const EMPTY = {
  driver: 'postgres',
  host: '',
  port: '',
  database: '',
  user: '',
  password: '',
  params: '',
  file: '',
};

/**
 * Take a connection string apart.
 *
 * A SQLite target is a bare path with no structure to read, so it comes back
 * as `{ driver: 'sqlite', file }` and nothing else — pretending a file path
 * has a host and a user would be inventing fields to fill boxes with.
 *
 * Anything unparseable comes back as the empty shape rather than throwing:
 * this runs on a keystroke while someone is halfway through typing, and a
 * half-typed URL is the normal state of the box, not an error.
 */
export function parseConnectionUrl(url) {
  const text = String(url ?? '').trim();
  if (!text) return { ...EMPTY };

  /* No scheme means a file, which is how SQLite is named everywhere else in
     this tool. `sqlite:` is accepted because people write it. */
  if (!/^[a-z][\w+.-]*:\/\//i.test(text)) {
    return { ...EMPTY, driver: 'sqlite', file: text.replace(/^sqlite:(\/\/)?/i, '') };
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ...EMPTY };
  }

  const driver = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (driver === 'sqlite') return { ...EMPTY, driver: 'sqlite', file: parsed.pathname };

  return {
    driver: DRIVERS.includes(driver) ? driver : 'postgres',
    host: parsed.hostname,
    /* Blank when it is the driver's own default: a port box reading 5432 on
       every Postgres connection is a box nobody reads, and one that has to be
       cleared to mean "whatever the default is". */
    port: parsed.port && Number(parsed.port) !== DEFAULT_PORTS[driver] ? parsed.port : '',
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    /* Kept whole and handed back unchanged. `?sslmode=require` is not
       decoration — dropping it on a round trip through this form would turn a
       verified connection into a plaintext one, silently. */
    params: parsed.search.replace(/^\?/, ''),
    file: '',
  };
}

/**
 * `${VAR}` and `$VAR`, the two spellings `expandEnv` accepts.
 *
 * Global, because a value may be part literal and part reference —
 * `prefix-${TOKEN}` is a thing people write — and the encoder below walks the
 * matches rather than testing the whole string.
 */
const ENV_REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Encode a URL part, leaving any environment reference in it alone.
 *
 * This is the difference between a form that supports the arrangement the
 * documentation recommends first and one that quietly destroys it.
 * `encodeURIComponent('${PROD_PASSWORD}')` is `%24%7BPROD_PASSWORD%7D`, which
 * `expandEnv` does not match — so typing a reference into the password box
 * produced a connection whose password was the literal characters of the
 * reference, with nothing on screen to say so.
 *
 * Everything that is not a reference is still encoded, because the reason
 * this function exists at all is passwords containing `@` and `:`.
 */
function encodePart(value) {
  const text = String(value ?? '');
  let out = '';
  let at = 0;
  for (const match of text.matchAll(ENV_REFERENCE)) {
    out += encodeURIComponent(text.slice(at, match.index)) + match[0];
    at = match.index + match[0].length;
  }
  return out + encodeURIComponent(text.slice(at));
}

/**
 * Whether this is a server URL with its `://` missing.
 *
 * Anything without a scheme is read as a file path, because that is how
 * SQLite is named everywhere in this tool — and that is right for
 * `./data/app.db` and wrong for `postgres@127.0.0.1/tablewalk`, which is
 * exactly what tablewalk itself prints as a connection's name. Copying what
 * the app showed you and pasting it back got "unable to open database file",
 * which is SQLite's honest answer to a question nobody meant to ask.
 *
 * An `@` before the first `/` is the tell, and a narrow one: a file path
 * essentially never has one, and a `user@host` almost always does. It is
 * deliberately not a guess at *which* driver — that is the one thing the
 * string does not say, so it is the one thing worth asking about.
 */
export function looksSchemeless(url) {
  const text = String(url ?? '').trim();
  if (!text || /^[a-z][\w+.-]*:\/\//i.test(text)) return false;
  return /^[^/\s@]+@[^/\s@]+/.test(text);
}

/** Whether a value is, or contains, an environment reference. */
export function isEnvReference(value) {
  return new RegExp(ENV_REFERENCE.source).test(String(value ?? ''));
}

/**
 * Put one back together.
 *
 * Every part is encoded on the way in, which is the whole reason this is a
 * function rather than a template string: a password of `p@ss:word` written
 * straight into `user:p@ss:word@host` names the host `word@host` and the
 * failure reads as "could not connect" rather than "your password has an @
 * in it".
 */
export function buildConnectionUrl(parts) {
  const p = { ...EMPTY, ...parts };
  if (p.driver === 'sqlite') return String(p.file ?? '').trim();

  const host = String(p.host ?? '').trim();
  if (!host) return '';

  const auth = p.user ? `${encodePart(p.user)}${p.password ? `:${encodePart(p.password)}` : ''}@` : '';
  const port = String(p.port ?? '').trim();
  const database = String(p.database ?? '').trim();
  const params = String(p.params ?? '')
    .trim()
    .replace(/^\?/, '');

  return `${p.driver}://${auth}${host}${port ? `:${port}` : ''}` + `/${encodeURIComponent(database)}` + `${params ? `?${params}` : ''}`;
}

/**
 * The same string with the password replaced by dots.
 *
 * For the preview, which exists so someone can check the URL they are about
 * to save — and checking it should not require the secret to be sitting on
 * screen where a shoulder, a screen share or a screenshot can reach it. The
 * dots are a fixed width so the length is not a hint either.
 */
export function redactConnectionUrl(url) {
  const text = String(url ?? '');
  try {
    const parsed = new URL(text);
    if (!parsed.password) return text;
    /* A reference is not a secret. `${PROD_PASSWORD}` names a variable and
       reveals nothing, and it is the one part of the URL worth reading back
       carefully — hiding it would take away the only way to notice the
       variable name is misspelled. */
    if (isEnvReference(decodeURIComponent(parsed.password))) return text;
    parsed.password = '';
    /* Rebuilt by hand rather than by assigning a mask to `parsed.password`,
       which would percent-encode the dots into `%E2%80%A2` and show that. */
    return parsed.toString().replace(`${parsed.username}@`, `${parsed.username}:••••••@`);
  } catch {
    return text;
  }
}
