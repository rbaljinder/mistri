import { shell } from './shellMode.js';
import { say } from './copy/shell/requestIdentity.js';

let appConfigured: boolean | null = false;

/** An invalid server contract is a startup failure, not an offline database. */
export class RuntimeMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeMetadataError';
  }
}

/**
 * The address names no App this server serves: `/helpdesk` on a server whose
 * one App is at `/help-desk`. A reader's typo or a stale link, not an outage —
 * the screen says which Apps are here rather than blaming the database.
 */
export class UnknownAppError extends Error {
  constructor(
    readonly requested: string,
    readonly apps: ReadonlyArray<{ id: string; name: string }>,
  ) {
    super(say('noApp', { requested }));
    this.name = 'UnknownAppError';
  }
}

/** Listener identity, independent of the App/Workbench presentation toggle. */
export function setAppRequestScope(configured: boolean | null): void {
  appConfigured = configured;
}

export const appRequestScope = (): boolean | null => appConfigured;

/* A tenant App's visitor's public address (addressMount.js keepPlacement): every
   request carries it, for it alone places the visitor's reads with a tenant. */
let placement: string | null = null;
export function setPublicPlacement(via: string | null): void {
  placement = via;
}

/** The one selector this listener's server reads: `app` on an App server, `conn` in the explorer. */
const ownerField = (): 'app' | 'conn' => (appConfigured ? 'app' : 'conn');

/**
 * A request's owner, under the selector the listener reads. Callers capture
 * the owner when their work starts — an App ID on an App listener, a registry
 * ID in the explorer — so an async draft, preview or cached read stays with
 * the source it began on. An absent owner leaves the active one to the
 * transport.
 */
export function ownedBy(owner: string | null | undefined): Record<string, string> {
  return owner == null ? {} : { [ownerField()]: owner };
}

export function scopeApiRequest(
  path: string,
  body: Record<string, unknown> | undefined,
  active: string | null | undefined,
): { url: string; payload: Record<string, unknown> | undefined } {
  const url = new URL(path, 'http://mistri.invalid');
  if (url.pathname === '/api/whoami') {
    if (
      url.searchParams.getAll('app').length > 1 ||
      url.searchParams.getAll('via').length > 1 ||
      [...url.searchParams.keys()].some((key) => key !== 'app' && key !== 'via')
    )
      throw new Error(say('invalidAuthenticationRequestIdentity'));
    return { url: `${url.pathname}${url.search}`, payload: body };
  }
  if (url.pathname === '/api/runtime')
    return { url: placement ? `${url.pathname}?via=${encodeURIComponent(placement)}` : url.pathname, payload: body };
  if (/^\/api\/connections(?:\/|$)/.test(url.pathname)) {
    if (appConfigured !== false) throw new Error(say('databaseConnectionManagementIsUnavailable'));
    return { url: path, payload: body };
  }
  if (appConfigured === null) throw new Error(say('common.applicationRuntimeIsUnavailable'));

  const field = ownerField();
  // As the server does: an App request names an app, never a connection.
  if (appConfigured && (url.searchParams.has('conn') || body?.conn !== undefined)) throw new Error(say('applicationRequestsIdentifyAnApp'));
  const owners = [...url.searchParams.getAll(field), ...(body?.[field] == null ? [] : [body[field]])];
  if (owners.some((owner) => typeof owner !== 'string' || !owner.trim())) throw new Error(say('invalidRequestIdentity', { field }));
  const distinct = [...new Set(owners as string[])];
  if (distinct.length > 1) throw new Error(say(appConfigured ? 'twoDifferentApplications' : 'twoDifferentConnections'));
  const owner = distinct[0] ?? active;
  let payload = body;
  if (owner) {
    // Commands fingerprint a strict envelope; routing identity belongs to the URL.
    if (appConfigured && url.pathname.startsWith('/api/commands/')) {
      url.searchParams.set('app', owner);
      if (payload) {
        const { app: _app, ...envelope } = payload;
        payload = envelope;
      }
    } else if (payload) payload = { ...payload, [field]: owner };
    else url.searchParams.set(field, owner);
  }
  // Only on a visitor's read, as the shell names them: every other API route refuses an address (server tenantAuthenticatedHttp.ts).
  if (placement && shell().publicRead(url.pathname)) url.searchParams.set('via', placement);
  return { url: `${url.pathname}${url.search}${url.hash}`, payload };
}
