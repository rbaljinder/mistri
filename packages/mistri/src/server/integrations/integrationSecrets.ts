/**
 * Integration secrets, sealed before they reach a row: AES-256-GCM under a
 * key derived from `MISTRI_SECRETS_KEY`, bound (as associated data) to
 * the App, the tenant, the integration and the secret's name. A row copied
 * to another tenant, another integration or another name does not open; a
 * database read without the key holds ciphertext alone.
 *
 * The key is read from the environment the deployment captured, per App, as
 * the form key is (forms/formKey.ts), derived per purpose with HKDF, never
 * printed or stored, and kept apart from BETTER_AUTH_SECRET: a deployment
 * that lists integrations and has no key refuses to start rather than keep
 * a secret in the clear. Changing the key makes every saved secret unreadable,
 * so each is entered again; nothing is silently lost.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const SECRETS_KEY_VARIABLE = 'MISTRI_SECRETS_KEY';
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]*)$/;

export class SecretsKeyMissing extends Error {
  constructor() {
    super(
      `The App lists integrations, whose secrets are sealed under ${SECRETS_KEY_VARIABLE}: a secret of at least 32 bytes, ` +
        'kept apart from BETTER_AUTH_SECRET and MISTRI_FORM_KEY. It is read, never printed or stored; changing it ' +
        'means entering every integration secret again.',
    );
    this.name = 'SecretsKeyMissing';
  }
}

const configured = new Map<string, string | undefined>();
const derived = new Map<string, Buffer>();

/** Bind an App's sealing key to the environment its deployment captured. */
export function configureSecretsKey(appId: string, environment: NodeJS.ProcessEnv): () => void {
  const secret = environment[SECRETS_KEY_VARIABLE];
  configured.set(appId, secret);
  return () => {
    if (configured.get(appId) === secret) configured.delete(appId);
  };
}

function secretsKey(appId: string): Buffer {
  const secret = configured.has(appId) ? configured.get(appId) : process.env[SECRETS_KEY_VARIABLE];
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new SecretsKeyMissing();
  let key = derived.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'mistri.integration-secrets', 'sealed-secret.v1', 32));
    if (derived.size > 64) derived.clear();
    derived.set(secret, key);
  }
  return key;
}

/** Whether the deployment can seal: asked at startup, before a settings screen could take a secret it cannot keep. */
export function assertSecretsKey(appId: string): void {
  secretsKey(appId);
}

/** Where a secret belongs: the associated data that binds a sealed value to it. */
interface SecretPlace {
  readonly app: string;
  readonly tenant: string;
  readonly integration: string;
  readonly name: string;
}
const placeOf = (place: SecretPlace) =>
  Buffer.from(JSON.stringify(['mistri.integration-secret.v1', place.app, place.tenant, place.integration, place.name]));

export function sealSecret(place: SecretPlace, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretsKey(place.app), iv);
  cipher.setAAD(placeOf(place));
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${sealed.toString('base64url')}`;
}

/** The secret, or undefined for a value that does not open here (another key, another place, a damaged row). */
export function openSecret(place: SecretPlace, sealed: string): string | undefined {
  const parts = SEALED.exec(sealed);
  if (!parts) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretsKey(place.app), Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(placeOf(place));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof SecretsKeyMissing) throw error;
    return undefined;
  }
}
