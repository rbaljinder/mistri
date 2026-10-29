/**
 * A driver's or library's own words (a host, a user, a path, a key) are the operator's, on the log: a response says a
 * fixed sentence. Each route here is handed an internal error carrying a marker, and the marker must not come back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assistantRoutes } from '../packages/mistri/src/server/http/assistantRoutes.js';
import { accountRoutes } from '../packages/mistri/src/server/http/accountRoutes.js';
import { storeUnavailableReply } from '../packages/mistri/src/server/assistant/assistantStores.js';
import { AssistantStoreUnavailable } from '../packages/mistri/src/adapters/assistant/assistantStore.js';
import { BucketError } from '../packages/mistri/src/server/files/bucket.js';
import { fileStoreTrouble } from '../packages/mistri/src/server/files/fileStorage.js';

const SECRET = 'password=hunter2 host=db.internal.example';

async function answer(route: (req: never, res: never, url: URL) => Promise<unknown>, method = 'GET', target = '/') {
  const server = createServer((req, res) => void route(req as never, res as never, new URL(req.url ?? '/', 'http://x')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${target}`, { method });
    return { status: res.status, text: await res.text() };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function quiet<T>(run: () => Promise<T>): Promise<T> {
  const error = console.error;
  console.error = () => {};
  return run().finally(() => {
    console.error = error;
  });
}

test('the assistant route does not repeat the text of an error from opening its store', async () => {
  const host = { app: { app: { id: 'desk', name: 'Desk', assistant: { roles: undefined } } } };
  const registry = {
    list: () => {
      throw new Error(SECRET);
    },
  };
  const { status, text } = await quiet(() =>
    answer(
      (req, res, url) =>
        assistantRoutes(
          { req, res, url, path: '/api/assistant', appHosts: [host], registry, identity: {} } as never,
          (() => undefined) as never,
        ),
      'GET',
      '/api/assistant?app=desk',
    ),
  );
  assert.equal(status, 503);
  assert.doesNotMatch(text, /hunter2|db\.internal/);
  assert.match(text, /assistant store is unavailable/);
});

test('an operator-facing store refusal is still said as written, and any other error is not', () => {
  const written = 'Desk declares an assistant; none is configured.';
  assert.equal(storeUnavailableReply(new AssistantStoreUnavailable(written)).message, written);
  assert.doesNotMatch(storeUnavailableReply(new Error(SECRET)).message, /hunter2/);
});

test('the accounts route answers a store or Better Auth failure with a fixed sentence', async () => {
  const accounts = {
    list: async () => {
      throw Object.assign(new Error(SECRET), { statusCode: 500 });
    },
  };
  const ctx = (req: never, res: never, url: URL) =>
    ({
      req,
      res,
      url,
      path: '/api/accounts',
      identity: { id: 'a1', role: 'admin' },
      signedIn: { app: { app: { id: 'desk', auth: { roles: ['admin'] } } }, auth: { accounts } },
    }) as never;
  const { status, text } = await answer((req, res, url) => accountRoutes(ctx(req, res, url)), 'GET', '/api/accounts?app=desk');
  assert.equal(status, 503);
  assert.doesNotMatch(text, /hunter2|db\.internal/);
});

test('a bucket failure reaches the reader as one sentence, the operator getting the whole', () => {
  const lines: string[] = [];
  const error = console.error;
  console.error = (line: unknown) => void lines.push(String(line));
  try {
    const said = fileStoreTrouble(new BucketError(`The bucket "b" could not be reached: ${SECRET}`, 503), 'read');
    assert.equal(said, 'This file cannot be read just now: its store did not answer.');
  } finally {
    console.error = error;
  }
  assert.match(lines.join('\n'), /hunter2/);
});
