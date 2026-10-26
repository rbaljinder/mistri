/** This owner has no database or membership capability. Each request lends it
 * an authorized reader, which must retain its normal release/revocation fences. */
import {
  bindRecordBranding,
  compileBranding,
  fallbackBranding,
  type BrandingBinding,
  type BrandingCatalog,
  type BrandingSelection,
  type BrandingSourceIdentity,
  type ResolvedBranding,
} from '../../shared/branding.js';

interface BrandingReadRequest {
  readonly resource: string;
  readonly columns: readonly string[];
  readonly where: { readonly column: string; readonly value: string };
  readonly limit: 2;
}
/** Return up to two matching rows through the current principal's scoped
 * reader, or null for denial. Must throw on query failure/truncation that could
 * hide ambiguity. Neither this callback nor a host selector supplies a grant.
 * Public calls must use the public grant, even if the visitor has a session. */
export type AuthorizedBrandingReader = (request: BrandingReadRequest) => Promise<readonly Readonly<Record<string, unknown>>[] | null>;
interface RecordBrandingRequest {
  /** Host-mapped or membership-selected intent, as the binding's `by` declares.
   * An owner must reject conflicting host/URL selections before calling. */
  readonly tenant: string | null;
  readonly public: boolean;
  readonly read: AuthorizedBrandingReader;
}
export interface RecordBrandingReader {
  resolve(request: RecordBrandingRequest): Promise<ResolvedBranding>;
  /** Stop new reads and discard cached compilations; in-flight calls fall back. */
  close(): void;
  readonly cacheSize: number;
}
interface RecordBrandingOptions {
  readonly spec: unknown;
  readonly catalog: BrandingCatalog;
  readonly identity: BrandingSourceIdentity;
  /** Maximum successful compiled records retained, default 128, maximum 4096. */
  readonly capacity?: number;
}

/** Read and check authorization, cardinality, tenant, version and publication
 * on EVERY request. Only pure compilation is cached, never a read decision. */
export function createRecordBrandingReader(options: RecordBrandingOptions): RecordBrandingReader {
  const binding: BrandingBinding = bindRecordBranding(options.spec, options.catalog);
  const identity: BrandingSourceIdentity = Object.freeze({
    deployment: options.identity.deployment,
    app: options.identity.app,
    source: options.identity.source,
    bindingRevision: options.identity.bindingRevision,
    catalogRevision: options.identity.catalogRevision,
  });
  if (
    Object.values(identity).some(
      // eslint-disable-next-line no-control-regex -- Cache-owner identifiers must exclude ASCII controls.
      (value) => typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value),
    )
  ) {
    throw new Error('Branding needs an explicit deployment/App/source and binding/catalog revision.');
  }
  const capacity = options.capacity ?? 128;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error('Invalid branding cache capacity.');
  const cache = new Map<string, { row: string; value: ResolvedBranding }>();
  let closed = false;
  return Object.freeze({
    get cacheSize() {
      return cache.size;
    },
    close() {
      closed = true;
      cache.clear();
    },
    async resolve(request: RecordBrandingRequest): Promise<ResolvedBranding> {
      const tenant = typeof request.tenant === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(request.tenant) ? request.tenant : null;
      const publicly = request.public,
        read = request.read;
      const selection: BrandingSelection = { ...identity, tenant };
      const fallback = (code: 'closed' | 'unavailable' | 'unpublished') =>
        fallbackBranding(binding, selection, [{ code, message: code === 'closed' ? 'Branding is closed.' : 'Branding is unavailable.' }]);
      if (closed) return fallback('closed');
      if (!tenant || typeof publicly !== 'boolean' || typeof read !== 'function') return fallback('unavailable');
      try {
        const query: BrandingReadRequest = Object.freeze({
          resource: binding.spec.from,
          columns: binding.columns,
          where: Object.freeze({ column: binding.spec.tenantField, value: tenant }),
          limit: 2,
        });
        const rows = await read(query);
        if (closed) return fallback('closed');
        if (!Array.isArray(rows) || rows.length !== 1) return fallback('unavailable');
        // Copy only own data properties: a reader's mutable row cannot change
        // publication or the cached compilation after this synchronous capture.
        const input = rows[0];
        if (!input || typeof input !== 'object') return fallback('unavailable');
        const row: Record<string, unknown> = Object.create(null);
        for (const column of binding.columns) {
          const property = Object.getOwnPropertyDescriptor(input, column);
          if (!property || !('value' in property)) return fallback('unavailable');
          row[column] = property.value;
        }
        if (row[binding.spec.tenantField] !== tenant) return fallback('unavailable');
        // A public binding without an explicit publication field fails closed.
        if (publicly && (!binding.spec.publishedField || row[binding.spec.publishedField] !== true)) return fallback('unpublished');
        if (
          Object.values(row).some(
            (value) =>
              value !== null &&
              (!['string', 'number', 'boolean'].includes(typeof value) ||
                (typeof value === 'number' && !Number.isFinite(value)) ||
                (typeof value === 'string' && value.length > 8192)),
          )
        )
          return fallback('unavailable');
        const key = binding.primaryKey.map((column) => [column, row[column]]);
        const version = row.version;
        const cacheKey = JSON.stringify([
          identity.deployment,
          identity.app,
          identity.source,
          identity.bindingRevision,
          identity.catalogRevision,
          tenant,
          key,
          typeof version,
          version,
        ]);
        // Also compare the freshly read values. A broken/out-of-band writer
        // that forgot its version bump must not resurrect a cached valid look.
        // Only scalar columns are accepted; no toJSON/getter is ever executed.
        const fingerprint = JSON.stringify(row);
        const hit = cache.get(cacheKey);
        if (hit && hit.row === fingerprint) {
          cache.delete(cacheKey);
          cache.set(cacheKey, hit);
          return hit.value;
        }
        const compiled = compileBranding(binding, row, selection);
        cache.delete(cacheKey);
        if (compiled.status === 'resolved') {
          cache.set(cacheKey, { row: fingerprint, value: compiled });
          if (cache.size > capacity) cache.delete(cache.keys().next().value!);
        }
        return compiled;
      } catch {
        return fallback(closed ? 'closed' : 'unavailable');
      }
    },
  });
}
