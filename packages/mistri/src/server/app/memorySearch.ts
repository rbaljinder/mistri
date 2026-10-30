/**
 * The built-in search provider: an index in memory, for an App that wants
 * search without an external engine. It implements the same seam as the
 * packs (searchProvider.ts) — ensureCollection, upsert, remove, search —
 * and nothing else: no network, no vendor, no config. Its limits are
 * stated, not hidden: the index lives in this process only, so a restart
 * empties it until the next `mistri --reindex` (or the next write to each
 * record, which the runtime re-indexes), and it suits the moderate
 * tables Mistri's home turf holds, not a large catalog — that is what
 * the Typesense pack is for. Ranking is deliberately simple and stable:
 * a whole-phrase hit beats a word hit, an earlier declared field beats a
 * later one, and ties fall to the key, so two runs over the same index
 * answer in the same order.
 *
 * An App asks for it by naming the connection `memory` in its resource's
 * `search` block. Any other connection still needs a plugged-in provider,
 * and an App that declares search through a connection no provider has
 * is still refused at startup (appSearchRuntime.ts).
 */
import type { SearchDocument, SearchIndex, SearchProvider, SearchScope } from './searchProvider.js';

/** The connection name that asks for this provider. */
export const MEMORY_SEARCH_CONNECTION = 'memory';

class MemorySearchIndex implements SearchIndex {
  readonly collectionPrefix = 'memory';
  private readonly collections = new Map<string, { fields: Set<string>; docs: Map<string, SearchDocument> }>();

  async ensureCollection(name: string, fields: readonly string[]): Promise<void> {
    const existing = this.collections.get(name);
    if (existing) {
      for (const field of fields) existing.fields.add(field);
      return;
    }
    this.collections.set(name, { fields: new Set(fields), docs: new Map() });
  }

  async upsert(collection: string, document: SearchDocument): Promise<void> {
    const target = this.collections.get(collection);
    if (!target) {
      this.collections.set(collection, {
        fields: new Set(Object.keys(document).filter((key) => key !== 'id')),
        docs: new Map([[document.id, document]]),
      });
      return;
    }
    target.docs.set(document.id, document);
  }

  async remove(collection: string, id: string): Promise<void> {
    this.collections.get(collection)?.docs.delete(id);
  }

  async search(collection: string, phrase: string, fields: readonly string[], limit: number, scope?: SearchScope): Promise<string[]> {
    const target = this.collections.get(collection);
    if (!target) return [];
    const needle = phrase.trim().toLowerCase();
    if (!needle) return [];
    const words = needle.split(/\s+/);
    const scored: Array<{ id: string; score: number }> = [];
    for (const document of target.docs.values()) {
      if (scope && document[scope.field] !== scope.value) continue;
      let score = 0;
      for (const [i, field] of fields.entries()) {
        const text = (document[field] ?? '').toLowerCase();
        if (!text) continue;
        const weight = fields.length - i;
        if (text.includes(needle)) score += 10 * weight;
        if (text.startsWith(needle)) score += 2 * weight;
        for (const word of words) if (text.includes(word)) score += 3 * weight;
      }
      if (score > 0) scored.push({ id: document.id, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return scored.slice(0, limit).map((entry) => entry.id);
  }
}

/** The provider, one index shared by every App in this process: collection names already carry the App and resource. */
export const memorySearchProvider: SearchProvider = {
  index(connection: string): SearchIndex | undefined {
    return connection === MEMORY_SEARCH_CONNECTION ? memorySearchIndex : undefined;
  },
};

const memorySearchIndex = new MemorySearchIndex();
