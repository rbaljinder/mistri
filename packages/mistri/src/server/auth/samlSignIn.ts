/**
 * Sign-in through a SAML 2.0 identity provider (Okta, Entra ID, ADFS,
 * Google Workspace, OneLogin, Keycloak), each one a config entry of kind
 * "saml" (identityConfig.ts). @better-auth/sso 1.7.2 runs the protocol — the
 * AuthnRequest, the assertion consumer service, the signature, audience,
 * recipient, InResponseTo, timestamp and replay checks — and this file decides
 * everything around it that is mistri's to decide:
 *
 *   - the providers are the config file's, through `defaultSSO`, and nothing
 *     else: the plugin's own table is never made, and every route that would
 *     register, list, change or verify one answers 404 (an allowlist, so a
 *     plugin release that adds a route adds nothing reachable);
 *   - a response is screened before the plugin reads it: at most 128 KiB, no
 *     DOCTYPE (entities), no comment (the NameID truncation class), no CDATA,
 *     no encrypted assertion or NameID (the decryption path is the weakest
 *     dependency, and no SP key is ever configured), no signature or digest
 *     weaker than SHA-256 (the plugin checks a posted one's not at all), and
 *     exactly one Assertion
 *     element, counted with the very xmldom copy samlify verifies the signature
 *     with, so the plugin's fast-xml-parser count and the verifier never read
 *     two different documents;
 *   - who signed in is judged in the plugin's `resolveUser`, inside its
 *     transaction: the NameID and issuer must be the ones in the screened
 *     document, a transient NameID is refused (it would make an account per
 *     sign-in), the address is the configured attribute or an emailAddress
 *     NameID and nothing else, and it is verified only when the config says
 *     the provider asserts verified addresses. What the hooks judge from there
 *     — sign-up, a tenant's domains, linking, roles from attributes — is
 *     identityRoles.ts, as for OpenID Connect.
 *
 * Loaded only by a process that signs people in through a SAML provider, so
 * no other path pays for the package.
 */
import { createRequire } from 'node:module';
import type { AppProvider } from '../../shared/appModel.js';
import { samlServiceProvider, type SamlProviderConfig } from './identityConfig.js';
import type { SignInEvidence } from './identityProviders.js';

const PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const EMAIL_ADDRESS = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
/* The plugin judges a signature's algorithm only where the binding says it
   (a redirect's SigAlg); a posted Response's SHA-1 signature would pass. The
   screen reads every SignatureMethod and DigestMethod in the document. */
const SIGNATURE_METHODS = new Set(
  ['rsa-sha256', 'rsa-sha384', 'rsa-sha512', 'ecdsa-sha256', 'ecdsa-sha384', 'ecdsa-sha512'].map(
    (name) => `http://www.w3.org/2001/04/xmldsig-more#${name}`,
  ),
);
const DIGEST_METHODS = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512',
]);
/** A response larger than this is refused unread (the plugin's own limit is set to the same). */
const MAX_SAML_RESPONSE = 128 * 1024;
/** An attribute name nothing sends: the plugin then takes the address from the NameID, which `resolveUser` judges. */
const NO_ATTRIBUTE = 'urn:mistri:unused';

/** What the screened document's one assertion says, read from the element the signature covers. */
interface SamlFacts {
  issuer: string;
  nameId: string;
  format: string | undefined;
  sessionIndex: string | undefined;
  /** AuthnInstant, in milliseconds. */
  authnInstant: number | undefined;
  authnContext: string | undefined;
}

interface DomNode {
  nodeType: number;
  localName?: string | null;
  namespaceURI?: string | null;
  textContent?: string | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
  getElementsByTagNameNS?(ns: string, name: string): ArrayLike<DomNode>;
}
interface DomDocument extends DomNode {
  documentElement: DomNode | null;
}
/** The slice of @xmldom/xmldom 0.8 this reads. */
interface XmlDom {
  DOMParser: new (options: { errorHandler: Record<'warning' | 'error' | 'fatalError', (message: string) => void> }) => {
    parseFromString(xml: string, type: string): DomDocument;
  };
}

const elements = (node: DomNode) => Array.from(node.childNodes).filter((child) => child.nodeType === 1);
const child = (node: DomNode | undefined, name: string, ns = ASSERTION) =>
  node ? elements(node).filter((el) => el.localName === name && el.namespaceURI === ns) : [];
const count = (doc: DomDocument, name: string) => doc.getElementsByTagNameNS?.('*', name)?.length ?? 0;
const algorithms = (doc: DomDocument, name: string) =>
  Array.from(doc.getElementsByTagNameNS?.(DSIG, name) ?? []).map((el) => el.getAttribute?.('Algorithm') ?? '');

/** The response, screened. A refusal says why for the server's log; the browser is told only that it was refused. */
function screenSamlResponse(raw: unknown, dom: XmlDom): { facts: SamlFacts } | { refused: string } {
  if (typeof raw !== 'string' || !raw) return { refused: 'no SAMLResponse' };
  if (raw.length > MAX_SAML_RESPONSE) return { refused: `the response is larger than ${MAX_SAML_RESPONSE} bytes` };
  const encoded = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return { refused: 'the response is not base64' };
  const xml = Buffer.from(encoded, 'base64').toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { refused: 'the response declares a DOCTYPE' };
  if (xml.includes('<!--')) return { refused: 'the response has a comment' };
  if (xml.includes('<![CDATA[')) return { refused: 'the response has a CDATA section' };
  // One processing instruction, the XML declaration, and only first.
  if (/<\?/.test(xml.replace(/^﻿?\s*<\?xml\s[^?]*\?>/, ''))) return { refused: 'the response has a processing instruction' };
  let doc: DomDocument;
  try {
    const fail = (message: string) => {
      throw new Error(message);
    };
    doc = new dom.DOMParser({ errorHandler: { warning: () => undefined, error: fail, fatalError: fail } }).parseFromString(xml, 'text/xml');
  } catch {
    return { refused: 'the response is not well-formed XML' };
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'Response' || root.namespaceURI !== PROTOCOL) return { refused: 'the document is not a SAML Response' };
  for (const name of ['EncryptedAssertion', 'EncryptedID', 'EncryptedAttribute', 'EncryptedData']) {
    if (count(doc, name)) return { refused: `the response has an ${name}` };
  }
  if (algorithms(doc, 'SignatureMethod').some((uri) => !SIGNATURE_METHODS.has(uri)))
    return { refused: 'a signature is not SHA-256 or stronger' };
  if (algorithms(doc, 'DigestMethod').some((uri) => !DIGEST_METHODS.has(uri))) return { refused: 'a digest is not SHA-256 or stronger' };
  if (count(doc, 'Assertion') !== 1) return { refused: `the response has ${count(doc, 'Assertion')} Assertion elements, not one` };
  const [assertion] = child(root, 'Assertion');
  if (!assertion) return { refused: 'the assertion is not a child of the Response' };
  const issuers = child(assertion, 'Issuer');
  const subjects = child(assertion, 'Subject');
  const names = child(subjects[0], 'NameID');
  if (issuers.length !== 1 || subjects.length !== 1 || names.length !== 1)
    return { refused: 'the assertion has no single Issuer, Subject and NameID' };
  const statements = child(assertion, 'AuthnStatement');
  const statement = statements.length === 1 ? statements[0] : undefined;
  const instant = statement?.getAttribute?.('AuthnInstant');
  const at = instant ? Date.parse(instant) : NaN;
  const classRef = child(child(statement, 'AuthnContext')[0], 'AuthnContextClassRef')[0]?.textContent?.trim();
  return {
    facts: {
      issuer: issuers[0]!.textContent?.trim() ?? '',
      nameId: names[0]!.textContent?.trim() ?? '',
      format: names[0]!.getAttribute?.('Format') || undefined,
      sessionIndex: statement?.getAttribute?.('SessionIndex') || undefined,
      authnInstant: Number.isFinite(at) ? at : undefined,
      authnContext: classRef || undefined,
    },
  };
}

/** The xmldom copy samlify verifies signatures with: resolved from samlify's own place, never ours. */
function samlifyXmlDom(): XmlDom {
  const fromSso = createRequire(import.meta.resolve('@better-auth/sso'));
  return createRequire(fromSso.resolve('samlify'))('@xmldom/xmldom') as XmlDom;
}

type Reject = { action: 'reject'; code: string; message: string };
type Resolution = { action: 'continue' } | { action: 'link'; userId: string; profile: 'preserve' } | Reject;
interface ResolutionInput {
  protocol: string;
  providerId: string;
  accountKey: { issuer: string; accountId: string };
  providerUser: { email?: unknown };
  providerAttributes?: Record<string, string | readonly string[]>;
}
interface Database {
  findOne(query: { model: string; where: Array<{ field: string; value: string }> }): Promise<Record<string, unknown> | null>;
}
interface HookCtx {
  path?: unknown;
  method?: unknown;
  body?: Record<string, unknown> | undefined;
}

/** The address a sign-in may carry: one plain address, or none. */
const addressOf = (value: unknown) =>
  typeof value === 'string' && value.includes('@') && value.length <= 320 && !/[\s\p{Cc}]/u.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;

/**
 * The Better Auth plugin for the App's SAML providers: @better-auth/sso with
 * its schema stripped, closed to everything but sign-in, the service
 * provider's metadata and the assertion consumer service, behind the screen.
 */
export async function samlSignInPlugin(options: {
  configs: readonly SamlProviderConfig[];
  /** The App's address (a reverse proxy's path included): the service provider's side is under it. */
  baseURL: string;
  evidence: WeakMap<object, SignInEvidence>;
  current: () => object | undefined;
  APIError: new (status: string, body: { code: string; message: string }) => Error;
  where: string;
  load: (name: string) => Promise<Record<string, unknown>>;
}) {
  const { configs, evidence, APIError, where } = options;
  let sso: (o: Record<string, unknown>) => Record<string, unknown>;
  let dom: XmlDom;
  try {
    ({ sso } = (await import('@better-auth/sso' as string)) as { sso: typeof sso });
    dom = samlifyXmlDom();
  } catch {
    throw new Error(
      `${where}: a SAML identity provider needs the @better-auth/sso package. Install it with: npm install @better-auth/sso@1.7.2`,
    );
  }
  const { createAuthMiddleware } = (await options.load('better-auth/api')) as unknown as {
    createAuthMiddleware: (handler: (ctx: HookCtx) => Promise<void>) => unknown;
  };
  const byName = new Map(configs.map((config) => [config.name, config]));
  const app = `${options.baseURL.replace(/\/+$/, '')}/`;
  const refuse = (status: string, code: string, message: string): never => {
    throw new APIError(status, { code, message });
  };

  const resolveUser = async (input: ResolutionInput, { database }: { database: Database }): Promise<Resolution> => {
    const reject = (code: string, message: string, why?: string): Reject => {
      console.error(`mistri: ${where}: SAML provider "${input.providerId}" refused a sign-in: ${why ?? message}`);
      return { action: 'reject', code, message };
    };
    const config = byName.get(input.providerId);
    const ctx = options.current() as HookCtx | undefined;
    if (input.protocol !== 'saml' || !config || !ctx)
      return reject('invalid_saml_response', 'This sign-in could not be confirmed.', 'no provider');
    const screened = screenSamlResponse(ctx.body?.SAMLResponse, dom);
    if ('refused' in screened) return reject('invalid_saml_response', 'This sign-in could not be confirmed.', screened.refused);
    const { facts } = screened;
    /* The plugin verified one assertion and read it with its own parser; the
       screen read the same bytes with the verifier's. They must agree on who. */
    if (facts.issuer !== config.entityId || input.accountKey.issuer !== config.entityId || facts.nameId !== input.accountKey.accountId) {
      return reject('invalid_saml_response', 'This sign-in could not be confirmed.', 'the verified assertion and the screened one differ');
    }
    if (!facts.nameId || facts.nameId.length > 255 || /\p{Cc}/u.test(facts.nameId))
      return reject('invalid_saml_response', 'This sign-in could not be confirmed.', 'the NameID is empty or unreadable');
    if (facts.format === TRANSIENT) {
      return reject(
        'saml_transient_name',
        'Your identity provider names you differently at every sign-in, so no account can be yours.',
        'a transient NameID (ask for a persistent or emailAddress one)',
      );
    }
    const attributes = input.providerAttributes ?? {};
    const said = config.attributes?.email ? attributes[config.attributes.email] : facts.format === EMAIL_ADDRESS ? facts.nameId : undefined;
    const email = addressOf(typeof said === 'string' ? said : Array.isArray(said) && said.length === 1 ? said[0] : undefined);
    if (!email) {
      return reject(
        'saml_no_email',
        'Your identity provider did not say your email address.',
        config.attributes?.email
          ? `no single "${config.attributes.email}" attribute`
          : 'no emailAddress NameID, and no "attributes.email" in the config',
      );
    }
    if (input.providerUser.email !== email)
      return reject('invalid_saml_response', 'This sign-in could not be confirmed.', 'the plugin read another address');
    const verified = config.verifiedEmails === true;
    const token: AppProvider = config.tenant === undefined ? `saml:${config.name}` : 'saml:*';
    /* Attributes are the claims a role's `from` reads; the assertion's own
       authentication instant and context stand in for `auth_time` and `acr`. */
    const claims = Object.freeze({
      ...attributes,
      ...(facts.authnInstant !== undefined ? { auth_time: Math.floor(facts.authnInstant / 1000) } : {}),
      ...(facts.authnContext ? { acr: facts.authnContext } : {}),
    });
    evidence.set(ctx, {
      provider: config,
      token,
      claims,
      email,
      emailVerified: verified,
      issuer: config.entityId,
      subject: facts.nameId,
      ...(facts.sessionIndex ? { sessionIndex: facts.sessionIndex } : {}),
    });
    /* Better Auth links an existing account only for a verified address, and
       the plugin never says one is: a provider the config trusts for verified
       addresses links to the account that has it (identityRoles.ts ends what
       an unproven account held first). */
    if (verified) {
      const owned = await database.findOne({
        model: 'account',
        // Better Auth keys an account by its provider and the provider's id for the person (1.7.3; the issuer key is gone).
        where: [
          { field: 'providerId', value: config.name },
          { field: 'accountId', value: facts.nameId },
        ],
      });
      if (!owned) {
        const user = await database.findOne({ model: 'user', where: [{ field: 'email', value: email }] });
        if (user && typeof user.id === 'string') return { action: 'link', userId: user.id, profile: 'preserve' };
      }
    }
    return { action: 'continue' };
  };

  const plugin = sso({
    defaultSSO: configs.map((config) => {
      const sp = samlServiceProvider(options.baseURL, config.name);
      return {
        providerId: config.name,
        // Sign-in names its provider; finding one by an email's domain is the work-email screen's (auth.ts homeRealm).
        domain: `${config.name}.invalid`,
        samlConfig: {
          issuer: sp.entityId,
          entryPoint: config.ssoUrl,
          cert: [...config.certificates],
          callbackUrl: app,
          idpMetadata: {
            entityID: config.entityId,
            cert: [...config.certificates],
            singleSignOnService: [{ Binding: REDIRECT_BINDING, Location: config.ssoUrl }],
          },
          wantAssertionsSigned: true,
          authnRequestsSigned: false,
          mapping: {
            email: config.attributes?.email ?? NO_ATTRIBUTE,
            name: config.attributes?.name ?? 'displayName',
            ...(config.attributes?.name ? { firstName: NO_ATTRIBUTE, lastName: NO_ATTRIBUTE } : {}),
          },
        },
      };
    }),
    saml: {
      enableInResponseToValidation: true,
      allowIdpInitiated: false,
      requireTimestamps: true,
      clockSkew: 60_000,
      algorithms: { onDeprecated: 'reject' },
      maxResponseSize: MAX_SAML_RESPONSE,
      enableSingleLogout: false,
    },
    providersLimit: 0,
    resolveUser,
  });
  const { schema: _schema, ...rest } = plugin as { schema?: unknown; hooks?: { before?: unknown[]; after?: unknown[] } };
  const sign = (ctx: HookCtx) => {
    const body = ctx.body ?? {};
    if (Object.keys(body).some((key) => !['providerId', 'callbackURL', 'errorCallbackURL'].includes(key)))
      refuse('BAD_REQUEST', 'invalid_request', 'A SAML sign-in names its provider and where to come back to, nothing else.');
    if (typeof body.providerId !== 'string' || !byName.has(body.providerId)) refuse('NOT_FOUND', 'not_found', 'No such identity provider.');
    if (typeof body.callbackURL !== 'string') refuse('BAD_REQUEST', 'invalid_request', 'A SAML sign-in needs a callbackURL.');
  };
  const consume = (ctx: HookCtx) => {
    const body = ctx.body ?? {};
    if (Object.keys(body).some((key) => key !== 'SAMLResponse' && key !== 'RelayState'))
      refuse('BAD_REQUEST', 'invalid_saml_response', 'This sign-in could not be confirmed.');
    const screened = screenSamlResponse(body.SAMLResponse, dom);
    if ('refused' in screened) {
      console.error(`mistri: ${where}: a SAML response was refused unread: ${screened.refused}.`);
      refuse('BAD_REQUEST', 'invalid_saml_response', 'This sign-in could not be confirmed.');
    }
  };
  return {
    ...rest,
    /* Every route the plugin has but these three answers 404, and these only
       for a provider the config file names: the plugin would otherwise look
       an unknown one up in its own table, which this store never has. */
    onRequest: async (request: Request, context: { baseURL: string }) => {
      const prefix = new URL(context.baseURL).pathname.replace(/\/+$/, '');
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${prefix}/`)) return undefined;
      const path = url.pathname.slice(prefix.length);
      const notFound = { response: new Response('Not Found', { status: 404 }) };
      if (path === '/sign-in/sso') return request.method === 'POST' ? undefined : notFound;
      if (!path.startsWith('/sso/') && path !== '/sso') return undefined;
      const acs = /^\/sso\/saml2\/sp\/acs\/([a-z][a-z0-9-]{0,39})$/.exec(path);
      if (acs && byName.has(acs[1]!) && request.method === 'POST' && !url.search) return undefined;
      const keys = [...url.searchParams.keys()];
      if (
        path === '/sso/saml2/sp/metadata' &&
        request.method === 'GET' &&
        keys.length === 1 &&
        keys[0] === 'providerId' &&
        byName.has(url.searchParams.get('providerId')!)
      )
        return undefined;
      return notFound;
    },
    hooks: {
      ...rest.hooks,
      before: [
        ...(rest.hooks?.before ?? []),
        {
          matcher: (ctx: HookCtx) =>
            ctx.path === '/sign-in/sso' || (typeof ctx.path === 'string' && ctx.path.startsWith('/sso/saml2/sp/acs/')),
          handler: createAuthMiddleware(async (ctx) => (ctx.path === '/sign-in/sso' ? sign(ctx) : consume(ctx))),
        },
      ],
    },
  };
}

/** Paths Better Auth answers 404 before routing: the plugin's registration and management, its OIDC side, and SAML logout. */
export const SAML_DISABLED_PATHS = [
  '/sso/register',
  '/sso/update-provider',
  '/sso/delete-provider',
  '/sso/get-provider',
  '/sso/providers',
  '/sso/request-domain-verification',
  '/sso/verify-domain',
  '/sso/callback',
];
