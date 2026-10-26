import assert from 'node:assert/strict';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startTenantProof, type TenantProofFixture } from '../e2e/support/tenantProofServer.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';

type ObjectValue = Record<string, unknown>;
type Reply = { status: number; headers: Headers; body: ObjectValue };
type Context = { appId: string; accountId: string; tenantId: string; tabId: string; context: string; revision: number };
const ownerNames = ['app', 'account', 'tenant', 'tab', 'context', 'lease-revision'];
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const filter = (column: string, value: string) => ({ groups: [[{ column, op: '=', value }]] });

function object(value: unknown): ObjectValue {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}
function refused(reply: Reply, command = false, status = 400) {
  assert.equal(reply.status, status);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  for (const name of ownerNames) assert.equal(reply.headers.get(`x-mistri-${name}`), null);
  for (const key of ['rows', 'result', 'receiptId', 'expectedVersion']) assert.equal(key in reply.body, false);
  assert.doesNotMatch(JSON.stringify(reply.body), /physical_|__mistri_|"(?:sql|params|stack|sessionId|password|token)"/);
  if (command) {
    assert.equal(reply.body.code, 'invalid_input');
    // A parser refusal does not change the existing conservative wire contract.
    assert.equal(reply.body.outcome, 'unknown');
  }
}
function owned(reply: Reply, context: Context) {
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  const values = [context.appId, context.accountId, context.tenantId, context.tabId, context.context, String(context.revision)];
  ownerNames.forEach((name, index) => {
    assert.ok(reply.headers.get(`x-mistri-${name}`) === values[index], `incorrect ${name} ownership`);
  });
}

async function client(f: TenantProofFixture) {
  const account = f.accounts.member;
  const signedIn = await fetch(`${f.origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(signedIn.status, 200, 'native sign-in failed');
  assert.ok(object(object(await signedIn.json()).user).id === account.id, 'native sign-in returned another account');
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie.length > 0, 'native sign-in must issue session cookies');

  const raw = (path: string, bytes: Buffer | Buffer[], context?: Context): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const outgoing = request(
        `${f.origin}${path}?app=${f.appId}&tenant=northstar`,
        {
          method: 'POST',
          agent: false,
          headers: {
            cookie,
            origin: f.origin,
            'content-type': 'application/json',
            ...(Array.isArray(bytes) ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(bytes.length) }),
            ...(context
              ? {
                  'x-mistri-account': context.accountId,
                  'x-mistri-tab': context.tabId,
                  'x-mistri-context': context.context,
                  'x-mistri-lease-revision': String(context.revision),
                }
              : {}),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('error', reject);
          incoming.on('end', () => {
            try {
              const headers = new Headers();
              for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
                headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
              }
              resolve({ status: incoming.statusCode!, headers, body: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Raw UTF-8 request timed out')));
      if (!Array.isArray(bytes)) outgoing.end(bytes);
      else {
        let index = 0;
        const write = () => {
          if (outgoing.destroyed) return;
          if (index === bytes.length) {
            outgoing.end();
            return;
          }
          outgoing.write(bytes[index++]);
          setImmediate(write);
        };
        write();
      }
    });
  const opened = await raw('/api/tenant/context/open', json({}));
  assert.equal(opened.status, 200, 'native tenant context open failed');
  const context = opened.body as Context;
  assert.ok(context.accountId === account.id && context.appId === f.appId && context.tenantId === 'northstar');
  owned(opened, context);
  return { raw, context, data: (path: string, bytes: Buffer | Buffer[]) => raw(path, bytes, context) };
}

// Read-only snapshots witness all business and journal effects independently of HTTP.
function evidence(f: TenantProofFixture) {
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    db.exec('BEGIN');
    const read = (table: string, order = 'id') =>
      db
        .prepare(`SELECT * FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`} ORDER BY "${order}"`)
        .all()
        .map((row) => ({ ...row }));
    return {
      units: read(`physical_${f.model.unit}`),
      work: read(`physical_${f.model.work}`),
      targets: read(`physical_${f.model.target}`),
      events: read(`physical_${f.model.event}`),
      receipts: read(COMMAND_JOURNAL_TABLES.receipt),
      audits: read(sqliteAuditRows, 'receipt_id'),
    };
  } finally {
    db.close();
  }
}
function replaceMarker(value: unknown, bytes: Buffer) {
  const encoded = json(value),
    marker = Buffer.from('UTF8_MARKER'),
    index = encoded.indexOf(marker);
  assert.ok(index >= 0);
  return Buffer.concat([encoded.subarray(0, index), bytes, encoded.subarray(index + marker.length)]);
}
function splitMultibyte(bytes: Buffer) {
  const index = bytes.indexOf(Buffer.from('🚀'));
  assert.ok(index >= 0);
  return [bytes.subarray(0, index + 1), bytes.subarray(index + 1, index + 2), bytes.subarray(index + 2)];
}
function padded(value: unknown, length: number) {
  const bytes = json(value);
  assert.ok(bytes.length < length);
  return Buffer.concat([bytes, Buffer.alloc(length - bytes.length, 0x20)]);
}

test('UTF-8: real native tenant query and command input integrity', { timeout: 45000 }, async (t) => {
  const f = await startTenantProof('thread');
  t.after(() => f.stop());
  const c = await client(f);
  const prepare = { command: f.model.command, commandVersion: 1, key: { id: f.rows.north.target } };
  const attempt = { ...prepare, expectedVersion: 0, idempotencyKey: 'native-utf8-attempt-0001', input: { body: 'UTF8_MARKER' } };

  await t.test('malformed bytes and BOM refuse before business or journal effects', async () => {
    const before = evidence(f);
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from([0x80]),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from([0xf4, 0x90, 0x80, 0x80]),
      Buffer.from([0xe2, 0x82]),
    ]) {
      const query = replaceMarker({ table: f.model.target, filter: filter('name', 'UTF8_MARKER') }, bytes);
      refused(await c.data('/api/query', query));
      const command = replaceMarker(attempt, bytes);
      // These bytes remain inside a JSON string: replacement decoding would
      // admit a real command, update its target and insert a comment/receipt.
      refused(await c.data('/api/commands/execute', command), true);
      refused(await c.data('/api/commands/status', command), true);
      assert.deepEqual(evidence(f), before);
    }
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    refused(await c.data('/api/query', Buffer.concat([bom, json({ table: f.model.target })])));
    refused(await c.data('/api/commands/execute', Buffer.concat([bom, json(attempt)])), true);
    assert.deepEqual(evidence(f), before);
  });

  const text = 'café 東京 🚀 \uFFFD';
  const validAttempt = { ...attempt, input: { body: text } };
  await t.test('valid split multibyte command commits exact text and status replays once', async () => {
    const before = evidence(f);
    const prepared = await c.data('/api/commands/prepare', json(prepare));
    owned(prepared, c.context);
    assert.deepEqual(prepared.body, { expectedVersion: 0 });
    assert.deepEqual(evidence(f), before);
    const executed = await c.data('/api/commands/execute', splitMultibyte(json(validAttempt)));
    owned(executed, c.context);
    assert.equal(executed.body.status, 'applied');
    const after = evidence(f);
    assert.equal(after.events.length, before.events.length + 1);
    assert.equal(after.receipts.length, before.receipts.length + 1);
    assert.equal(after.audits.length, before.audits.length + 1);
    const result = object(executed.body.result);
    assert.equal(after.events.find((row) => row.id === result.eventId)?.body, text);
    assert.equal(after.targets.find((row) => row.id === f.rows.north.target)?.version, 1);
    assert.equal(after.targets.find((row) => row.id === f.rows.north.target)?.status, 'done');
    const queried = await c.data('/api/query', splitMultibyte(json({ table: f.model.event, filter: filter('body', text) })));
    owned(queried, c.context);
    assert.ok(Array.isArray(queried.body.rows));
    assert.equal(queried.body.rows.length, 1);
    assert.equal(object(queried.body.rows[0]).body, text);
    const status = await c.data('/api/commands/status', splitMultibyte(json(validAttempt)));
    owned(status, c.context);
    assert.equal(status.body.status, 'applied');
    assert.equal(status.body.replayed, true);
    assert.equal(status.body.receiptId, executed.body.receiptId);
    assert.deepEqual(evidence(f), after);
  });

  await t.test('control, command and query byte limits retain their exact boundaries', async () => {
    const before = evidence(f);
    for (const [path, value, maximum, control] of [
      ['/api/tenant/context/open', {}, 16384, true],
      ['/api/commands/prepare', prepare, 65536, false],
      ['/api/query', { table: f.model.event, filter: filter('body', text) }, 262144, false],
    ] as const) {
      const send = (bytes: Buffer) => (control ? c.raw(path, bytes) : c.data(path, bytes));
      const accepted = await send(padded(value, maximum));
      if (control) {
        assert.equal(accepted.status, 200);
        owned(accepted, accepted.body as Context);
      } else owned(accepted, c.context);
      if (path === '/api/commands/prepare') assert.deepEqual(accepted.body, { expectedVersion: 1 });
      if (path === '/api/query') {
        assert.ok(Array.isArray(accepted.body.rows));
        assert.equal(accepted.body.rows.length, 1);
        assert.equal(object(accepted.body.rows[0]).body, text);
      }
      const oversized = await send(padded(value, maximum + 1)).then(
        (reply) => ({ reply }),
        (error: unknown) => ({ error }),
      );
      if ('reply' in oversized) refused(oversized.reply, path.startsWith('/api/commands/'), path.startsWith('/api/commands/') ? 400 : 413);
      else {
        // Exiting the existing bounded async iterator can destroy the socket;
        // only its concrete reset is acceptable, never a timeout or other error.
        assert.ok(oversized.error instanceof Error && (oversized.error as NodeJS.ErrnoException).code === 'ECONNRESET');
      }
      assert.deepEqual(evidence(f), before);
    }
  });
});
