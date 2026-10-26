/**
 * A tenant's branding, served: read from the deployment's branding store
 * (adapters/branding), kept in the shared cache so every instance answers from
 * the same copy, dropped from it on a save so every instance reads the new one
 * on its next page, and dressed as the presentation the shell, the sign-in page
 * and a public form already wear (http/recordBranding.ts, appTheme.js).
 *
 * A save is the one door in: the value is checked field by field and by the
 * theme validator (shared/tenantBranding.ts), the logo by its bytes
 * (brandingLogo.ts), and only then written. What a reader receives is compiled
 * again from the stored value on every cache miss; a stored value that no
 * longer parses (the App narrowed `allow`) is the App's own brand, never an
 * error page.
 */
import type { CacheStore } from '@mistriwork/engine/adapters/cache/cacheStore.js';
import type {
  BrandingLogoQuery,
  BrandingQuery,
  BrandingWrite,
  StoredBranding,
  StoredBrandingLogo,
} from '../../adapters/branding/branding.js';
import type { AppDef } from '../../shared/app.js';
import { tenantBrandingPresentation } from '../../shared/branding.js';
import {
  audienceBranding,
  BrandingRefused,
  parseTenantBranding,
  tenantTheme,
  validateTenantBranding,
  type BrandingDeclaration,
  type TenantBrandingValue,
} from '../../shared/tenantBranding.js';
import type { BrandingPresentation } from '../http/recordBranding.js';
import type { MailBrand } from '../email/mailLinkPage.js';
import { admitLogo, imageHeaders, LogoRefused, type AdmittedLogo } from '../app/brandImage.js';

/** The deployment's store, as its facade lends it (tenantDeployment.ts). */
interface TenantBrandingStore {
  read(query: BrandingQuery): Promise<StoredBranding | null>;
  logo(query: BrandingLogoQuery): Promise<StoredBrandingLogo | null>;
  write(write: BrandingWrite): Promise<number>;
}

/** Where a logo is served: on the App's own origin, under its API, by content hash. */
export const BRANDING_LOGO_PATH = '/api/branding/logo/';
const brandingLogoAddress = (hash: string) => `${BRANDING_LOGO_PATH}${hash}`;

/**
 * How a logo is served: as the type its bytes were sniffed as, never guessed again by the browser, cached for
 * good (a new logo is a new address), and, opened on its own, a sandboxed document that runs nothing.
 */
export function brandingLogoHeaders(logo: StoredBrandingLogo): Record<string, string> {
  return imageHeaders(logo.type, logo.bytes.byteLength);
}

/* Five minutes: a save drops the copy at once; this only bounds a copy whose drop was lost. */
const TTL_MS = 5 * 60_000;
/* A raster logo at its bound, as base64 — what the save's body may carry beside the value. */
const LOGO_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

interface TenantBrandingState {
  readonly value: TenantBrandingValue;
  readonly revision: number;
}

export interface TenantBrandingService {
  readonly declaration: BrandingDeclaration;
  /** The tenant's look and name for the page, or undefined for the App's own. Never throws. */
  /** `public`: a signed-out visitor's page; `roles`: the account's, for the theme `ui.theme.for` dresses it in. */
  presentation(
    tenant: string,
    options?: { readonly private?: boolean; readonly public?: boolean; readonly roles?: readonly string[] },
  ): Promise<BrandingPresentation | undefined>;
  /** The saved value and its revision (0: never saved), for the Branding block. */
  state(tenant: string): Promise<TenantBrandingState>;
  /** Check everything, then write. Throws BrandingRefused or LogoRefused with the sentence to show. */
  save(tenant: string, input: { value: unknown; logo?: unknown; darkLogo?: unknown }, by: string): Promise<TenantBrandingState>;
  logo(hash: string): Promise<StoredBrandingLogo | null>;
  /** The tenant's name, logo and accent as mail wears them (the App's own where it saved none). Never throws. */
  mail(tenant: string): Promise<MailBrand>;
}

export function createTenantBrandingService(options: {
  readonly app: AppDef;
  readonly store: TenantBrandingStore;
  readonly cache: CacheStore;
  readonly now?: () => number;
}): TenantBrandingService {
  const { app, store, cache } = options;
  const declaration = app.branding;
  if (!declaration) throw new Error('Branding is served only for an App that declares it.');
  const now = options.now ?? Date.now;
  const key = (tenant: string) => `tw:branding:${app.id}:${tenant}`;

  /** The stored value, parsed against today's declaration; a value it no longer admits is none. */
  const load = async (tenant: string): Promise<TenantBrandingState> => {
    let stored: { value: string; revision: number } | null = null;
    try {
      const cached = await cache.get(key(tenant));
      if (cached !== undefined) stored = JSON.parse(cached) as { value: string; revision: number } | null;
    } catch {
      stored = null;
    }
    if (stored === null) {
      const row = await store.read({ app: app.id, tenant });
      stored = row ? { value: row.value, revision: row.revision } : { value: '{}', revision: 0 };
      void cache.set(key(tenant), JSON.stringify(stored), TTL_MS).catch(() => {});
    }
    try {
      return { value: parseTenantBranding(JSON.parse(stored.value), declaration), revision: stored.revision };
    } catch {
      return { value: {}, revision: stored.revision };
    }
  };

  return Object.freeze({
    declaration,
    /** `public`: a signed-out visitor's page; `roles`: the account's, for the theme `ui.theme.for` dresses it in. */
    async presentation(tenant: string, presentationOptions: { private?: boolean; public?: boolean; roles?: readonly string[] } = {}) {
      try {
        const { value: saved, revision } = await load(tenant);
        if (!revision || !Object.keys(saved).length) return undefined;
        const worn = audienceBranding(declaration, saved, { public: presentationOptions.public, roles: presentationOptions.roles });
        const value = worn.value;
        const theme = tenantTheme(worn.declaration, value);
        const privately = presentationOptions.private !== false;
        return Object.freeze({
          value: tenantBrandingPresentation({
            selection: {
              deployment: app.id,
              app: app.id,
              source: 'tenant-branding',
              bindingRevision: String(revision),
              catalogRevision: 'tenant-branding',
              tenant,
            },
            revision: String(revision),
            theme,
            ...(value.name ? { name: value.name } : {}),
            ...(value.logo ? { mark: brandingLogoAddress(value.logo.hash) } : {}),
            ...(value.logo && value.logoDark ? { darkMark: brandingLogoAddress(value.logoDark.hash) } : {}),
          }),
          private: privately,
          readerPicker: privately,
        });
      } catch {
        return undefined;
      }
    },
    state: load,
    async save(tenant: string, input: { value: unknown; logo?: unknown; darkLogo?: unknown }, by: string) {
      /* The dark logo is admitted as the light one is; `null` removes it, absent keeps the stored one. */
      const admit = (upload: unknown): AdmittedLogo | undefined => {
        if (typeof upload === 'string') {
          if (upload.length > 360_000 || !LOGO_BASE64.test(upload))
            throw new LogoRefused('This logo could not be read. Choose the file again.');
          return admitLogo(Buffer.from(upload, 'base64'));
        }
        if (upload !== undefined && upload !== null) throw new LogoRefused('This logo could not be read. Choose the file again.');
        return undefined;
      };
      const admitted = admit(input.logo);
      const admittedDark = admit(input.darkLogo);
      const raw =
        input.value && typeof input.value === 'object' && !Array.isArray(input.value) ? { ...(input.value as object) } : input.value;
      if (raw && typeof raw === 'object') {
        const fields = raw as Record<string, unknown>;
        // The logo is the upload's or the stored one, never a hash the body names.
        delete fields.logo;
        delete fields.logoDark;
        const current = input.logo === null && input.darkLogo === null ? undefined : (await load(tenant)).value;
        if (admitted) fields.logo = { hash: admitted.hash, type: admitted.type };
        else if (input.logo !== null && current?.logo) fields.logo = current.logo;
        // A dark logo belongs to a logo: with none, there is nothing for it to stand in for.
        if (fields.logo) {
          if (admittedDark) fields.logoDark = { hash: admittedDark.hash, type: admittedDark.type };
          else if (input.darkLogo !== null && current?.logoDark) fields.logoDark = current.logoDark;
        }
      }
      let value: TenantBrandingValue;
      try {
        value = validateTenantBranding(raw, declaration);
      } catch (error) {
        if (error instanceof BrandingRefused) throw error;
        throw new BrandingRefused([{ field: 'name', message: 'This branding could not be read.' }]);
      }
      const revision = await store.write({
        app: app.id,
        tenant,
        value: JSON.stringify(value),
        logoHash: value.logo?.hash ?? null,
        ...(admitted ? { logo: { hash: admitted.hash, type: admitted.type, bytes: admitted.bytes } } : {}),
        ...(admittedDark && value.logoDark
          ? { darkLogo: { hash: admittedDark.hash, type: admittedDark.type, bytes: admittedDark.bytes } }
          : {}),
        by,
        at: new Date(now()).toISOString(),
      });
      // Every instance reads the new value on its next page: the copy they share is gone.
      await cache.delete(key(tenant)).catch(() => {});
      return { value, revision };
    },
    logo: (hash: string) => store.logo({ app: app.id, hash }),
    async mail(tenant: string) {
      let value: TenantBrandingValue = {};
      try {
        value = (await load(tenant)).value;
      } catch {
        value = {};
      }
      const theme = tenantTheme(declaration, value);
      /* The words on a button are the ground they would sit on, as the shell's primary button draws them. */
      return Object.freeze({
        name: value.name ?? app.name,
        ...(value.logo ? { logo: brandingLogoAddress(value.logo.hash) } : {}),
        light: { accent: theme.light.accent, onAccent: theme.light.surface },
        dark: { accent: theme.dark.accent, onAccent: theme.dark.surface },
      });
    },
  });
}
