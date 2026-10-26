import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { after, before, test } from 'node:test';
import { DEFAULT_POLICY, HttpSourceError, send, type EgressPolicy, type Resolver } from '../packages/engine/src/adapters/http/egress.js';
import { BIG_ID, startFakeRest } from './support/fakeRest.js';

/* Egress is the one door an HTTP connection's requests leave by. These hold
   it to its rules: the checked address is the connected one, redirects and
   non-JSON are refused, a body is capped and a request has a deadline. The
   API is a local test server, reached through a resolver that can make any
   name mean any address. */
let api: Awaited<ReturnType<typeof startFakeRest>>;
before(async () => {
  api = await startFakeRest();
});
after(() => api.close());

const resolvingTo =
  (...addresses: string[]): Resolver =>
  (_host, _options, callback) =>
    callback(
      null,
      addresses.map((address) => ({ address, family: isIP(address) })),
    );
const policy = (overrides: Partial<EgressPolicy> = {}): EgressPolicy => ({ ...DEFAULT_POLICY, insecure: true, ...overrides });
const reason = (expected: HttpSourceError['reason'], pattern?: RegExp) => (error: unknown) =>
  error instanceof HttpSourceError && error.reason === expected && (!pattern || pattern.test(error.message));
const port = () => new URL(api.origin).port;

test('cloud metadata is refused however it is reached; private networks are reached by default', async () => {
  const metadata = new URL(`http://metadata.test:${port()}/v1/contacts`);
  await assert.rejects(
    send(metadata, {}, policy({ resolver: resolvingTo('169.254.169.254') })),
    reason('refused', /may not reach \(169\.254\.169\.254\)/),
  );
  // The same address written as IPv4-mapped IPv6 is the same address.
  await assert.rejects(send(metadata, {}, policy({ resolver: resolvingTo('::ffff:169.254.169.254') })), reason('refused'));
  // A literal in the URL is never looked up, so it is checked before any socket opens.
  await assert.rejects(send(new URL('http://169.254.169.254/latest/meta-data/'), {}, policy()), reason('refused'));
  await assert.rejects(send(new URL(`http://0.0.0.0:${port()}/v1/contacts`), {}, policy()), reason('refused'));
  // A name resolving to a blocked and an allowed address connects to the allowed one only.
  const reply = await send(
    new URL(`http://desk.test:${port()}/v1/contacts?limit=1`),
    {},
    policy({ resolver: resolvingTo('169.254.169.254', '127.0.0.1') }),
  );
  assert.equal(reply.status, 200);
  // An operator can close private networks, and open link-local, per connection.
  await assert.rejects(send(new URL(`${api.origin}/v1/contacts`), {}, policy({ allowPrivate: false })), reason('refused'));
  const opened = policy({ allowLinkLocal: true, resolver: resolvingTo('127.0.0.1') });
  assert.equal((await send(new URL(`http://desk.test:${port()}/v1/contacts?limit=1`), {}, opened)).status, 200);
});

test('an IPv6 spelling of a refused IPv4 address is refused: NAT64, 6to4 and the IPv4-compatible form', async () => {
  const metadata = new URL(`http://metadata.test:${port()}/v1/contacts`);
  for (const spelled of [
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::169.254.169.254',
    '2002:a9fe:a9fe::1',
    '::a9fe:a9fe',
    '::169.254.169.254',
    '64:ff9b:1::a9fe:a9fe',
    'fe80::1',
  ]) {
    await assert.rejects(send(metadata, {}, policy({ resolver: resolvingTo(spelled) })), reason('refused'), spelled);
    await assert.rejects(send(new URL(`http://[${spelled}]/latest/meta-data/`), {}, policy()), reason('refused'), spelled);
  }
  // The same spellings of loopback are private, so refused where private networks are closed, and reached where they are not.
  await assert.rejects(send(metadata, {}, policy({ allowPrivate: false, resolver: resolvingTo('64:ff9b::7f00:1') })), reason('refused'));
  // A public address inside a wrapper is not refused for being wrapped: the refusal is for the destination, not the form.
  assert.equal(
    (
      await send(
        new URL(`http://desk.test:${port()}/v1/contacts?limit=1`),
        {},
        policy({ resolver: resolvingTo('::ffff:127.0.0.1', '2002:808:808::1') }),
      )
    ).status,
    200,
  );
});

test('https is required unless the connection says insecure, and a credential never rides in the URL', async () => {
  await assert.rejects(send(new URL(`${api.origin}/v1/contacts`), {}, DEFAULT_POLICY), reason('refused', /use https/));
  await assert.rejects(
    send(new URL(`http://user:secret@127.0.0.1:${port()}/v1/contacts`), {}, policy()),
    reason('refused', /belongs in the connection's "auth"/),
  );
});

test('a redirect is refused, not followed', async () => {
  await assert.rejects(send(new URL(`${api.origin}/v1/redirect`), {}, policy()), reason('redirect', /redirects are not followed/));
  assert.ok(!api.seen.some((request) => request.headers.host?.startsWith('169.254')), 'nothing reached the redirect target');
});

test('an answer must be JSON, within the byte cap and the deadline', async () => {
  await assert.rejects(send(new URL(`${api.origin}/v1/page.html`), {}, policy()), reason('not_json', /text\/html/));
  await assert.rejects(send(new URL(`${api.origin}/v1/huge`), {}, policy({ maxBytes: 1024 * 1024 })), reason('too_large'));
  await assert.rejects(send(new URL(`${api.origin}/v1/slow`), {}, policy({ timeoutMs: 300 })), reason('timeout'));
});

test('an error status comes back as the status alone, its body never read', async () => {
  assert.deepEqual(await send(new URL(`${api.origin}/v1/nowhere`), {}, policy()), { status: 404, json: undefined });
});

test('a number past 2^53 keeps every digit', async () => {
  const reply = await send(new URL(`${api.origin}/v1/tickets/${BIG_ID}`), {}, policy());
  assert.equal((reply.json as { id: unknown }).id, BIG_ID);
});
