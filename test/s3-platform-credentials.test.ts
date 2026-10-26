/**
 * Bucket credentials from the platform (files/platformCredentials.ts) against
 * a local fake of the ECS container-credentials endpoint and of EC2's IMDSv2:
 * the token header is sent, expiring credentials are cached and renewed
 * before they lapse, a failed renewal survives on the old ones, a bucket
 * signs with the session token, and static MISTRI_S3_* keys still win.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Bucket } from '../packages/mistri/src/server/files/bucket.js';
import { bucketOf, bucketCredentialsProblem } from '../packages/mistri/src/server/files/fileStorage.js';
import { platformCredentials } from '../packages/mistri/src/server/files/platformCredentials.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

let server: Server;
let origin: string;
const seen: { method: string; url: string; headers: IncomingMessage['headers'] }[] = [];
let serial = 0;
let lifetimeMs = 3_600_000;
let failing = false;

const issue = () => ({
  AccessKeyId: `ASIA${++serial}`,
  SecretAccessKey: `secret-${serial}`,
  Token: `token-${serial}`,
  Expiration: new Date(Date.now() + lifetimeMs).toISOString(),
});

before(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const send = (status: number, body: string) => res.writeHead(status).end(body);
    if (failing) return send(500, 'no');
    if (req.url === '/creds') return send(200, JSON.stringify(issue()));
    if (req.url === '/latest/api/token') return send(200, 'imds-token');
    if (req.headers['x-aws-ec2-metadata-token'] !== 'imds-token') return send(401, 'no token');
    if (req.url === '/latest/meta-data/iam/security-credentials/') return send(200, 'task-role\n');
    if (req.url === '/latest/meta-data/iam/security-credentials/task-role') return send(200, JSON.stringify(issue()));
    send(404, '');
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const reset = () => {
  seen.length = 0;
  failing = false;
  lifetimeMs = 3_600_000;
};

test('the container endpoint is asked with the authorization token and its answer is cached', async () => {
  reset();
  const source = platformCredentials({
    AWS_CONTAINER_CREDENTIALS_FULL_URI: `${origin}/creds`,
    AWS_CONTAINER_AUTHORIZATION_TOKEN: 'Bearer abc',
  })!;
  const first = await source();
  const again = await source();
  assert.equal(first.sessionToken, again.sessionToken);
  assert.match(first.accessKeyId, /^ASIA/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, 'Bearer abc');
});

test('the authorization token file is read when asked, not once', async () => {
  reset();
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-s3-token-'));
  try {
    const file = join(directory, 'token');
    writeFileSync(file, 'from-file\n');
    let now = Date.now();
    const source = platformCredentials(
      { AWS_CONTAINER_CREDENTIALS_FULL_URI: `${origin}/creds`, AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: file },
      fetch,
      () => now,
    )!;
    lifetimeMs = 10 * 60_000;
    await source();
    writeFileSync(file, 'rotated\n');
    now += 6 * 60_000;
    await source();
    assert.deepEqual(
      seen.map((request) => request.headers.authorization),
      ['from-file', 'rotated'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('credentials are renewed before they expire, and a failed renewal keeps the old ones until they lapse', async () => {
  reset();
  lifetimeMs = 10 * 60_000;
  let now = Date.now();
  const source = platformCredentials({ AWS_CONTAINER_CREDENTIALS_FULL_URI: `${origin}/creds` }, fetch, () => now)!;
  const first = await source();
  now += 4 * 60_000; // six minutes left: still more than the five-minute margin
  assert.equal((await source()).accessKeyId, first.accessKeyId);
  lifetimeMs = 20 * 60_000;
  now += 2 * 60_000; // four minutes left: renewed
  const second = await source();
  assert.notEqual(second.accessKeyId, first.accessKeyId);
  assert.equal(seen.length, 2);
  failing = true;
  now += 11 * 60_000; // inside the margin but not yet expired
  assert.equal((await source()).accessKeyId, second.accessKeyId, 'a refused renewal serves the credentials that still hold');
  now += 10 * 60_000;
  await assert.rejects(source(), /answered 500/);
});

test('concurrent requests share one renewal', async () => {
  reset();
  const source = platformCredentials({ AWS_CONTAINER_CREDENTIALS_FULL_URI: `${origin}/creds` })!;
  const all = await Promise.all([source(), source(), source()]);
  assert.equal(new Set(all.map((one) => one.accessKeyId)).size, 1);
  assert.equal(seen.length, 1);
});

test('IMDSv2 takes a session token, finds the role, then reads its credentials', async () => {
  reset();
  const source = platformCredentials({ MISTRI_S3_INSTANCE_ROLE: '1', AWS_EC2_METADATA_SERVICE_ENDPOINT: origin })!;
  const got = await source();
  assert.match(got.sessionToken ?? '', /^token-/);
  assert.deepEqual(
    seen.map((request) => `${request.method} ${request.url}`),
    [
      'PUT /latest/api/token',
      'GET /latest/meta-data/iam/security-credentials/',
      'GET /latest/meta-data/iam/security-credentials/task-role',
    ],
  );
  assert.ok(seen[0].headers['x-aws-ec2-metadata-token-ttl-seconds']);
});

test('nothing is asked unless the environment names a platform', () => {
  assert.equal(platformCredentials({}), undefined);
  assert.equal(platformCredentials({ MISTRI_S3_INSTANCE_ROLE: '0' }), undefined);
});

test('a bucket signs with the role credentials and their session token', async () => {
  reset();
  const source = platformCredentials({ AWS_CONTAINER_CREDENTIALS_FULL_URI: `${origin}/creds` })!;
  const headers: Record<string, string>[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    headers.push(init?.headers as Record<string, string>);
    return new Response('<ListBucketResult></ListBucketResult>');
  }) as typeof fetch;
  const bucket = new Bucket({ name: 'b', endpoint: 'http://127.0.0.1:1', pathStyle: true }, source, fetcher);
  await bucket.list('p/');
  assert.match(headers[0]['x-amz-security-token'], /^token-/);
  assert.match(headers[0].authorization, /Credential=ASIA\d+\//);
  assert.match(await bucket.presign('k', 60), /X-Amz-Security-Token=token-/);
});

test('static keys take precedence, and a platform alone is enough to start', () => {
  const rule = { resource: 'attachment', bucket: { name: 'b' } };
  const platform = { AWS_CONTAINER_CREDENTIALS_FULL_URI: `${origin}/creds` };
  const fixed = { MISTRI_S3_ACCESS_KEY_ID: 'AK', MISTRI_S3_SECRET_ACCESS_KEY: 'SK' };
  assert.equal(bucketOf(rule, { ...fixed, ...platform }), bucketOf(rule, fixed));
  assert.notEqual(bucketOf(rule, platform), bucketOf(rule, fixed));
  assert.equal(bucketOf(rule, platform), bucketOf(rule, { ...platform }), 'the role source is remembered, so its cache survives');
  assert.throws(() => bucketOf(rule, {}), /no credentials/);
  const app = parseAppConfig(
    {
      id: 'x',
      name: 'X',
      connection: 'db',
      resources: {
        attachment: {
          access: 'write',
          file: { content: 'data', name: 'n', type: 't', object: 'o', hash: 'h', size: 's', storage: 'bucket', bucket: { name: 'bkt' } },
        },
      },
      views: { a: { kind: 'list', from: 'attachment', label: 'A' } },
      home: 'a',
      nav: ['a'],
    },
    'x',
  );
  assert.equal(bucketCredentialsProblem([app], platform), undefined);
  assert.match(bucketCredentialsProblem([app], {}) ?? '', /task role/);
});
