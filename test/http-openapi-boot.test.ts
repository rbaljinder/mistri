import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openapiConnection } from '../packages/engine/src/server/openapiDraft.js';
import { startFakeRest } from './support/fakeRest.js';

/* `--openapi`: from a spec to a served API in one command. The connection is
   built from the spec alone — its base URL from `servers` or `--api-url`, its
   token a reference — and a real boot answers lists from the API. */
const FIXTURE = 'test/fixtures/http/openapi.json';
const spec = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const quiet = { write: () => true };
let dir: string;
let api: Awaited<ReturnType<typeof startFakeRest>>;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mistri-openapi-boot-'));
  api = await startFakeRest();
});
after(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

const specWith = (servers: unknown) => {
  const file = join(dir, `spec-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ ...spec, ...(servers === undefined ? {} : { servers }) }));
  return file;
};

test("the base URL is the spec's server, or --api-url, and the description is drafted in memory", async () => {
  const fromServer = await openapiConnection(specWith([{ url: 'https://desk.example.test/v1' }]), {}, quiet);
  assert.equal(fromServer.name, 'Desk API');
  assert.equal(fromServer.url, 'https://desk.example.test/v1');
  assert.equal(typeof fromServer.http.description, 'object');
  assert.equal(fromServer.http.insecure, undefined);

  const given = await openapiConnection(specWith(undefined), { apiUrl: 'https://other.example.test/api/' }, quiet);
  assert.equal(given.url, 'https://other.example.test/api/');
  // Plain http to this machine is a local mock's address, and allowed as one.
  const local = await openapiConnection(specWith([{ url: 'http://127.0.0.1:4781/v1' }]), {}, quiet);
  assert.equal(local.http.insecure, true);
});

test('what cannot be served is refused with what to do instead', async () => {
  await assert.rejects(openapiConnection(specWith(undefined), {}, quiet), /names no server\. Pass --api-url/);
  await assert.rejects(openapiConnection(specWith([{ url: '/v1' }]), {}, quiet), /not an address on its own\. Pass --api-url/);
  await assert.rejects(openapiConnection(specWith([{ url: 'https://{region}.desk.example.test' }]), {}, quiet), /has variables/);
  await assert.rejects(openapiConnection(specWith([{ url: 'http://desk.example.test/v1' }]), {}, quiet), /allowed only to this machine/);
  await assert.rejects(
    openapiConnection(specWith([{ url: 'https://desk.example.test' }]), { tokenEnv: 'DESK_BOOT_UNSET' }, quiet),
    /DESK_BOOT_UNSET is not set/,
  );
  await assert.rejects(openapiConnection(join(dir, 'absent.json'), {}, quiet), /no spec file/);
});

test('a token is kept as a reference to its variable, never its value', async () => {
  process.env.DESK_BOOT_TOKEN = 'boot-token-6a1';
  try {
    const connection = await openapiConnection(specWith([{ url: 'https://desk.example.test' }]), { tokenEnv: 'DESK_BOOT_TOKEN' }, quiet);
    assert.deepEqual(connection.http.auth, { bearer: '${DESK_BOOT_TOKEN}' });
    assert.doesNotMatch(JSON.stringify(connection), /boot-token-6a1/);
  } finally {
    delete process.env.DESK_BOOT_TOKEN;
  }
});

test('a spec at a URL is fetched, and a relative server resolves against it', async () => {
  const connection = await openapiConnection(`${api.origin}/openapi-servers.json`, {}, quiet);
  assert.equal(connection.url, `${api.origin}/v1`);
  assert.equal(connection.http.insecure, true);
});
