/**
 * Tenant branding, the engine-neutral half of its store: what is kept for
 * each tenant of an App — the value a tenant admin saved (already validated
 * by packages/mistri/src/shared/tenantBranding.ts, kept as its JSON text) and the logo it
 * names, by content hash — and the bounds every engine holds them to.
 *
 * Kept in reserved `__mistri_branding_*` tables beside the App's records,
 * provisioned once by maintenance and attested at startup like the inbox: a
 * deployment that declares `branding` and holds no store refuses to start,
 * naming the call that provisions it.
 *
 * A logo is addressed by the sha256 of its served bytes, so a new logo is a
 * new address and an old one may be cached forever; a save removes the logos
 * of its App that no tenant's value names any more, in the same transaction.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';

export const BRANDING_VERSION = 1;
export const BRANDING_PREFIX = '__mistri_branding_';
export const BRANDING_TABLES = Object.freeze({
  meta: `${BRANDING_PREFIX}meta`,
  value: `${BRANDING_PREFIX}value`,
  logo: `${BRANDING_PREFIX}logo`,
});

/** Bounds, the same on every engine. A logo's are brandingLogo.ts's, the larger of raster and SVG. */
export const BRANDING_LIMITS = Object.freeze({
  app: 128,
  tenant: 128,
  value: 8192,
  by: 1024,
  logo: 256 * 1024,
});

/** One tenant's branding in one App. */
export interface BrandingQuery {
  readonly app: string;
  readonly tenant: string;
}
export interface StoredBranding {
  /** The validated value as JSON text (TenantBrandingValue). Parsed again on every read. */
  readonly value: string;
  /** 1 on the first save, one more on each after it. */
  readonly revision: number;
  readonly by: string;
  readonly at: string;
}
interface BrandingLogo {
  readonly hash: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}
/** A save: the value, the logo it names (null for none), and that logo's bytes when they are new. */
export interface BrandingWrite extends BrandingQuery {
  readonly value: string;
  readonly logoHash: string | null;
  readonly logo?: BrandingLogo;
  /** The dark logo, as the light one: named in the value (`logoDark`, which keeps its bytes stored), with its bytes when new. */
  readonly darkLogo?: BrandingLogo;
  readonly by: string;
  readonly at: string;
}
export interface BrandingLogoQuery {
  readonly app: string;
  readonly hash: string;
}
export interface StoredBrandingLogo {
  readonly type: string;
  readonly bytes: Uint8Array;
}

export class BrandingUnavailable extends Refusal {
  constructor(
    message = 'The branding store is missing or is not the layout this version expects. It is provisioned once, never on ' +
      "startup: run provisionStores({ sqlite: path } or { postgres: url }, { only: ['branding'] }) from @mistriwork/mistri/maintenance against the " +
      "App's database, then start again. A foreign layout is refused, not altered.",
  ) {
    super(message);
    this.name = 'BrandingUnavailable';
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/;
const HASH = /^[0-9a-f]{64}$/;
const LOGO_TYPE = /^image\/(png|jpeg|webp|gif|svg\+xml)$/;
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

function text(value: unknown, limit: number, what: string, pattern?: RegExp): asserts value is string {
  if (typeof value !== 'string' || !value || bytes(value) > limit || (pattern && !pattern.test(value)))
    throw new Refusal(`Branding: ${what} is not valid.`);
}

export function assertBrandingQuery(query: unknown): asserts query is BrandingQuery {
  const value = query as BrandingQuery;
  if (!value || typeof value !== 'object') throw new Refusal('Branding: a query names an App and a tenant.');
  text(value.app, BRANDING_LIMITS.app, 'the App', IDENTIFIER);
  text(value.tenant, BRANDING_LIMITS.tenant, 'the tenant', IDENTIFIER);
}

export function assertBrandingLogoQuery(query: unknown): asserts query is BrandingLogoQuery {
  const value = query as BrandingLogoQuery;
  if (!value || typeof value !== 'object') throw new Refusal('Branding: a logo is named by its App and hash.');
  text(value.app, BRANDING_LIMITS.app, 'the App', IDENTIFIER);
  text(value.hash, 64, 'the logo hash', HASH);
}

export function assertBrandingWrite(write: unknown): asserts write is BrandingWrite {
  assertBrandingQuery(write);
  const value = write as BrandingWrite;
  text(value.value, BRANDING_LIMITS.value, 'the value');
  try {
    JSON.parse(value.value);
  } catch {
    throw new Refusal('Branding: the value is not JSON.');
  }
  text(value.by, BRANDING_LIMITS.by, 'who saved it');
  text(value.at, 64, 'when it was saved');
  if (value.logoHash !== null) text(value.logoHash, 64, 'the logo hash', HASH);
  if (value.logo !== undefined) {
    const logo = value.logo;
    text(logo.hash, 64, 'the logo hash', HASH);
    text(logo.type, 32, 'the logo type', LOGO_TYPE);
    if (!(logo.bytes instanceof Uint8Array) || !logo.bytes.length || logo.bytes.length > BRANDING_LIMITS.logo)
      throw new Refusal('Branding: the logo is empty or too large.');
    if (logo.hash !== value.logoHash) throw new Refusal('Branding: a new logo must be the one the value names.');
  }
  if (value.darkLogo !== undefined) {
    const logo = value.darkLogo;
    text(logo.hash, 64, 'the dark logo hash', HASH);
    text(logo.type, 32, 'the dark logo type', LOGO_TYPE);
    if (!(logo.bytes instanceof Uint8Array) || !logo.bytes.length || logo.bytes.length > BRANDING_LIMITS.logo)
      throw new Refusal('Branding: the dark logo is empty or too large.');
    if ((JSON.parse(value.value) as { logoDark?: { hash?: unknown } }).logoDark?.hash !== logo.hash)
      throw new Refusal('Branding: a new dark logo must be the one the value names.');
  }
}
