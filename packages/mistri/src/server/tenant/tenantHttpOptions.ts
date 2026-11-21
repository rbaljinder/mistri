/**
 * What the tenant data server (tenantHttp.ts) is given: the App, the enrollment it serves, and each optional service
 * the host composes beside it. Types only; apart so the server's own file holds its routes.
 */
import type { IncomingMessage } from 'node:http';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import type { AppDef } from '../../shared/app.js';
import type { VerifiedSessionInstance } from '../auth/auth.js';
import type { PageLoader } from '../commands/pageLoaders.js';
import type { TenantDomainsService } from '../http/customDomains.js';
import type { TenantBrandingService } from './tenantBranding.js';
import type { TenantEnrollment } from './tenantEnrollment.js';
import type { TenantIntegrations } from './tenantIntegrations.js';
import type { TenantLook } from './tenantLook.js';
import type { TenantPreferences } from './tenantPreferences.js';
import type { TenantReadsService } from './tenantReadsRoute.js';
import type { TenantSearch } from './tenantSearch.js';
import type { TenantSupport } from './tenantSupportOperations.js';
import type { TenantTokenService } from './tenantTokenService.js';

export interface TenantHttpOptions {
  readonly app: AppDef;
  /** The look a save changed in place (tenantLook.ts, G175): worn by the App payload, never by its authority. */
  readonly look?: () => TenantLook | undefined;
  readonly enrollment: TenantEnrollment<IncomingMessage>;
  readonly verifySessionInstance: (request: IncomingMessage) => VerifiedSessionInstance | null | Promise<VerifiedSessionInstance | null>;
  readonly bound: Bound;
  /** The host's support owner: its routes and the support lease's fence. */
  readonly support?: TenantSupport;
  /** Where each of the App's compiled custom components is served (appComponents.ts componentHrefs): code, never a row. */
  readonly components?: Readonly<Record<string, { kind: string; href: string; css?: string }>>;
  /** A member's own App API tokens (tenantTokenService.ts), when the App declares an `api`. */
  readonly tokens?: TenantTokenService;
  /** The App's search (tenantSearch.ts): a context's reader made searchable within its tenant. */
  readonly search?: Pick<TenantSearch, 'reader'>;
  /** Each tenant's branding (tenantBranding.ts), when the App declares `branding`. */
  readonly branding?: TenantBrandingService;
  /** The tenant's custom domains (http/customDomains.ts), when the suite configures `customDomains`. */
  readonly domains?: TenantDomainsService;
  /** The tenant's read audit for its own admins (tenantReadsRoute.ts), when a resource audits its reads and the App
      names admins (domains or branding editors). */
  readonly reads?: TenantReadsService;
  /** The integrations' settings screen (tenantIntegrations.ts), when the jobs module lists integrations. */
  readonly integrations?: NonNullable<TenantIntegrations['settings']>;
  /** Whether a tenant has the App's assistant (tenantAssistant.ts): its switch is on and a model is set up. */
  readonly assistant?: { offered(tenantId: string): Promise<boolean> };
  /** The verified reader's own name, for a dashboard that greets `{me.name}` (appGreeting.ts): words on a
      screen, never an authority. Absent, or saying nothing, the greeting is left out. */
  readonly readerName?: (req: IncomingMessage) => string | undefined;
  /** The free-form pages' loaders, by name: the commands module's `loaders` (commands/pageLoaders.ts). */
  readonly loaders?: Readonly<Record<string, PageLoader>>;
  /** Whether this request's login was made here in the last five minutes, by the rule opening a support session
      keeps (nativeSignInAge.ts): what issuing an API token asks. Absent, no token is issued. */
  readonly recentSignIn?: (req: IncomingMessage) => Promise<boolean>;
  /** The path of the source App this host serves while its author works on it (cli/tenant.ts authoringApp): a command's
      refusal then tells its cause to a reader on this machine, as the ordinary server's does (refusalReport.ts). Absent
      for a build, which is served as built. */
  readonly authoring?: string;
  /** A command answer with each capability link it minted rendered as its URL, for the member's own tenant
      (tenantLinks.ts rendered), when the App declares links. Absent, a reference stays `mistri-link:<id>.<seal>`. */
  readonly renderLinks?: (value: unknown, tenantId: string) => Promise<unknown>;
  /** Where a member's App-wide picks are kept (tenantPreferences.ts), when the App declares `choose`: the preferences
      store beside the tenant source, or undefined where it holds none (the picks then stay in the browser). */
  readonly preferences?: TenantPreferences;
}
