/**
 * A SAML 2.0 identity provider in the test's own process: it reads the
 * AuthnRequest a sign-in redirects to, and writes the Response the test
 * describes, signed with xml-crypto under fixed keys (test/fixtures/saml:
 * idp-a, idp-b and a rogue key no provider is configured with).
 *
 * Written here rather than run as a real provider for the same reason as
 * mockOidc.ts: it must issue what a real one never will — an unsigned
 * assertion, a signature by another key, SHA-1, a wrapped or a second
 * assertion, a comment in the NameID, a DOCTYPE — and a Keycloak needs Docker.
 * xml-crypto is the copy samlify itself verifies with, resolved from its place.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';

export interface SamlKeys {
  key: string;
  cert: string;
}
export const samlKeys = (name: 'idp-a' | 'idp-b' | 'rogue'): SamlKeys => ({
  key: readFileSync(new URL(`../fixtures/saml/${name}.key`, import.meta.url), 'utf8'),
  cert: readFileSync(new URL(`../fixtures/saml/${name}.crt`, import.meta.url), 'utf8'),
});

interface SignedXmlLike {
  addReference(options: { xpath: string; transforms: string[]; digestAlgorithm: string }): void;
  computeSignature(xml: string, options: { location: { reference: string; action: string } }): void;
  getSignedXml(): string;
}
const { SignedXml } = createRequire(createRequire(import.meta.resolve('@better-auth/sso')).resolve('samlify'))('xml-crypto') as {
  SignedXml: new (options: Record<string, unknown>) => SignedXmlLike;
};

const SHA256 = { signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', digest: 'http://www.w3.org/2001/04/xmlenc#sha256' };
const SHA1 = { signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', digest: 'http://www.w3.org/2000/09/xmldsig#sha1' };
export const NAME_ID = {
  email: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
};

/** The request a sign-in sent the browser to the provider with. */
export function authnRequestOf(url: string): { id: string; relayState: string; xml: string; location: URL } {
  const location = new URL(url);
  const xml = inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
  return { id: /\sID="([^"]+)"/.exec(xml)?.[1] ?? '', relayState: location.searchParams.get('RelayState') ?? '', xml, location };
}

export interface SamlAnswer {
  issuer: string;
  nameId: string;
  format?: string;
  /** The request answered; absent, an unsolicited response. */
  inResponseTo?: string;
  /** The assertion consumer service it is for: Destination and Recipient. */
  acs: string;
  /** The service provider's entity id: the Audience. */
  audience: string;
  attributes?: Record<string, string | string[]>;
  sessionIndex?: string;
  notBefore?: Date;
  notOnOrAfter?: Date;
  authnContext?: string;
  /** Who signs, and what: the assertion (as providers do), the Response only, or nothing. */
  keys?: SamlKeys;
  sign?: 'assertion' | 'response' | 'none';
  sha1?: true;
  /** Changes made to the XML after it is signed (a comment, a second assertion, a DOCTYPE…). */
  after?: (xml: string) => string;
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const id = () => `_${randomBytes(16).toString('hex')}`;

export function assertionXml(answer: SamlAnswer, assertionId = id()): string {
  const now = Date.now();
  const iso = (at: Date | number) => new Date(at).toISOString();
  const notBefore = answer.notBefore ?? new Date(now - 60_000);
  const notOnOrAfter = answer.notOnOrAfter ?? new Date(now + 300_000);
  const confirm = `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${
    answer.inResponseTo ? ` InResponseTo="${esc(answer.inResponseTo)}"` : ''
  } NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${esc(answer.acs)}"/></saml:SubjectConfirmation>`;
  const attributes = Object.entries(answer.attributes ?? {})
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${esc(name)}">${(Array.isArray(value) ? value : [value])
          .map((one) => `<saml:AttributeValue>${esc(one)}</saml:AttributeValue>`)
          .join('')}</saml:Attribute>`,
    )
    .join('');
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${esc(answer.issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${esc(answer.format ?? NAME_ID.email)}">${esc(answer.nameId)}</saml:NameID>${confirm}</saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notOnOrAfter)}"><saml:AudienceRestriction><saml:Audience>${esc(answer.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${esc(answer.sessionIndex ?? id())}"><saml:AuthnContext><saml:AuthnContextClassRef>${esc(
      answer.authnContext ?? 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
    )}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : '') +
    `</saml:Assertion>`
  );
}

function signed(xml: string, keys: SamlKeys, target: 'Assertion' | 'Response', sha1: boolean): string {
  const algorithms = sha1 ? SHA1 : SHA256;
  const sig = new SignedXml({
    privateKey: keys.key,
    publicCert: keys.cert,
    signatureAlgorithm: algorithms.signature,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: `/*[local-name(.)='Response']${target === 'Assertion' ? "/*[local-name(.)='Assertion']" : ''}`,
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: algorithms.digest,
  });
  sig.computeSignature(xml, {
    location: {
      reference: `/*[local-name(.)='Response']${target === 'Assertion' ? "/*[local-name(.)='Assertion']" : ''}/*[local-name(.)='Issuer']`,
      action: 'after',
    },
  });
  return sig.getSignedXml();
}

/** The Response, as XML. */
export function samlResponseXml(answer: SamlAnswer): string {
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${esc(answer.acs)}"${
      answer.inResponseTo ? ` InResponseTo="${esc(answer.inResponseTo)}"` : ''
    }>` +
    `<saml:Issuer>${esc(answer.issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertionXml(answer) +
    `</samlp:Response>`;
  const how = answer.sign ?? 'assertion';
  const out =
    how === 'none' || !answer.keys ? xml : signed(xml, answer.keys, how === 'assertion' ? 'Assertion' : 'Response', answer.sha1 === true);
  return answer.after ? answer.after(out) : out;
}

/** The Response as the browser posts it: base64. */
export const samlResponse = (answer: SamlAnswer) => Buffer.from(samlResponseXml(answer)).toString('base64');
