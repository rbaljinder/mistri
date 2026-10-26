/**
 * An API read as a connection: the adapter behind an `http` connection.
 *
 * Its catalog is the description (httpDescription.ts). A list is one GET with
 * the filters, sort and paging the description declares; a record is the item
 * GET by its key. It answers only what the API can: an undeclared filter, an
 * "or", a second sort or a count is refused by name rather than computed here
 * over rows the API was never asked for, because a list that silently showed
 * more or other rows than asked is the one wrong answer. It never writes —
 * writes arrive with their own slice — and every request leaves through
 * egress.ts, which is where the network is trusted or not.
 */
import { Refusal } from '../../shared/refusal.js';
import type { DatabaseSchema } from '../../shared/schema.js';
import { compileView, type CompiledColumn } from '../../shared/view.js';
import type { ViewDef } from '../../shared/viewPaths.js';
import type { HttpOperationReply, HttpOperations, HttpParam } from '../../shared/httpOperations.js';
import { ANSI_STYLE, type Adapter, type Condition, type Filter, type QueryRequest, type QueryResult, type ViewResult } from '../adapter.js';
import { describedSchema, type HttpDescription } from './httpDescription.js';
import type { HttpColumn, HttpFilter, HttpResource } from './openapi.js';
import { HttpSourceError, send, type EgressPolicy } from './egress.js';
import type { CacheStore } from '../cache/cacheStore.js';

/** A resolved credential, attached as one header. It lives only here and in egress, never in a result or an error. */
export interface HttpAuth {
  header: string;
  value: string;
}

interface HttpConnection {
  /** The API's base URL, ending in "/", under which every description path is resolved. */
  base: URL;
  description: HttpDescription;
  label: string;
  auth?: HttpAuth;
  policy: EgressPolicy;
  /**
   * Opt-in, per connection (`"cache": { "ttl": 60 }`): reads are answered
   * from this store for `ttlMs` after the API answered them. Only a 2xx is
   * kept; the explorer's operations are never answered from it.
   */
  cache?: { store: CacheStore; ttlMs: number };
}

/* How far a cursor-paged list is walked to reach a deep page, and how many
   walks are remembered so the next read of the same list jumps straight to
   its page. Deeper than the walk is refused, with the way round it. */
const MAX_REQUESTS_PER_READ = 8;
const REMEMBERED_WALKS = 64;
/* A followed reference reads each distinct target once: at most this many per
   read, this many at a time. */
const MAX_LOOKUPS_PER_READ = 50;
const LOOKUP_BATCH = 4;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** RFC 6901: the value a JSON Pointer names, or undefined. */
function at(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    current = isObject(current) && Object.hasOwn(current, key) ? current[key] : undefined;
  }
  return current;
}

/* A value the row did not carry, or carried as another type than the
   description says, is shown as empty rather than as something it is not. */
function cell(column: HttpColumn, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  switch (column.type) {
    case 'json':
      return value;
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'integer':
    case 'number':
      return typeof value === 'number' ? value : null;
    // Past 2^53 egress hands the digits over as text, which every display path keeps whole.
    case 'bigint':
      return typeof value === 'number' || (typeof value === 'string' && /^-?\d+$/.test(value)) ? value : null;
    default:
      return typeof value === 'string' ? value : null;
  }
}

function appendFilter(query: URLSearchParams, filter: HttpFilter, values: unknown[]): void {
  if (filter.serialization !== 'csv') {
    for (const value of values) query.append(filter.param, String(value));
    return;
  }
  const members = values.map((value) => {
    if (
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && (!Number.isFinite(value) || /e/i.test(String(value))))
    ) {
      throw new Refusal('This filter value cannot be represented as a CSV member.');
    }
    const text = String(value);
    if (
      !text.trim() ||
      text.includes(',') ||
      text.includes('..') ||
      [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
      throw new Refusal('This filter value cannot be represented as a CSV member.');
    }
    try {
      encodeURIComponent(text);
    } catch {
      throw new Refusal('This filter value cannot be represented as a CSV member.');
    }
    return text;
  });
  if (!members.length) throw new Refusal('A CSV filter needs at least one value.');
  query.set(filter.param, members.join(','));
}

export class HttpAdapter implements Adapter {
  readonly dialect = 'http' as const;
  private readonly walks = new Map<string, string[]>();
  private catalog?: DatabaseSchema;

  constructor(private readonly connection: HttpConnection) {}

  async introspect(): Promise<DatabaseSchema> {
    return describedSchema(this.connection.description, this.connection.label);
  }

  /* No API in the description reports a total, and counting by walking every
     page would spend someone else's rate budget to answer a question nobody
     asked; lists page by "is there another row" instead. */
  async count(table: string): Promise<number> {
    throw new Refusal(`${table} comes from an API that reports no totals, so it cannot be counted.`);
  }

  async close(): Promise<void> {}

  /** A resource's two documented reads, for the explorer's API tab: the list with its declared parameters, and the item by its key. */
  operations(table: string): HttpOperations {
    const resource = this.resource(table);
    const params: HttpParam[] = Object.entries(resource.filters).map(([column, filter]) => ({
      name: filter.param,
      kind: 'filter' as const,
      column,
      ...(filter.ops.includes('in') ? { many: true } : {}),
    }));
    if (resource.search) params.push({ name: resource.search, kind: 'search' });
    if (resource.sort) params.push({ name: resource.sort.param, kind: 'sort', values: resource.sort.values });
    const paging = resource.paging;
    if (paging.kind === 'offset') params.push({ name: paging.offset, kind: 'offset' }, { name: paging.limit, kind: 'limit' });
    if (paging.kind === 'page') params.push({ name: paging.page, kind: 'page' }, { name: paging.size, kind: 'size' });
    if (paging.kind === 'cursor') {
      if (paging.limit) params.push({ name: paging.limit, kind: 'limit' });
      params.push({ name: paging.param, kind: 'cursor' });
    }
    return {
      resource: resource.name,
      list: { path: resource.list, params, ...(paging.kind === 'cursor' ? { next: paging.next } : {}) },
      item: { path: resource.item, key: resource.key },
    };
  }

  /**
   * One documented read as the explorer tries it, answered whole: the point is
   * to see what the API says. The request is still built from the description
   * alone — a parameter it does not declare, a sort it does not document, or a
   * paging value that is not a whole number is refused by name before anything
   * is sent — and the reply says the path and query string, never a header,
   * which is where the credential is. A status that is not 2xx comes back as
   * the status, its body unread; a failed call throws HttpSourceError.
   */
  async operation(table: string, kind: 'list' | 'item', params: Record<string, string>): Promise<HttpOperationReply> {
    const started = performance.now();
    const resource = this.resource(table);
    const query = new URLSearchParams();
    let path: string;
    if (kind === 'item') {
      const stray = Object.keys(params).find((name) => name !== resource.key);
      if (stray !== undefined) throw new Refusal(`${resource.name}'s item read takes only its key, "${resource.key}"; not "${stray}".`);
      const key = (params[resource.key] ?? '').trim();
      // Encoded, like a record read, so a key cannot add a path segment; "." and ".." would step up from the item.
      if (!key || key === '.' || key === '..') throw new Refusal(`${resource.name}'s item read needs its key, "${resource.key}".`);
      path = resource.item.replace(`{${resource.key}}`, encodeURIComponent(key));
    } else {
      const declared = new Map(this.operations(table).list.params.map((param) => [param.name, param]));
      for (const [name, raw] of Object.entries(params)) {
        const param = declared.get(name);
        if (!param)
          throw new Refusal(`${resource.name}'s list takes ${[...declared.keys()].join(', ') || 'no parameters'}; not "${name}".`);
        const filter = Object.values(resource.filters).find((filter) => filter.param === name);
        const value = raw.trim();
        if (!value && filter?.serialization !== 'csv') continue;
        if (param.kind === 'sort' && !param.values!.includes(value)) {
          throw new Refusal(`${resource.name} sorts by ${param.values!.join(', ')}; not "${value}".`);
        }
        if (['offset', 'limit', 'page', 'size'].includes(param.kind) && !/^\d+$/.test(value)) {
          throw new Refusal(`"${name}" takes a whole number, not "${value}".`);
        }
        if (filter?.serialization === 'csv') appendFilter(query, filter, param.many ? raw.split(',') : [raw]);
        else if (param.many)
          for (const each of value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean))
            query.append(name, each);
        else query.set(name, value);
      }
      path = resource.list;
    }
    const reply = await this.request(path, query);
    const answered = reply.status >= 200 && reply.status <= 299;
    return {
      request: { method: 'GET', path, query: query.toString() },
      status: reply.status,
      ...(answered ? { json: reply.json } : {}),
      ms: Math.round(performance.now() - started),
    };
  }

  /* A view is a list or a record read by another name: a record page, a peek,
     a list that shows a reference's name. `compileView` still resolves its
     paths, for the names and types every surface draws by, but its SQL goes
     nowhere. The read is `query`, under the same declared-filter rules, and a
     reference is followed one step by reading each target it names once, from
     its item path: a LEFT JOIN, done by GET. What would need the targets inside
     the API's own query — a filter or a sort on them, a second step, a summary
     of the records pointing here — is refused. No `countView`: an API reports
     no totals, and a view's total is then absent, as a list's is. */
  async runView(view: ViewDef, offset = 0): Promise<ViewResult> {
    const started = performance.now();
    this.catalog ??= describedSchema(this.connection.description, this.connection.label);
    const compiled = compileView(this.catalog, view, ANSI_STYLE, offset);
    const refuse = (why: string) => {
      throw new Refusal(`${view.base} comes from an API, so a view over it ${why}`);
    };
    if (view.aggregates?.length || view.orderBy?.some((order) => order.alias)) refuse('cannot summarise the records that point at it.');
    if (view.filter?.groups.some((group) => group.some((condition) => condition.any)))
      refuse('cannot ask about the records that point at it.');
    const deep = compiled.columns.find((column) => column.hops > 1);
    if (deep) refuse(`follows one reference at most; "${deep.path}" follows ${deep.hops}.`);
    const elsewhere = [...(view.filter?.groups.flat() ?? []), ...(view.orderBy ?? [])].find((each) => each.path.includes('.'));
    if (elsewhere) refuse(`filters and sorts by its own columns only; "${elsewhere.path}" is on another resource.`);

    const via = (column: CompiledColumn) => column.path.split('.')[0];
    const own = compiled.columns.filter((column) => column.hops === 0).map((column) => column.column);
    const followed = [...new Set(compiled.columns.filter((column) => column.hops === 1).map(via))];
    const result = await this.query({
      table: view.base,
      columns: [...new Set([...own, ...followed])],
      ...(view.filter
        ? { filter: { groups: view.filter.groups.map((group) => group.map(({ path, op, value }) => ({ column: path, op, value }))) } }
        : {}),
      ...(view.orderBy?.length ? { orderBy: view.orderBy.map(({ path, direction }) => ({ column: path, direction })) } : {}),
      limit: compiled.limit,
      offset,
    });
    const targets = new Map<string, Map<string, Json>>();
    const reads: string[] = [];
    for (const column of followed) {
      const { rows, read } = await this.lookUp(view.base, column, result.rows);
      targets.set(column, rows);
      if (read) reads.push(read);
    }
    return {
      ...result,
      // Under the view's names, which an alias may have changed.
      columns: compiled.columns.map((column) => column.name),
      rows: result.rows.map((row) =>
        Object.fromEntries(
          compiled.columns.map((column) => [
            column.name,
            column.hops === 0 ? row[column.column] : (targets.get(via(column))?.get(String(row[via(column)]))?.[column.column] ?? null),
          ]),
        ),
      ),
      // The list read and every lookup, since the page waited on all of them.
      ms: Math.round(performance.now() - started),
      sql: { text: [result.sql.text, ...reads].join('\n'), params: [] },
      resolved: compiled.columns,
      joins: compiled.joins,
    };
  }

  /* Each distinct target a page names, read once from its item path, a few at
     a time. A target the API no longer has reads as no row: a LEFT JOIN's
     answer. Bounded, because every name is a request against someone else's
     rate budget; a page that names more is refused with how to narrow it. */
  private async lookUp(base: string, column: string, rows: Json[]): Promise<{ rows: Map<string, Json>; read?: string }> {
    const fk = this.catalog!.foreignKeys.find((each) => each.from.table === base && each.from.columns[0] === column)!;
    const target = this.resource(fk.to.table);
    const values = [
      ...new Set(
        rows
          .map((row) => row[column])
          .filter((value) => value !== null && value !== undefined && value !== '')
          .map(String),
      ),
    ];
    if (values.length > MAX_LOOKUPS_PER_READ) {
      throw new Refusal(
        `${base} names ${values.length} different ${target.name} on this page, more than the ${MAX_LOOKUPS_PER_READ} an API is asked for at once. Show fewer rows.`,
      );
    }
    const found = new Map<string, Json>();
    for (let start = 0; start < values.length; start += LOOKUP_BATCH) {
      await Promise.all(
        values.slice(start, start + LOOKUP_BATCH).map(async (value) => {
          const {
            rows: [row],
          } = await this.query({ table: target.name, filter: { groups: [[{ column: target.key, op: '=', value }]] }, limit: 1, offset: 0 });
          if (row) found.set(value, row);
        }),
      );
    }
    return { rows: found, ...(values.length ? { read: `GET ${target.item} for ${values.length} ${target.name}` } : {}) };
  }

  async query(request: QueryRequest): Promise<QueryResult> {
    const started = performance.now();
    const resource = this.resource(request.table);
    const columns = this.columns(resource, request.columns);
    const conditions = this.conditions(resource, request.filter);
    const byKey = conditions.length === 1 && conditions[0].column === resource.key && conditions[0].op === '=' ? conditions[0] : undefined;
    if (byKey) {
      const key = String(byKey.value);
      /* Encoded, so a key cannot add a path segment; and never "." or "..",
         which URL resolution would read as a step up from the item. */
      if (!key || key === '.' || key === '..') return this.result(columns, [], started, resource.item, new URLSearchParams());
      const path = resource.item.replace(`{${resource.key}}`, encodeURIComponent(key));
      const found = await this.get(path, new URLSearchParams(), true);
      const rows = found === undefined ? [] : [this.row(resource, found, columns)];
      return this.result(columns, rows, started, path, new URLSearchParams());
    }
    const query = new URLSearchParams();
    for (const condition of conditions) {
      appendFilter(query, resource.filters[condition.column], Array.isArray(condition.value) ? condition.value : [condition.value]);
    }
    const sort = this.sort(resource, request.orderBy);
    if (sort !== undefined) query.set(resource.sort!.param, sort);
    const { rows, sent } = await this.page(resource, query, request.limit, request.offset);
    return this.result(
      columns,
      rows.map((row) => this.row(resource, row, columns)),
      started,
      resource.list,
      sent,
    );
  }

  private resource(table: string): HttpResource {
    const resource = this.connection.description.resources.find((each) => each.name === table);
    if (!resource) throw new Refusal(`No resource called "${table}" in this API's description.`);
    return resource;
  }

  private columns(resource: HttpResource, requested: string[] | undefined): string[] {
    if (!requested?.length) return resource.columns.map((column) => column.name);
    const unknown = requested.find((name) => !resource.columns.some((column) => column.name === name));
    if (unknown !== undefined) throw new Refusal(`No column called "${unknown}" on ${resource.name}.`);
    return requested;
  }

  /** What the API can be asked, said in the refusal so the reader knows what does work. */
  private offer(resource: HttpResource): string {
    const filters = Object.entries(resource.filters).map(([column, filter]) => `${column} ${filter.ops.join(' or ')}`);
    return filters.length ? `It can filter by ${filters.join(', ')}.` : 'It takes no filters.';
  }

  private conditions(resource: HttpResource, filter: Filter | undefined): Condition[] {
    const groups = filter?.groups ?? [];
    if (!groups.length) return [];
    // Each refusal names the columns it quotes, so an App can say them in its captions.
    const filterable = Object.keys(resource.filters);
    if (groups.length > 1)
      throw new Refusal(`${resource.name} comes from an API that cannot answer "or". ${this.offer(resource)}`, { columns: filterable });
    const [group] = groups;
    if (group.length === 1 && group[0].column === resource.key && group[0].op === '=') return group;
    const seen = new Set<string>();
    for (const condition of group) {
      const declared = resource.filters[condition.column];
      const op = condition.op;
      if (!declared || (op !== '=' && op !== 'in') || !declared.ops.includes(op)) {
        throw new Refusal(`${resource.name}: the API cannot filter by "${condition.column} ${op}". ${this.offer(resource)}`, {
          columns: [condition.column, ...filterable],
        });
      }
      if (op === '=' && (Array.isArray(condition.value) || condition.value === undefined)) {
        throw new Refusal(`${resource.name}: "${condition.column} =" needs one value.`, { columns: [condition.column] });
      }
      if (op === 'in' && !Array.isArray(condition.value))
        throw new Refusal(`${resource.name}: "${condition.column} in" needs a list.`, { columns: [condition.column] });
      // Two conditions on one parameter would reach the API as one list it may read as "either".
      if (seen.has(condition.column))
        throw new Refusal(`${resource.name} can take ${condition.column} once; combine the values with "in".`, {
          columns: [condition.column],
        });
      seen.add(condition.column);
    }
    return group;
  }

  private sort(resource: HttpResource, orderBy: QueryRequest['orderBy']): string | undefined {
    const order = [...(orderBy ?? [])];
    // The reader breaks ties by the key; an API answers in its own order, so that tiebreak is not something to send.
    if (order.length > 1 && order.at(-1)?.column === resource.key && order.at(-1)?.direction === 'asc') order.pop();
    if (!order.length) return undefined;
    const choices = resource.sort ? `It sorts by ${resource.sort.values.join(', ')}.` : 'It takes no sort.';
    if (order.length > 1 || !resource.sort)
      throw new Refusal(`${resource.name}: the API sorts by one documented value at most. ${choices}`);
    const { column, direction } = order[0];
    const spellings =
      direction === 'asc'
        ? [column, `+${column}`, `${column}:asc`, `${column} asc`, `${column}_asc`]
        : [`-${column}`, `${column}:desc`, `${column} desc`, `${column}_desc`];
    const value = resource.sort.values.find((each) => spellings.includes(each));
    // The documented values stay as the API spells them: they are parameter values, not columns.
    if (value === undefined)
      throw new Refusal(
        `${resource.name}: the API cannot sort by ${column} ${direction === 'asc' ? 'ascending' : 'descending'}. ${choices}`,
        { columns: [column] },
      );
    return value;
  }

  private async page(
    resource: HttpResource,
    query: URLSearchParams,
    limit: number,
    offset: number,
  ): Promise<{ rows: Json[]; sent: URLSearchParams }> {
    const paging = resource.paging;
    switch (paging.kind) {
      case 'none':
        // One response is the whole list; the page is cut from it.
        return { rows: this.rows(resource, await this.get(resource.list, query)).slice(offset, offset + limit), sent: query };
      case 'offset': {
        query.set(paging.offset, String(offset));
        query.set(paging.limit, String(limit));
        return { rows: this.rows(resource, await this.get(resource.list, query)).slice(0, limit), sent: query };
      }
      case 'page': {
        if (offset % limit)
          throw new Refusal(`${resource.name} is paged in whole pages of ${limit}; row ${offset + 1} does not start one.`);
        query.set(paging.page, String(offset / limit + 1));
        query.set(paging.size, String(limit));
        return { rows: this.rows(resource, await this.get(resource.list, query)).slice(0, limit), sent: query };
      }
      case 'cursor': {
        if (offset % limit)
          throw new Refusal(`${resource.name} is paged in whole pages of ${limit}; row ${offset + 1} does not start one.`);
        if (paging.limit) query.set(paging.limit, String(limit));
        const target = offset / limit;
        const walkKey = `${resource.name}?${query}`;
        const walk = this.walks.get(walkKey) ?? [''];
        let index = Math.min(target, walk.length - 1);
        for (let requests = 0; index < target; requests++) {
          if (requests >= MAX_REQUESTS_PER_READ) {
            throw new Refusal(
              `${resource.name} is paged by cursor, and page ${target + 1} is more than ${MAX_REQUESTS_PER_READ} requests away. Filter the list to reach it.`,
            );
          }
          const next = at(await this.get(resource.list, this.withCursor(query, paging.param, walk[index])), paging.next);
          if (typeof next !== 'string' || !next) return { rows: [], sent: query };
          walk[++index] = next;
        }
        this.remember(walkKey, walk);
        const sent = this.withCursor(query, paging.param, walk[target]);
        return { rows: this.rows(resource, await this.get(resource.list, sent)).slice(0, limit), sent };
      }
    }
  }

  private withCursor(query: URLSearchParams, param: string, cursor: string): URLSearchParams {
    const next = new URLSearchParams(query);
    if (cursor) next.set(param, cursor);
    return next;
  }

  private remember(key: string, walk: string[]): void {
    this.walks.delete(key);
    this.walks.set(key, walk);
    if (this.walks.size > REMEMBERED_WALKS) this.walks.delete(this.walks.keys().next().value!);
  }

  private rows(resource: HttpResource, body: unknown): Json[] {
    const found = at(body, resource.rows);
    if (!Array.isArray(found) || !found.every(isObject)) {
      throw new HttpSourceError('shape', `${resource.list} did not answer a list of rows at ${resource.rows || 'its top level'}.`);
    }
    return found;
  }

  private row(resource: HttpResource, raw: unknown, columns: string[]): Json {
    if (!isObject(raw)) throw new HttpSourceError('shape', `${resource.item} did not answer a row.`);
    const out: Json = {};
    for (const name of columns)
      out[name] = cell(
        resource.columns.find((column) => column.name === name)!,
        raw[name],
      );
    return out;
  }

  /** One GET under the base URL. `missing` turns a 404 into "no row" — a record read's answer, never a list's. */
  /* A read the connection opted into caching is answered from the cache while
     its copy is fresh. Only a 2xx is kept, under the URL's path and query
     alone: the credential is the connection's, and so is the cache's prefix.
     A copy that no longer parses is no copy. */
  private async cachedRequest(path: string, query: URLSearchParams): Promise<{ status: number; json: unknown }> {
    const cache = this.connection.cache;
    if (!cache) return this.request(path, query);
    const url = new URL(path.slice(1), this.connection.base);
    url.search = query.toString();
    const key = `${url.pathname}${url.search}`;
    const kept = await cache.store.get(key);
    if (kept !== undefined) {
      try {
        return { status: 200, json: JSON.parse(kept) };
      } catch {
        /* fetch it again */
      }
    }
    const reply = await this.request(path, query);
    if (reply.status >= 200 && reply.status <= 299) await cache.store.set(key, JSON.stringify(reply.json), cache.ttlMs);
    return reply;
  }

  private async get(path: string, query: URLSearchParams, missing = false): Promise<unknown> {
    const reply = await this.cachedRequest(path, query);
    if (reply.status === 404 && missing) return undefined;
    if (reply.status < 200 || reply.status > 299)
      throw new HttpSourceError('status', `GET ${path} answered ${reply.status}.`, reply.status);
    return reply.json;
  }

  /* The one place a request is built: under the base URL, with the credential
     as its one header, and sent through egress. Reads and the explorer's
     operations both come through here, so neither can send what the other
     would not. */
  private async request(path: string, query: URLSearchParams): Promise<{ status: number; json: unknown }> {
    const url = new URL(path.slice(1), this.connection.base);
    url.search = query.toString();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.connection.auth) headers[this.connection.auth.header] = this.connection.auth.value;
    return send(url, headers, this.connection.policy);
  }

  /* What ran, in the place a database shows its SQL: the method, the path and
     the query string — never a header, which is where the credential is. */
  private result(columns: string[], rows: Json[], started: number, path: string, query: URLSearchParams): QueryResult {
    const search = query.toString();
    return {
      columns,
      rows,
      ms: Math.round(performance.now() - started),
      sql: { text: `GET ${path}${search ? `?${search}` : ''}`, params: [] },
    };
  }
}
