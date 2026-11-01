/**
 * A Typesense client, over egress.
 *
 * Search is an index, never a source of truth: it holds a copy of the fields
 * a resource declares searchable, keyed by the record's primary key, and
 * answers a phrase with keys — the rows themselves are re-read from the
 * database under the reader's own grants. Every request goes through egress
 * (egress.ts), so the service is reached under the same address policy,
 * deadline and byte cap as any API, and a failure is a `SearchUnavailable`
 * whose message names the service and never its key.
 *
 * It is core's `SearchIndex` (packages/mistri/src/server/app/searchProvider.ts), and nothing
 * of Typesense's own shape leaves this file: a tenant's scope becomes a
 * `filter_by` here, not in core.
 */
import { request, HttpSourceError, type EgressPolicy, type EgressReply } from '../../../packages/engine/src/adapters/http/egress.js';
import {
  SearchUnavailable,
  type SearchDocument,
  type SearchIndex,
  type SearchScope,
} from '../../../packages/mistri/src/server/app/searchProvider.js';

interface TypesenseConnection {
  /** Ends in "/". */
  base: URL;
  label: string;
  apiKey?: string;
  policy: EgressPolicy;
  /** Default `tablewalk`. */
  collectionPrefix?: string;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class TypesenseClient implements SearchIndex {
  constructor(private readonly connection: TypesenseConnection) {}

  get label(): string {
    return this.connection.label;
  }

  get collectionPrefix(): string {
    return this.connection.collectionPrefix ?? 'mistri';
  }

  /**
   * The collection exists and indexes every declared field. Created when
   * missing; a field added to the declaration is added to the collection.
   * Each field is optional text: a record with an empty value is still found
   * by its other fields.
   */
  async ensureCollection(name: string, fields: readonly string[]): Promise<void> {
    const found = await this.call('GET', `collections/${encodeURIComponent(name)}`);
    if (found.status === 404) {
      const created = await this.call('POST', 'collections', undefined, {
        name,
        fields: fields.map((field) => ({ name: field, type: 'string', optional: true })),
      });
      // Another instance may have created it a moment earlier.
      if (created.status === 409) return;
      this.expect(created, `create the collection "${name}"`);
      return;
    }
    this.expect(found, `read the collection "${name}"`);
    const have = new Set(((found.json as { fields?: Array<{ name?: string }> })?.fields ?? []).map((field) => field.name));
    const missing = fields.filter((field) => !have.has(field));
    if (missing.length) {
      this.expect(
        await this.call('PATCH', `collections/${encodeURIComponent(name)}`, undefined, {
          fields: missing.map((field) => ({ name: field, type: 'string', optional: true })),
        }),
        `add ${missing.join(', ')} to the collection "${name}"`,
      );
    }
  }

  async upsert(collection: string, document: SearchDocument): Promise<void> {
    const reply = await this.call(
      'POST',
      `collections/${encodeURIComponent(collection)}/documents`,
      new URLSearchParams({ action: 'upsert' }),
      document,
    );
    this.expect(reply, `index a record in "${collection}"`);
  }

  /** Gone from the index; a document that was never there is gone already. With `scope`, only if it is that tenant's (a delete by filter, so it is one step). */
  async remove(collection: string, id: string, scope?: SearchScope): Promise<void> {
    if (scope) {
      if (id.includes('`')) throw new SearchUnavailable('the record cannot be named to the engine.');
      const query = new URLSearchParams({ filter_by: `id:=\`${id}\` && ${filterBy(scope)}` });
      const scoped = await this.call('DELETE', `collections/${encodeURIComponent(collection)}/documents`, query);
      if (scoped.status === 404) return;
      this.expect(scoped, `remove a record from "${collection}"`);
      return;
    }
    const reply = await this.call('DELETE', `collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`);
    if (reply.status === 404) return;
    this.expect(reply, `remove a record from "${collection}"`);
  }

  /** The keys of the best matches for `phrase` across `fields`, best first;
   * with `scope`, only among the documents it admits (a tenant's). */
  async search(collection: string, phrase: string, fields: readonly string[], limit: number, scope?: SearchScope): Promise<string[]> {
    const query = new URLSearchParams({
      q: phrase,
      query_by: fields.join(','),
      per_page: String(Math.max(1, Math.min(limit, 250))),
      include_fields: 'id',
      ...(scope ? { filter_by: filterBy(scope) } : {}),
    });
    const reply = await this.call('GET', `collections/${encodeURIComponent(collection)}/documents/search`, query);
    // A collection nobody has indexed yet matches nothing; the reindex command fills it.
    if (reply.status === 404) return [];
    this.expect(reply, `search "${collection}"`);
    const hits = (reply.json as { hits?: Array<{ document?: { id?: unknown } }> })?.hits;
    if (!Array.isArray(hits)) throw new SearchUnavailable(`search "${this.connection.label}" answered a search in an unexpected shape.`);
    return hits.map((hit) => hit.document?.id).filter((id): id is string => typeof id === 'string');
  }

  /** Whether the service answers at all. */
  async health(): Promise<boolean> {
    try {
      return (await this.call('GET', 'health')).status === 200;
    } catch {
      return false;
    }
  }

  private async call(method: Method, path: string, query?: URLSearchParams, body?: unknown): Promise<EgressReply> {
    const url = new URL(path, this.connection.base);
    if (query) url.search = query.toString();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.connection.apiKey) headers['x-typesense-api-key'] = this.connection.apiKey;
    try {
      return await request(url, { method, headers, ...(body === undefined ? {} : { body }) }, this.connection.policy);
    } catch (error) {
      throw new SearchUnavailable(
        `search "${this.connection.label}": ${error instanceof HttpSourceError ? error.message : 'the request failed.'}`,
      );
    }
  }

  private expect(reply: EgressReply, doing: string): void {
    if (reply.status >= 200 && reply.status <= 299) return;
    const why = reply.status === 401 || reply.status === 403 ? " (check the connection's apiKey)" : '';
    throw new SearchUnavailable(`search "${this.connection.label}" could not ${doing}: it answered ${reply.status}${why}.`);
  }
}

/* A scope as Typesense's exact match. Tenant ids are identifiers (evidence.ts),
   so a backtick never needs escaping; one that had one would be refused rather than quoted. */
function filterBy(scope: SearchScope): string {
  if (/[`]/.test(scope.value) || !/^\w+$/.test(scope.field)) throw new SearchUnavailable('the tenant cannot be named to the engine.');
  return `${scope.field}:=\`${scope.value}\``;
}
