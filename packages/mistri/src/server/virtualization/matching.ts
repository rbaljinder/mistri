/** HTTP matching shared by virtual routes and request verification. Omitted
 * fields are unconstrained; exact/partial body matching is always explicit.
 * Predicates are trusted synchronous test code, never serialized definitions.
 */
import { isDeepStrictEqual } from 'node:util';

export type ValueMatcher = string | readonly string[] | RegExp | ((values: readonly string[]) => boolean);
export type BodyMatcher = { readonly exact: unknown } | { readonly partial: unknown } | { readonly predicate: (body: unknown) => boolean };
export interface RequestMatcher {
  readonly method?: string;
  /** Literal segments, :parameters and a final * remainder. */
  readonly path?: string;
  readonly query?: Readonly<Record<string, ValueMatcher>>;
  readonly headers?: Readonly<Record<string, ValueMatcher>>;
  readonly body?: BodyMatcher;
}
export interface VirtualRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: unknown;
  /** Original UTF-8 body, for webhook signature verification. */
  readonly rawBody?: string;
}
export interface RequestMatch {
  readonly matched: boolean;
  readonly params: Readonly<Record<string, string>>;
  readonly differences: readonly string[];
}

/** Copy authored matcher data, retaining only trusted predicate functions. */
export function captureRequestMatcher(input: RequestMatcher): RequestMatcher {
  validateRequestMatcher(input);
  const fields = (values: Readonly<Record<string, ValueMatcher>> | undefined) =>
    values === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            value instanceof RegExp ? new RegExp(value.source, value.flags) : Array.isArray(value) ? [...value] : value,
          ]),
        );
  return {
    ...input,
    query: fields(input.query),
    headers: fields(input.headers),
    ...(input.body === undefined
      ? {}
      : { body: 'predicate' in input.body ? { predicate: input.body.predicate } : structuredClone(input.body) }),
  };
}

function segments(path: string): string[] {
  return path.split('/').map((part) => decodeURIComponent(part));
}

export function validateRequestMatcher(matcher: RequestMatcher): void {
  if (!matcher || typeof matcher !== 'object') throw new Error('A request matcher is required.');
  const unknown = Object.keys(matcher).find((key) => !['method', 'path', 'query', 'headers', 'body'].includes(key));
  if (unknown) throw new Error(`Unknown request matcher field: ${unknown}.`);
  if (matcher.method !== undefined && !/^[A-Za-z]+$/.test(matcher.method)) throw new Error('Invalid HTTP method.');
  if (matcher.path !== undefined) {
    if (!matcher.path.startsWith('/') || /[?#]/.test(matcher.path))
      throw new Error('Match path must start with / and omit query/fragment.');
    const parts = segments(matcher.path),
      names = new Set<string>();
    for (const [index, part] of parts.entries()) {
      if (part.includes('*') && (part !== '*' || index !== parts.length - 1)) throw new Error('Wildcard must be a final * segment.');
      if (part.startsWith(':')) {
        const name = part.slice(1);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new Error('Invalid or duplicate path parameter.');
        names.add(name);
      }
    }
  }
  if (matcher.body !== undefined) {
    const keys = Object.keys(matcher.body);
    if (keys.length !== 1 || !['exact', 'partial', 'predicate'].includes(keys[0]))
      throw new Error('Body matcher needs exactly one of exact, partial or predicate.');
    if ('predicate' in matcher.body && typeof matcher.body.predicate !== 'function') throw new Error('Body predicate must be a function.');
  }
  for (const fields of [matcher.query, matcher.headers])
    if (fields) {
      const seen = new Set<string>();
      for (const [key, value] of Object.entries(fields)) {
        const normalized = fields === matcher.headers ? key.toLowerCase() : key;
        if (seen.has(normalized)) throw new Error('Duplicate matcher field.');
        seen.add(normalized);
        if (
          typeof value !== 'string' &&
          typeof value !== 'function' &&
          !(value instanceof RegExp) &&
          !(Array.isArray(value) && value.every((item) => typeof item === 'string'))
        )
          throw new Error('Invalid field matcher.');
      }
    }
}

function partial(expected: unknown, actual: unknown): boolean {
  // Arrays retain order and cardinality. Only object properties are partial.
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return isDeepStrictEqual(expected, actual);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(expected))) return isDeepStrictEqual(expected, actual);
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(
    ([key, value]) => Object.hasOwn(actual, key) && partial(value, (actual as Record<string, unknown>)[key]),
  );
}

function booleanResult(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    // An accidentally async predicate may reject after we refuse its shape.
    // Consume that rejection so it cannot escape as an unrelated process error.
    if (value instanceof Promise) void value.catch(() => {});
    throw new Error('Matcher predicates must return a synchronous boolean.');
  }
  return value;
}

function fieldMatches(expected: ValueMatcher, actual: readonly string[]): boolean {
  if (typeof expected === 'function') return booleanResult(expected(Object.freeze([...actual])));
  if (expected instanceof RegExp) {
    // Never mutate a caller's global/sticky RegExp cursor across requests.
    return actual.length === 1 && new RegExp(expected.source, expected.flags).test(actual[0]);
  }
  return isDeepStrictEqual(typeof expected === 'string' ? [expected] : expected, actual);
}

export function matchRequest(matcher: RequestMatcher, request: VirtualRequest): RequestMatch {
  validateRequestMatcher(matcher);
  const differences: string[] = [],
    params: Record<string, string> = Object.create(null);
  const url = new URL(request.url, 'http://virtual.invalid');
  if (matcher.method && matcher.method.toUpperCase() !== request.method.toUpperCase())
    differences.push(`method: expected ${matcher.method.toUpperCase()}, received ${request.method.toUpperCase()}`);
  if (matcher.path !== undefined) {
    const expected = segments(matcher.path);
    let actual: string[] = [];
    try {
      actual = segments(url.pathname);
    } catch {
      differences.push('path: malformed percent encoding');
    }
    const wildcard = expected.at(-1) === '*';
    let matches = wildcard ? actual.length >= expected.length - 1 : actual.length === expected.length;
    for (let index = 0; index < expected.length; index++) {
      const part = expected[index];
      if (part === '*') break;
      if (part.startsWith(':')) {
        if (!actual[index]) matches = false;
        else params[part.slice(1)] = actual[index];
      } else if (part !== actual[index]) matches = false;
    }
    if (!matches) differences.push(`path: expected ${matcher.path}, received ${url.pathname}`);
  }
  for (const [key, expected] of Object.entries(matcher.query ?? {})) {
    if (!fieldMatches(expected, url.searchParams.getAll(key))) differences.push(`query.${key}: value mismatch`);
  }
  const headers = new Map(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const [key, expected] of Object.entries(matcher.headers ?? {})) {
    const value = headers.get(key.toLowerCase());
    const values = value === undefined ? [] : typeof value === 'string' ? [value] : value;
    if (!fieldMatches(expected, values)) differences.push(`headers.${key.toLowerCase()}: value mismatch`);
  }
  if (matcher.body !== undefined) {
    const body = matcher.body;
    const matches =
      'exact' in body
        ? isDeepStrictEqual(body.exact, request.body)
        : 'partial' in body
          ? partial(body.partial, request.body)
          : booleanResult(body.predicate(request.body));
    if (!matches) differences.push('body: value mismatch');
  }
  return Object.freeze({ matched: differences.length === 0, params: Object.freeze(params), differences: Object.freeze(differences) });
}
