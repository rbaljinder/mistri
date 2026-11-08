/** A typed fetch client for an App's API, written from the document `--export openapi` prints. A pure function of
 * that document: the same one gives the same bytes (everything is sorted by name, nothing is dated), and the file
 * it returns imports nothing, so it runs wherever `fetch`, `URL` and `URLSearchParams` do. The document is the only
 * input on purpose: the client can never describe an operation the exported contract does not, and `compare-openapi`
 * on two documents is also a statement about the two clients. */

type Json = Record<string, unknown>;
type Schema = Json | boolean | undefined;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const DOCUMENTS = ['app-api', 'app-api-reads'];
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The exported document, or the one-line reason it is not one. */
function checkAppApiDocument(document: unknown): Json {
  if (!isObject(document) || typeof document.openapi !== 'string' || !isObject(document.paths)) {
    throw new Error('not an OpenAPI document; give the file `mistri --export openapi` wrote.');
  }
  if (typeof document['x-mistri-document'] !== 'string' || !DOCUMENTS.includes(document['x-mistri-document'])) {
    throw new Error(
      'not an App API document made by mistri; export one with `mistri --app <dir> --export openapi --api-integers decimal-string`.',
    );
  }
  return document;
}

/** mistri hex-encodes the part of a name that is the App's own (`read_6c6973743a6974656d` is `read_list:item`). */
function unhex(text: string): string {
  const parts = text.split('_');
  const last = parts[parts.length - 1];
  if (parts.length < 2 || !/^(?:[0-9a-f]{2})+$/.test(last)) return text;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(last.match(/../g)!, (h) => parseInt(h, 16)));
    return `${parts.slice(0, -1).join('_')}_${decoded}`;
  } catch {
    return text;
  }
}
const words = (text: string) =>
  unhex(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
const camel = (text: string) => {
  const w = words(text).map((x) => x.toLowerCase());
  const name = w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1) : x)).join('');
  return /^[a-z]/.test(name) ? name : `op${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`;
};
const pascal = (text: string) => {
  const name = camel(text);
  return name[0].toUpperCase() + name.slice(1);
};
/** A name nothing else has: later claimants get a number, in the order they were sorted. */
function uniqueNames(keys: string[], make: (key: string) => string): Map<string, string> {
  const taken = new Set<string>(),
    out = new Map<string, string>();
  for (const key of [...keys].sort(byText)) {
    const base = make(key);
    let name = base,
      n = 2;
    while (taken.has(name)) name = `${base}${n++}`;
    taken.add(name);
    out.set(key, name);
  }
  return out;
}

const literal = (value: unknown) => JSON.stringify(value) ?? 'unknown';

function toType(schema: Schema, names: Map<string, string>, pad: string): string {
  if (schema === true || schema === undefined) return 'unknown';
  if (schema === false) return 'never';
  if (typeof schema.$ref === 'string') {
    const name = names.get(schema.$ref.replace('#/components/schemas/', ''));
    return name ?? 'unknown';
  }
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ') || 'never';
  const union = (list: unknown, glue: string) => (list as Schema[]).map((s) => `(${toType(s, names, pad)})`).join(glue);
  const parts: string[] = [];
  const type = schema.type;
  if (Array.isArray(type))
    parts.push(
      type.map((t) => toType({ ...schema, type: t, anyOf: undefined, oneOf: undefined, allOf: undefined }, names, pad)).join(' | '),
    );
  else if (type === 'string') parts.push('string');
  else if (type === 'number' || type === 'integer') parts.push('number');
  else if (type === 'boolean') parts.push('boolean');
  else if (type === 'null') parts.push('null');
  else if (type === 'array') parts.push(`Array<${toType(schema.items as Schema, names, pad)}>`);
  else if (type === 'object' || isObject(schema.properties) || isObject(schema.additionalProperties))
    parts.push(objectType(schema, names, pad));
  if (Array.isArray(schema.allOf) && schema.allOf.length) parts.push(union(schema.allOf, ' & '));
  const either = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (either?.length) parts.push(union(either, ' | '));
  if (!parts.length) return 'unknown';
  return parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(' & ');
}

function objectType(schema: Json, names: Map<string, string>, pad: string): string {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const inner = `${pad}  `;
  const lines = Object.keys(properties)
    .sort(byText)
    .map(
      (key) =>
        `${inner}${/^[A-Za-z_$][\w$]*$/.test(key) ? key : literal(key)}${required.has(key) ? '' : '?'}: ${toType(properties[key] as Schema, names, inner)};`,
    );
  const extra = schema.additionalProperties;
  if (isObject(extra) || extra === true) lines.push(`${inner}[key: string]: ${isObject(extra) ? toType(extra, names, inner) : 'unknown'};`);
  return lines.length ? `{\n${lines.join('\n')}\n${pad}}` : 'Record<string, never>';
}

type Param = { key: string; wire: string; where: 'path' | 'query' | 'header'; required: boolean; type: string };
type Operation = {
  method: string;
  path: string;
  id: string;
  summary?: string;
  params: Param[];
  body?: { type: string; required: boolean };
  result: string;
};

const PREAMBLE = `/** The App API's client, generated by \`mistri api client\` from its exported OpenAPI document. Do not edit it:
 * export the document again and generate it again. It imports nothing and uses only fetch, URL and URLSearchParams,
 * so it runs in a browser, Node 20+, Deno and Workers. */

export type ApiToken = string | (() => string | Promise<string>);

export type ClientOptions = {
  /** The server's origin and, under it, the App's API path: the document's \`servers\` entry. */
  baseUrl: string;
  /** A token from \`mistri api-token issue\`, or a function returning one. */
  token: ApiToken;
  fetch?: typeof globalThis.fetch;
};

/** The problem details a refusal carries (RFC 9457), where the App's API sends them. */
export type ApiProblem = {
  type: string;
  title: string;
  status: number;
  code: string;
  field?: string;
  outcome?: 'not_applied' | 'unknown';
  [key: string]: unknown;
};

/** A response outside 2xx: \`problem\` is set when the body is the App's problem details (403, 409, 410, 422 and the
 * rest), \`body\` is whatever was parsed either way. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly problem: ApiProblem | undefined;
  constructor(status: number, body: unknown) {
    const problem = isProblem(body) ? body : undefined;
    super(problem ? \`\${status} \${problem.code}: \${problem.title}\` : \`The API answered \${status}.\`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.problem = problem;
  }
}

function isProblem(body: unknown): body is ApiProblem {
  return (
    !!body &&
    typeof body === 'object' &&
    typeof (body as ApiProblem).type === 'string' &&
    typeof (body as ApiProblem).code === 'string' &&
    typeof (body as ApiProblem).title === 'string'
  );
}

// A path parameter: one value, or a composite key in simple style with explode=true, column=value pairs joined by
// literal commas with each value encoded once, as the document describes it.
function segment(value: unknown): string {
  if (value !== null && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .map(([column, part]) => column + '=' + encodeURIComponent(String(part)))
      .join(',');
  return encodeURIComponent(String(value));
}

type Wire = { method: string; path: string; query: Record<string, unknown>; headers: Record<string, unknown>; body?: unknown };

function createTransport(options: ClientOptions) {
  const base = options.baseUrl.replace(/\\/+$/, '');
  return async function send<T>(wire: Wire): Promise<T> {
    const url = new URL(base + wire.path);
    for (const [name, value] of Object.entries(wire.query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value));
    }
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    const headers: Record<string, string> = { accept: 'application/json', authorization: \`Bearer \${token}\` };
    for (const [name, value] of Object.entries(wire.headers)) if (value !== undefined && value !== null) headers[name] = String(value);
    const init: RequestInit = { method: wire.method, headers };
    if (wire.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(wire.body);
    }
    const response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(url, init);
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) throw new ApiError(response.status, parsed);
    return parsed as T;
  };
}
`;

function collect(document: Json, names: Map<string, string>): Operation[] {
  const paths = document.paths as Json;
  const raw: { method: string; path: string; op: Json; id: string }[] = [];
  for (const path of Object.keys(paths).sort(byText)) {
    const entry = paths[path];
    if (!isObject(entry)) continue;
    for (const method of METHODS) {
      const op = entry[method];
      if (isObject(op)) raw.push({ method, path, op, id: typeof op.operationId === 'string' ? op.operationId : `${method} ${path}` });
    }
  }
  const functionNames = uniqueNames(
    raw.map((r) => r.id),
    camel,
  );
  return raw.map(({ method, path, op, id }) => {
    const declared = (Array.isArray(op.parameters) ? op.parameters : []).filter(isObject);
    const keys = uniqueNames(
      declared.map((p) => `${p.in}:${p.name}`),
      (key) => camel(key.slice(key.indexOf(':') + 1)) || 'param',
    );
    if ([...keys.values()].includes('body')) for (const [k, v] of keys) if (v === 'body') keys.set(k, 'bodyParam');
    const params: Param[] = declared
      .filter((p) => ['path', 'query', 'header'].includes(String(p.in)))
      .map((p) => ({
        key: keys.get(`${p.in}:${p.name}`)!,
        wire: String(p.name),
        where: p.in as Param['where'],
        required: p.required === true || p.in === 'path',
        type: toType(p.schema as Schema, names, '  '),
      }))
      .sort((a, b) => byText(a.where + a.key, b.where + b.key));
    const content = isObject(op.requestBody) && isObject(op.requestBody.content) ? op.requestBody.content['application/json'] : undefined;
    const responses = isObject(op.responses) ? op.responses : {};
    const ok = Object.keys(responses)
      .filter((code) => /^2\d\d$/.test(code))
      .sort(byText)[0];
    const okContent =
      ok && isObject(responses[ok]) && isObject((responses[ok] as Json).content)
        ? ((responses[ok] as Json).content as Json)['application/json']
        : undefined;
    return {
      method,
      path,
      id: functionNames.get(id)!,
      summary: typeof op.summary === 'string' ? op.summary : undefined,
      params,
      body: isObject(content)
        ? { type: toType(content.schema as Schema, names, '  '), required: (op.requestBody as Json).required === true }
        : undefined,
      result: isObject(okContent) ? toType(okContent.schema as Schema, names, '  ') : 'void',
    };
  });
}

/** The client's source for one exported App API document; throws a one-line message when it is not one. */
export function renderApiClient(input: unknown): string {
  const document = checkAppApiDocument(input);
  const components = isObject(document.components) && isObject(document.components.schemas) ? document.components.schemas : {};
  const typeNames = uniqueNames(Object.keys(components), pascal);
  // The names a hand-written client of the same file would not clash with.
  for (const [key, name] of typeNames)
    if (['ApiError', 'ApiProblem', 'ApiToken', 'ClientOptions', 'Client'].includes(name)) typeNames.set(key, `${name}Schema`);
  const out = [PREAMBLE];
  for (const key of Object.keys(components).sort(byText)) {
    const schema = components[key] as Schema;
    const body = toType(schema, typeNames, '');
    out.push(`export type ${typeNames.get(key)} = ${body};\n`);
  }
  const operations = collect(document, typeNames);
  const info = isObject(document.info) ? document.info : {};
  const title = typeof info.title === 'string' ? info.title.replace(/\*\//g, '* /').replace(/\s+/g, ' ') : 'App';
  const servers =
    Array.isArray(document.servers) && isObject(document.servers[0]) && typeof document.servers[0].url === 'string'
      ? document.servers[0].url
      : undefined;
  out.push(
    `/** The ${title} API${servers ? `, served under \`${servers.replace(/\*\//g, '')}\`` : ''}. */\nexport function createClient(options: ClientOptions) {\n  const send = createTransport(options);\n  return {`,
  );
  for (const op of [...operations].sort((a, b) => byText(a.id, b.id))) {
    const fields = [
      ...op.params.map((p) => `${p.key}${p.required ? '' : '?'}: ${p.type}`),
      ...(op.body ? [`body${op.body.required ? '' : '?'}: ${op.body.type}`] : []),
    ];
    const optional = fields.length > 0 && !op.params.some((p) => p.required) && !op.body?.required;
    const arg = fields.length ? `args${optional ? '?' : ''}: { ${fields.join('; ')} }` : '';
    const pick = (where: Param['where']) => {
      const list = op.params.filter((p) => p.where === where);
      return `{ ${list.map((p) => `${literal(p.wire)}: args${optional ? '?' : ''}.${p.key}`).join(', ')} }`;
    };
    // The path lands inside a template literal in the client, so its own text is escaped: a document is data, and a
    // backtick or `${` in it must stay text rather than end the literal or run as code. Every `$` is escaped, since a
    // placeholder may split it from its brace.
    const inTemplate = (text: string) => text.replace(/[\\`$]/g, (m) => `\\${m}`);
    const path = op.path
      .split(/(\{[^}]+\})/)
      .map((piece) => {
        const name = /^\{([^}]+)\}$/.exec(piece)?.[1];
        const p = name === undefined ? undefined : op.params.find((x) => x.where === 'path' && x.wire === name);
        return p ? `\${segment(args.${p.key})}` : inTemplate(piece);
      })
      .join('');
    const doc = op.summary
      ? `    /** ${op.summary.replace(/\*\//g, '* /')} (${op.method.toUpperCase()} ${op.path.replace(/\*\//g, '')}) */\n`
      : '';
    out.push(
      `${doc}    ${op.id}: (${arg}): Promise<${op.result}> =>\n      send<${op.result}>({ method: ${literal(op.method.toUpperCase())}, path: \`${path}\`, query: ${pick('query')}, headers: ${pick('header')}${op.body ? `, body: args${optional ? '?' : ''}.body` : ''} }),`,
    );
  }
  out.push('  };\n}\n\nexport type Client = ReturnType<typeof createClient>;\n');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
