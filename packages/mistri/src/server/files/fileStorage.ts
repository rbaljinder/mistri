/**
 * Where a file resource's bytes are kept: in its `content` column (the
 * database, the default) or in an S3-compatible bucket, the row then holding
 * the object's key in its `object` column and null in `content`.
 *
 * The row decides a read: one that names an object is read from the bucket,
 * one that does not from `content`, whatever `storage` says today. So a
 * resource whose `storage` changes keeps serving every file while
 * `mistri migrate files up` moves the rest, and that move can stop and
 * start again anywhere.
 *
 * `storage` decides a write. An upload's bytes are put in the bucket before
 * the row is written, under a key no one has used (a random id), and the row
 * then names it: a committed row never names an object that is not there.
 * A write that then fails deletes the object at once; one whose outcome is
 * unknown leaves it (the row may hold it), and `mistri migrate files
 * sweep` removes what no row names. The sweep is also how a deleted record's
 * object goes — a delete through the App, a cascade in the database or a
 * retention job alike — because it is the one place that sees them all.
 *
 * Keys are laid out `<prefix><app>/<tenant>/<resource>/<id>`, `-` for the
 * tenant of an App without tenants, the resource by its name in the App so
 * the layout does not move with the table it binds. A read accepts only a
 * key under the reader's own App, tenant and resource, so a row that names another's object —
 * written by hand, or by a writer who learned the key — reads as no file.
 *
 * The credentials are the server's: MISTRI_S3_ACCESS_KEY_ID and
 * MISTRI_S3_SECRET_ACCESS_KEY (and MISTRI_S3_SESSION_TOKEN for
 * temporary ones), read when a bucket is first used, and they win when set.
 * Without them an ECS task role or an EC2 instance role supplies temporary
 * ones (platformCredentials.ts). App source holds the bucket's address only;
 * it reaches every browser, a credential must not.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isTenantApp, type AppDef, type AppFileBucket, type AppFileRule } from '../../shared/app.js';
import { TransactionOutcomeUnknown } from '@mistriwork/engine/adapters/adapter.js';
import { serverRequest } from '@mistriwork/engine/server/serverRequests.js';
import { Bucket, BucketError, type BucketCredentials } from './bucket.js';
import { INSTANCE_ROLE_VARIABLE, platformCredentials, platformCredentialsNamed } from './platformCredentials.js';

/** Whose files: the App, and the tenant of a tenant App (`anyTenant` for its platform realm, which reads across them). */
export interface FileScope {
  readonly app: string;
  readonly tenant?: string;
  readonly anyTenant?: boolean;
}

export const S3_CREDENTIAL_VARIABLES = {
  accessKeyId: 'MISTRI_S3_ACCESS_KEY_ID',
  secretAccessKey: 'MISTRI_S3_SECRET_ACCESS_KEY',
  sessionToken: 'MISTRI_S3_SESSION_TOKEN',
} as const;

/** The bucket cannot be used: no credentials, or none named. Said to the operator; a reader is told less. */
class FileStorageUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileStorageUnavailable';
  }
}

const opened = new Map<string, Bucket>();

const noCredentials = (files: string, bucket: string) =>
  `The files of ${files} are kept in the bucket "${bucket}", and this server has no credentials for it: ` +
  `set ${S3_CREDENTIAL_VARIABLES.accessKeyId} and ${S3_CREDENTIAL_VARIABLES.secretAccessKey} in its environment ` +
  `(and ${S3_CREDENTIAL_VARIABLES.sessionToken} for temporary ones), or run it with an ECS task role ` +
  `(AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) or, on EC2, set ${INSTANCE_ROLE_VARIABLE}=1.`;

/** Every file resource of these Apps that names a bucket, whatever its `storage`: a row may name an object in it. */
export function bucketResources(apps: readonly AppDef[]): { app: AppDef; resource: string; bucket: AppFileBucket }[] {
  return apps.flatMap((app) =>
    Object.entries(app.resources ?? {}).flatMap(([resource, block]) =>
      block.file?.bucket ? [{ app, resource, bucket: block.file.bucket }] : [],
    ),
  );
}

/**
 * Why a server serving these Apps cannot start: a bucket and no credentials
 * for it. Said before the first request, as a missing MISTRI_SECRETS_KEY
 * is, rather than as a 503 on the first upload.
 */
export function bucketCredentialsProblem(apps: readonly AppDef[], environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = bucketResources(apps);
  if (
    !named.length ||
    (environment[S3_CREDENTIAL_VARIABLES.accessKeyId] && environment[S3_CREDENTIAL_VARIABLES.secretAccessKey]) ||
    platformCredentialsNamed(environment)
  )
    return undefined;
  const files = named.map(({ app, resource }) => (apps.length > 1 ? `${app.id}'s ${resource}` : resource)).join(', ');
  return noCredentials(files, [...new Set(named.map(({ bucket }) => bucket.name))].join('", "'));
}

/**
 * The startup lines for Apps whose buckets this server does not sweep: one
 * served without jobs. With jobs the server sweeps each day itself — an App
 * without tenants in one run, a tenant App one run per tenant.
 */
export function unsweptBuckets(apps: readonly AppDef[], swept: boolean): string[] {
  if (swept) return [];
  return apps.flatMap((app) => {
    const tenant = isTenantApp(app);
    const named = bucketResources([app]);
    if (!named.length) return [];
    const buckets = [...new Set(named.map(({ bucket }) => `"${bucket.name}"`))].join(', ');
    return [
      `${app.id} keeps files in the bucket ${buckets}, and nothing in this server sweeps it of objects no row names ` +
        `(deleted records', refused uploads'): run \`mistri migrate files sweep --app <dir>${tenant ? ' --policy <file>' : ''}\` daily` +
        `, or serve it with jobs, which sweep it each day${tenant ? ', tenant by tenant' : ''}.`,
    ];
  });
}

/**
 * Ask each bucket once, at startup, for one key under its App's prefix, and
 * warn where one does not answer: the server still starts — a bucket can come
 * back — but the operator hears why uploads will fail before a reader does.
 */
export async function probeBuckets(apps: readonly AppDef[], warn: (line: string) => void = (line) => console.warn(line)): Promise<void> {
  const asked = new Set<string>();
  await Promise.all(
    bucketResources(apps).map(async ({ app, resource, bucket }) => {
      const prefix = appPrefix(bucket, app.id);
      const id = JSON.stringify([bucket.endpoint ?? '', bucket.region ?? '', bucket.name, prefix]);
      if (asked.has(id)) return;
      asked.add(id);
      try {
        await bucketOf({ resource, bucket }).list(prefix, undefined, 1);
      } catch (error) {
        warn(
          `mistri: warning: the bucket "${bucket.name}" did not answer (${(error as Error).message}); files of ${resource} cannot be stored or read until it does.`,
        );
      }
    }),
  );
}

/** The bucket a file resource names, signed with the server's credentials. */
export function bucketOf(rule: Pick<AppFileRule, 'resource' | 'bucket'>, environment: NodeJS.ProcessEnv = process.env): Bucket {
  const location = rule.bucket;
  if (!location) throw new FileStorageUnavailable(`${rule.resource} names no bucket.`);
  const accessKeyId = environment[S3_CREDENTIAL_VARIABLES.accessKeyId];
  const secretAccessKey = environment[S3_CREDENTIAL_VARIABLES.secretAccessKey];
  const sessionToken = environment[S3_CREDENTIAL_VARIABLES.sessionToken] || undefined;
  const fixed = Boolean(accessKeyId && secretAccessKey);
  const platform = fixed ? undefined : platformCredentials(environment);
  if (!fixed && !platform) throw new FileStorageUnavailable(noCredentials(rule.resource, location.name));
  // Remembered by address and a hash of the credentials, so rotated credentials make a new client. A platform source
  // is keyed by where it asks instead: it renews itself, and a new client per call would forget what it had fetched.
  const id = createHash('sha256')
    .update(
      JSON.stringify([
        location.name,
        location.region,
        location.endpoint,
        location.pathStyle,
        ...(fixed
          ? [accessKeyId, secretAccessKey, sessionToken]
          : [
              environment.AWS_CONTAINER_CREDENTIALS_FULL_URI,
              environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
              environment[INSTANCE_ROLE_VARIABLE],
              environment.AWS_EC2_METADATA_SERVICE_ENDPOINT,
            ]),
      ]),
    )
    .digest('hex');
  let bucket = opened.get(id);
  if (!bucket) {
    if (opened.size > 64) opened.clear();
    const credentials: BucketCredentials = fixed
      ? { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, ...(sessionToken ? { sessionToken } : {}) }
      : platform!;
    bucket = new Bucket(location, credentials);
    opened.set(id, bucket);
  }
  return bucket;
}

/* A segment never adds a level: a tenant id or resource name with a slash in it is
   still one segment, so no name can reach into another's prefix. Nor does it take
   one away: `.` and `..` survive encodeURIComponent, and the bucket's URL would
   resolve them, so a tenant named `..` would file its objects above its App's
   prefix. They are spelled with their dots escaped, a name of their own. */
const segment = (value: string) => (value === '.' || value === '..' ? value.replaceAll('.', '%2E') : encodeURIComponent(value));
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every key of one App's files in a bucket begins with this. */
export function appPrefix(bucket: AppFileBucket, app: string): string {
  return `${bucket.prefix ?? ''}${segment(app)}/`;
}

/** The prefix of one resource's files for one tenant (or the App's, without tenants). */
export function resourcePrefix(rule: Pick<AppFileRule, 'resource'> & { bucket: AppFileBucket }, scope: FileScope): string {
  return `${appPrefix(rule.bucket, scope.app)}${scope.tenant === undefined ? '-' : segment(scope.tenant)}/${segment(rule.resource)}/`;
}

/** A new object's key: the scope's prefix and an id never used before. */
export function newObjectKey(rule: Pick<AppFileRule, 'resource'> & { bucket: AppFileBucket }, scope: FileScope): string {
  return `${resourcePrefix(rule, scope)}${randomUUID()}`;
}

/** Whether a key a row names is one this reader's file may be: under its App, tenant and resource. */
export function objectBelongs(rule: Pick<AppFileRule, 'resource' | 'bucket'>, scope: FileScope, key: string): boolean {
  if (!rule.bucket) return false;
  if (scope.anyTenant) {
    const app = appPrefix(rule.bucket, scope.app);
    if (!key.startsWith(app)) return false;
    const [tenant, resource, id, ...rest] = key.slice(app.length).split('/');
    return (
      !rest.length &&
      Boolean(tenant) &&
      tenant !== '-' &&
      tenant !== '.' &&
      tenant !== '..' &&
      resource === segment(rule.resource) &&
      OBJECT_ID.test(id ?? '')
    );
  }
  const prefix = resourcePrefix({ ...rule, bucket: rule.bucket }, scope);
  return key.startsWith(prefix) && OBJECT_ID.test(key.slice(prefix.length));
}

/** The tag a file is known by wherever its bytes are: what the file route's ETag says. */
export function fileTag(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`;
}

/** The same tag from a stored SHA-256 (the `hash` column), without the bytes; undefined for anything that is not one. */
export function storedTag(hash: unknown): string | undefined {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)
    ? `"${Buffer.from(hash, 'hex').toString('base64url').slice(0, 27)}"`
    : undefined;
}

/** A new file row's values with its bytes where `storage` says, and how to take them back if the row is not written. */
export interface PlacedFile {
  readonly values: Record<string, unknown>;
  discard(): Promise<void>;
}

const kept: PlacedFile['discard'] = async () => {};

/**
 * Put a new row's bytes where its resource keeps them. In the database they
 * stay in the values; in a bucket they are stored first, and the values name
 * the object instead. The object is stored as `application/octet-stream`
 * whatever the upload claimed, so a bucket made public by mistake still
 * never serves a page in its own origin's name.
 */
export async function placeFile(rule: AppFileRule, values: Record<string, unknown>, scope: FileScope): Promise<PlacedFile> {
  const bytes = values[rule.content];
  if (rule.storage !== 'bucket' || !rule.bucket || !rule.object || !(bytes instanceof Uint8Array)) return { values, discard: kept };
  const bucket = bucketOf(rule);
  const key = newObjectKey({ ...rule, bucket: rule.bucket }, scope);
  await bucket.put(key, bytes);
  return {
    // The server's own values (app/appAccess.ts `serverRequest`): the object column is named by no request.
    values: serverRequest({ ...values, [rule.content]: null, [rule.object]: key }),
    discard: () => bucket.delete(key).catch(() => {}),
  };
}

/**
 * Write a placed file's row. When the write is refused its object is deleted
 * at once; when its outcome is unknown the object stays, since the row may
 * have been written, and the sweep decides once the database says.
 */
export async function writePlaced<T>(placed: PlacedFile, write: (values: Record<string, unknown>) => Promise<T>): Promise<T> {
  try {
    return await write(placed.values);
  } catch (error) {
    if (!(error instanceof TransactionOutcomeUnknown)) await placed.discard();
    throw error;
  }
}

/**
 * The reader's words for a file store that did not answer (a bucket down, or
 * none this server can use), the operator having been told the whole of it;
 * undefined for any other error. A bucket's refusal can name its account and
 * keys, so the reader hears only that the store did not answer.
 */
export function fileStoreTrouble(error: unknown, doing: 'read' | 'stored'): string | undefined {
  if (!(error instanceof BucketError) && !(error instanceof FileStorageUnavailable)) return undefined;
  console.error(`mistri: ${error.message}`);
  return `This file cannot be ${doing} just now: its store did not answer.`;
}
