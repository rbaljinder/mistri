/**
 * What one request carries through the route modules: the parameters
 * `handle` was called with, the copies it takes, and what the auth gate
 * established. Built once per request in handler.ts after the gate; every
 * route module reads it and none writes to it, with the one exception
 * documented on `configPages`.
 */
import type { AddressMount } from '../../shared/mount.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Adapter } from '../../adapters/adapter.js';
import type { Registry } from '../connections.js';
import type { ViewDef } from '../../shared/view.js';
import type { SavedQuery } from '../../shared/sqlsaved.js';
import type { PageDef } from '../../shared/page.js';
import type { ConfigLayout } from '../../shared/recordview.js';
import type { DatabaseSchema } from '../../shared/schema.js';
import type { QueryPerson } from '../../shared/query.js';
import type { ColumnGrant } from '../columnGrants.js';
import type { RequestDiagnostics } from '../operations/diagnostics.js';
import type { Bound } from './trust.js';

/**
 * The App framework's types for what a request carries on its behalf: the
 * Apps it serves, an App's resources and its reader's grants, its commands,
 * its row policy, its job host. The engine's routes pass them along and ask
 * no more of them than the readings below; the App framework registers its
 * own types by declaring this interface's members (http/appContext.ts), as
 * a library registers its types with a router. Unregistered — the engine on
 * its own, or the database browser — each is the engine's reading.
 *
 * @public read by declaration merging, which no import shows
 */
export interface Register {}

type Registered<Key extends string, Engine> = Register extends { readonly [K in Key]: infer T } ? T : Engine;

/** An App a request may be on (app/apps.ts AppHost): the engine's routes only count them and pass them on. */
type HostedApp = Registered<'host', object>;
/** An App's resources (app/appRuntimeResources.ts): the engine asks only which connection a table is in, and its adapter. */
type SourceResources = Registered<'resources', { connectionFor(table: string): string; forConnection(connection: string): Adapter }>;
/** A reader's grants on an App's resources (app/appAccess.ts): the columns, and the fixed actions that admit an update. */
type SourceAccess = Registered<'access', ColumnGrant & { readonly actions?: ReadonlyMap<string, unknown> }>;

/** Who is asking: the proxy header's answer, then the session's when there is one. */
/** Who is asking. `name` is the verified session's own name, for a greeting only. */
export interface Identity {
  id?: string;
  who?: string;
  role?: string;
  name?: string;
  refusal?: string;
  emailVerified?: true;
  /** Open sign-up, email not yet proven: the address names nobody (auth.ts Identity). */
  emailUnproven?: true;
}

/** Who a revalidated reply is for (reply.ts sendRevalidated): the verified
 * account, its roles and the name a proxy or session gave it. */
export function principalOf(identity: Identity): string {
  return JSON.stringify([identity.id ?? null, identity.role ?? null, identity.who ?? null]);
}

/**
 * A request's target as the browser sent it, base path and all, where the
 * server took the base off (server.ts `routeAddress`): Better Auth routes and
 * mints its links from the whole address.
 */
export const arrivedUrls = new WeakMap<IncomingMessage, string>();

/** What the gate reads: settled before it runs, in handler.ts. */
export interface GateInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly path: string;
  readonly bound: Bound;
  readonly appHosts?: HostedApp[];
  /** Where the Apps are served and under what path (shared/mount.ts); `path` is already its inside form. */
  readonly mount: AddressMount;
  readonly commandRequest: boolean;
  /** Answer a business-command request with the failure shape its client reads. */
  readonly commandRefusal: (code: Registered<'refusal', string>) => void;
}

/** What the gate establishes when it lets a request through. */
export interface GateResult {
  readonly identity: Identity;
  /** The one App host that signs people in, when there is one. */
  readonly signedIn?: HostedApp;
  readonly hostingError?: string;
}

export interface RequestContext extends GateInput, GateResult {
  readonly url: URL;
  readonly registry: Registry;
  readonly configViews: ViewDef[];
  /** The file this session read its connections from, and writes them back to. */
  readonly configPath?: string;
  readonly configQueries: SavedQuery[];
  /**
   * Mutable, on purpose: `resolveSource` narrows it to the pages an
   * access-controlled App's field grants allow, and handlePost then reads the
   * narrowed list. That was a reassigned local before the split; it is the
   * one field a route writes.
   */
  configPages: PageDef[];
  readonly configLayouts: ConfigLayout[];
  readonly commands?: Registered<'commands', unknown>;
  readonly policy?: Registered<'policy', unknown>;
  /** True, or what to tell a caller, while the row policy is not serving (cli/serve.ts). */
  readonly policyUnavailable: boolean | string;
  readonly diagnostics?: RequestDiagnostics;
  /** The `--jobs` host, when the deployment runs one. */
  readonly jobs?: Registered<'jobs', unknown>;
  /** Whether the browser on this listener is the operator — see `clientTrusted`. */
  readonly trusted: boolean;
  readonly appConfigured: boolean;
  /** The row-policy context this dispatch runs under, when the deployment has one. */
  readonly policyContext?: Registered<'policyContext', unknown>;
}

/** A request past the gate, before the row policy's context (handler.ts `door`). */
export type GatedContext = Omit<RequestContext, 'policyContext'>;

/**
 * One browser connection or App entry point, resolved for the request in
 * hand. `publicScope` and `publicDefinition` are the reply-shaping half: an
 * App answer names the app, a connection answer names the connection, and a
 * definition's connection — a view's `connection`, a page's `connection` — never
 * leaves an App server.
 */
export interface ResolvedSource {
  readonly adapter: Adapter;
  readonly schema: DatabaseSchema;
  readonly resources?: SourceResources;
  readonly access?: SourceAccess;
  readonly wholeRowWrites?: ReadonlySet<string>;
  readonly selectedHost?: HostedApp;
  readonly connectionId: string;
  readonly publicScope: { appId: string } | { connection: string };
  readonly publicDefinition: <T extends { connection?: string }>(definition: T) => T;
  /** Who `me` is for this request, through the reader it is given (server/app/appMe.ts). */
  readonly person?: (reader: Adapter) => Promise<QueryPerson>;
  /** This reader's zone, where `ui.timezone` reads one (readerZone.ts); read through `appZone`. */
  readonly zone?: string;
  /** This reader's locale, resolved once (readerLocale.ts `requestLocale`): their words and figures. */
  readonly locale?: string;
  /** Their tenant's own words over the App's (recordMessages.ts), stamped by tenant and content: `localizedApp`'s key. */
  readonly messages?: { readonly stamp: string; readonly words: Registered<'messages', unknown> };
}

/**
 * What a POST route reads: the body, already parsed once, and the source
 * the body named. Built where the body is read (handler.ts `postRoute`), once per reply.
 */
export interface PostContext {
  readonly res: ServerResponse;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly adapter: Adapter;
  readonly schema: DatabaseSchema;
  readonly registry: Registry;
  readonly connection: string;
  readonly configPages: PageDef[];
  readonly appHosts?: HostedApp[];
  /** Who is asking, when a proxy header or a session says; stamped on every journaled write. */
  readonly who?: string;
  /** Their role, when a session says; the write scope may be the role's. */
  readonly role?: string;
  readonly resources?: SourceResources;
  readonly access?: SourceAccess;
  readonly principal?: string;
  /** Whose notices this request reads: the signed-in account's email, where it names someone (signedInAs). */
  readonly recipient?: string;
  readonly wholeRowWrites?: ReadonlySet<string>;
  readonly rowPolicy: boolean;
  readonly appConfigured: boolean;
  /** "Now" for date phrases, in the app's zone — see `appNowFor`. */
  readonly appNow: () => Date;
  /** This reader's zone, where `ui.timezone` reads one (readerZone.ts). */
  readonly zone?: string;
  /** The App the request names, where it names one. */
  readonly appHost?: HostedApp;
  /** Who `me` is in an App's conditions, read through this request's reader (server/app/appMe.ts). */
  readonly me?: () => Promise<QueryPerson>;
}
