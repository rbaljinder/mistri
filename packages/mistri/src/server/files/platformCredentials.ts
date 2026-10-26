/**
 * Bucket credentials the platform hands a process instead of an operator
 * pasting keys: the ECS task role (a container-credentials endpoint named by
 * AWS_CONTAINER_CREDENTIALS_RELATIVE_URI or _FULL_URI) and the EC2 instance
 * role (IMDSv2). Both answer the same JSON, temporary and expiring, so one
 * source holds the current credentials and fetches new ones shortly before
 * they lapse; a request never waits on a refresh while the old ones still
 * hold. Static MISTRI_S3_* keys are read first and never reach here.
 *
 * ECS is recognised by its variables, which only a task has. IMDS is asked
 * only when MISTRI_S3_INSTANCE_ROLE=1, because on any other host the
 * link-local address does not answer and every first upload would wait out a
 * timeout to learn that.
 */
import type { SigningCredentials } from './sigv4.js';
import { readFileSync } from 'node:fs';

export const INSTANCE_ROLE_VARIABLE = 'MISTRI_S3_INSTANCE_ROLE';

/** Fetch new credentials this long before the old ones expire, so a signature never straddles the end. */
const REFRESH_BEFORE_MS = 5 * 60_000;
const ASK_TIMEOUT_MS = 2_000;
const ECS_HOST = 'http://169.254.170.2';
const IMDS_HOST = 'http://169.254.169.254';

type CredentialSource = () => Promise<SigningCredentials>;

interface Issued extends SigningCredentials {
  readonly expiresAt: number;
}

/** Whether the environment names a platform credential endpoint. */
export function platformCredentialsNamed(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    environment.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
    environment[INSTANCE_ROLE_VARIABLE] === '1',
  );
}

async function ask(fetcher: typeof fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`${what} could not be reached: ${(error as Error).message}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${what} answered ${response.status}`);
  }
  return response;
}

function issued(body: unknown, what: string): Issued {
  const found = body as { AccessKeyId?: unknown; SecretAccessKey?: unknown; Token?: unknown; Expiration?: unknown } | null;
  if (typeof found?.AccessKeyId !== 'string' || typeof found.SecretAccessKey !== 'string')
    throw new Error(`${what} answered without credentials`);
  const expiresAt = typeof found.Expiration === 'string' ? Date.parse(found.Expiration) : Number.NaN;
  return {
    accessKeyId: found.AccessKeyId,
    secretAccessKey: found.SecretAccessKey,
    ...(typeof found.Token === 'string' && found.Token ? { sessionToken: found.Token } : {}),
    // No usable expiry: treat as short-lived so the next request asks again rather than signing with stale keys.
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

function containerFetch(environment: NodeJS.ProcessEnv, fetcher: typeof fetch): () => Promise<Issued> {
  const url = environment.AWS_CONTAINER_CREDENTIALS_FULL_URI || `${ECS_HOST}${environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
  return async () => {
    // The token is re-read each time: the agent rotates the file.
    const file = environment.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
    const token = file ? readFileSync(file, 'utf8').trim() : environment.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    const response = await ask(fetcher, url, { headers: token ? { authorization: token } : {} }, 'The container credentials endpoint');
    return issued(await response.json(), 'The container credentials endpoint');
  };
}

function instanceFetch(environment: NodeJS.ProcessEnv, fetcher: typeof fetch): () => Promise<Issued> {
  const host = (environment.AWS_EC2_METADATA_SERVICE_ENDPOINT || IMDS_HOST).replace(/\/$/, '');
  return async () => {
    const what = 'The instance metadata service';
    const token = await (
      await ask(fetcher, `${host}/latest/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' } }, what)
    ).text();
    const headers = { 'x-aws-ec2-metadata-token': token };
    const base = `${host}/latest/meta-data/iam/security-credentials/`;
    const role = (await (await ask(fetcher, base, { headers }, what)).text()).split('\n')[0].trim();
    if (!role) throw new Error(`${what} has no role attached to this instance`);
    return issued(await (await ask(fetcher, `${base}${encodeURIComponent(role)}`, { headers }, what)).json(), what);
  };
}

/**
 * The credentials a platform provides, or undefined when the environment
 * names none. The result is called for every request and answers from memory
 * until the credentials are within five minutes of expiring.
 */
export function platformCredentials(
  environment: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
): CredentialSource | undefined {
  const fetchNew =
    environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || environment.AWS_CONTAINER_CREDENTIALS_FULL_URI
      ? containerFetch(environment, fetcher)
      : environment[INSTANCE_ROLE_VARIABLE] === '1'
        ? instanceFetch(environment, fetcher)
        : undefined;
  if (!fetchNew) return undefined;
  let current: Issued | undefined;
  let pending: Promise<Issued> | undefined;
  return async () => {
    if (current && current.expiresAt - clock() > REFRESH_BEFORE_MS) return current;
    // One refresh at a time: concurrent requests share it rather than each asking.
    pending ??= fetchNew()
      .then((fresh) => (current = fresh))
      .finally(() => (pending = undefined));
    try {
      return await pending;
    } catch (error) {
      // A failed refresh is survivable while the old credentials have not actually lapsed.
      if (current && current.expiresAt > clock()) return current;
      throw error;
    }
  };
}
