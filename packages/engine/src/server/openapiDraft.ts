/**
 * An API's OpenAPI spec, turned into what tablewalk reads.
 *
 * `--from-openapi` drafts the description and prints it: the description goes
 * to stdout and nothing else does, so redirecting it is the whole workflow
 * (`--from-openapi crm.json > crm.http.json`). `--openapi` drafts the same
 * description in memory and serves the API as a connection straight away, with
 * no config file and no description on disk. Either way, what was guessed and
 * what was skipped goes to stderr, where a person reads it before trusting the
 * result — a draft to confirm, as `--scaffold-app` is.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { isIP } from 'node:net';
import { DEFAULT_POLICY, HttpSourceError, send } from '../adapters/http/egress.js';
import { OpenApiError, readOpenApi, type HttpCatalog } from '../adapters/http/openapi.js';
import { draftDescription, type HttpDescription } from '../adapters/http/httpDescription.js';
import type { HttpConnectionConfig } from './httpConnection.js';
import { product } from './product.js';

interface Writer {
  write(text: string): unknown;
}

/** A spec as read: its parsed document, the name it is known by, and the hash of what was read. */
interface Spec {
  document: unknown;
  name: string;
  sha256: string;
  url?: URL;
}

/* Specs run to megabytes (a large public API's is several), well past what one
   API answer may be, so a spec fetch gets a cap of its own. */
const SPEC_MAX_BYTES = 25 * 1024 * 1024;

const isLoopback = (host: string) => {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare === 'localhost' || (isIP(bare) === 4 && bare.startsWith('127.')) || bare === '::1';
};

/**
 * Read a spec from a file or an http(s) URL. A URL is fetched through egress,
 * under the rules every API request follows, with no credential: a spec that
 * needs one is downloaded first and named as a file. Throws with a reason.
 */
async function loadSpec(source: string): Promise<Spec> {
  if (!source) throw new Error('needs a spec: a JSON file or an https URL (OpenAPI 3.0 or 3.1).');
  if (/^https?:\/\//i.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error(`${source} is not a URL.`);
    }
    const policy = { ...DEFAULT_POLICY, maxBytes: SPEC_MAX_BYTES, insecure: url.protocol === 'http:' && isLoopback(url.hostname) };
    let reply: Awaited<ReturnType<typeof send>>;
    try {
      reply = await send(url, { accept: 'application/json' }, policy);
    } catch (error) {
      if (error instanceof HttpSourceError) throw new Error(`${url.host}: ${error.message}`);
      throw error;
    }
    if (reply.status < 200 || reply.status > 299) throw new Error(`${source} answered ${reply.status}.`);
    // The hash of the document as parsed: the bytes on the wire are egress's to keep.
    const sha256 = createHash('sha256').update(JSON.stringify(reply.json)).digest('hex');
    return { document: reply.json, name: source, sha256, url };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(source);
  } catch {
    throw new Error(`no spec file at ${source}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    // YAML is the usual reason; tablewalk takes no YAML dependency for it.
    throw new Error(`${source} is not JSON (${(error as Error).message}). Specs are read as JSON; convert a YAML one first.`);
  }
  // The hash of the exact bytes read, so a description can say which spec it came from.
  return { document, name: basename(source), sha256: createHash('sha256').update(bytes).digest('hex') };
}

/* Read the spec's resources and say, on stderr, what was guessed and what was
   skipped. Throws when nothing could be drafted, since a description with no
   resources is not one a connection can read. */
function draft(spec: Spec, source: string, err: Writer): { catalog: HttpCatalog; description: HttpDescription } {
  let catalog: HttpCatalog;
  try {
    catalog = readOpenApi(spec.document);
  } catch (error) {
    if (!(error instanceof OpenApiError)) throw error;
    throw new Error(`${source}: ${error.message}`);
  }
  for (const resource of catalog.resources) {
    for (const guess of resource.guesses) err.write(`guessed  ${resource.name}: ${guess}\n`);
  }
  for (const skip of catalog.skipped) err.write(`skipped  ${skip.operation}: ${skip.reason}\n`);
  if (!catalog.resources.length)
    throw new Error(`No resource could be drafted from ${source}: every operation was skipped, for the reasons above.`);
  return { catalog, description: draftDescription(catalog, { file: spec.name, sha256: spec.sha256 }) };
}

const drafted = (catalog: HttpCatalog) => {
  const count = catalog.resources.length;
  return `${count} resource${count === 1 ? '' : 's'} drafted from ${catalog.title}${catalog.version ? ` ${catalog.version}` : ''}`;
};

/** `--from-openapi`: drafts and prints; answers the exit code, 0 with at least one resource, 1 otherwise. */
export async function draftFromOpenapi(source: string, out: Writer = process.stdout, err: Writer = process.stderr): Promise<number> {
  try {
    const { catalog, description } = draft(await loadSpec(source), source, err);
    out.write(`${JSON.stringify(description, null, 2)}\n`);
    err.write(`${drafted(catalog)}. Confirm the guesses above before using it.\n`);
    return 0;
  } catch (error) {
    err.write(`${product()}: --from-openapi ${(error as Error).message}\n`);
    return 1;
  }
}

interface OpenapiBootOptions {
  /** The API's base URL, when the spec's `servers` does not give a usable one. */
  apiUrl?: string;
  /** The environment variable holding a bearer token; only its name is kept. */
  tokenEnv?: string;
}

/* The base every description path resolves under: `--api-url`, else the
   spec's first server, resolved against the spec's own URL when it came from
   one. A server with `{variables}` is a template, not an address. */
function baseOf(spec: Spec, options: OpenapiBootOptions): URL {
  const servers = (spec.document as { servers?: Array<{ url?: unknown }> }).servers;
  const written = options.apiUrl ?? (Array.isArray(servers) && typeof servers[0]?.url === 'string' ? servers[0].url : undefined);
  if (!written) throw new Error('The spec names no server. Pass --api-url <base URL> to say where the API is.');
  if (!options.apiUrl && /\{[^}]*\}/.test(written)) {
    throw new Error(`The spec's server "${written}" has variables. Pass --api-url with the address filled in.`);
  }
  let url: URL;
  try {
    url = spec.url && !options.apiUrl ? new URL(written, spec.url) : new URL(written);
  } catch {
    throw new Error(`The spec's server "${written}" is not an address on its own. Pass --api-url <base URL> to say where the API is.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${url.protocol}// is not an API address; use https.`);
  if (url.username || url.password) throw new Error('A credential belongs in --api-token-env, not in the URL.');
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new Error(
      `${url.host} would be reached over plain http. From the command line that is allowed only to this machine; use https, or a config with "insecure": true.`,
    );
  }
  url.search = '';
  url.hash = '';
  return url;
}

/**
 * `--openapi`: a connection straight from a spec. The description is drafted
 * in memory (and said on stderr, as `--from-openapi` says it), the base URL is
 * `--api-url` or the spec's server, and the token is a `${VAR}` reference,
 * expanded when the connection opens, as a config's is. Throws with a reason
 * a person can act on.
 */
export async function openapiConnection(
  source: string,
  options: OpenapiBootOptions,
  err: Writer = process.stderr,
): Promise<{ name: string; url: string; http: HttpConnectionConfig }> {
  const spec = await loadSpec(source);
  const { catalog, description } = draft(spec, source, err);
  const base = baseOf(spec, options);
  let auth: HttpConnectionConfig['auth'];
  if (options.tokenEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tokenEnv))
      throw new Error(`--api-token-env takes a variable's name, not "${options.tokenEnv}".`);
    if (process.env[options.tokenEnv] === undefined)
      throw new Error(`${options.tokenEnv} is not set. Export it, or leave out --api-token-env.`);
    auth = { bearer: `\${${options.tokenEnv}}` };
  }
  err.write(`${drafted(catalog)}, served from ${base.origin}${base.pathname}.\n`);
  return {
    name: catalog.title || basename(spec.name),
    url: base.toString(),
    http: { description, ...(auth ? { auth } : {}), ...(base.protocol === 'http:' ? { insecure: true } : {}) },
  };
}
