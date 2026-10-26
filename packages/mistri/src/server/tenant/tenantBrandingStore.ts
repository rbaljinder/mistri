/**
 * Branding on a tenant App: the store a tenant admin's saved branding is kept
 * in, attested on the deployment's writer before it is published. A database
 * without the store refuses startup, naming the call that provisions it.
 */
import { BrandingUnavailable } from '../../adapters/branding/branding.js';
import { storesOf } from '../stores/appStores.js';

interface BrandingStoreAdapter {
  brandingReady(): Promise<boolean>;
}

/* `adapter` is the deployment's writer: a dialect adapter, whose App stores answer (stores/appStores.ts), or a store that answers itself. */
export async function bindTenantBrandingStore(adapter: object, dialect: 'sqlite' | 'postgres'): Promise<void> {
  if (await (storesOf(adapter) as BrandingStoreAdapter).brandingReady()) return;
  const call = `provisionStores({ ${dialect === 'sqlite' ? 'sqlite: path' : 'postgres: url'} }, { only: ['branding'] })`;
  throw new BrandingUnavailable(
    `This tenant App declares branding, and its database holds no branding store. ` +
      `It is provisioned once, never on startup: run ${call} from @mistriwork/mistri/maintenance against the App's own database, then start again.`,
  );
}
