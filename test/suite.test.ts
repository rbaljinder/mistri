import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { test } from 'node:test';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('a root App and renamed sub-App share a listener without changing requests or cookies', async (t) => {
  const bases: Record<string, string> = {};
  const closed: string[] = [];
  const children: Server[] = [];
  const suite = await createSuite(
    ['lender', 'dealer'].map((id) => ({
      id,
      open: async (base: string) => {
        bases[id] = base;
        const server = createServer((req, res) => {
          const ownCookie = req.headers.cookie?.split('; ').includes(`${id}=session`) ?? false;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ id, path: req.url, signedIn: ownCookie }));
        });
        children.push(server);
        return {
          server,
          stop: async () => {
            closed.push(`stop:${id}`);
          },
          close: async () => {
            closed.push(`close:${id}`);
          },
        };
      },
    })),
    { base: '/tools', mounts: { lender: '', dealer: 'dealers' } },
  );
  t.after(() => suite.close());
  const origin = await listen(suite.server);
  assert.deepEqual(bases, { lender: '/tools', dealer: '/tools/dealers' });
  assert.ok(children.every((child) => !child.listening));
  const read = async (path: string, cookie = '') => {
    const response = await fetch(`${origin}${path}`, { headers: { cookie } });
    return { status: response.status, body: response.status === 200 ? await response.json() : await response.text() };
  };
  assert.deepEqual((await read('/tools/api/whoami', 'lender=session')).body, { id: 'lender', path: '/tools/api/whoami', signedIn: true });
  assert.deepEqual((await read('/tools/dealers/api/whoami?q=1', 'lender=session')).body, {
    id: 'dealer',
    path: '/tools/dealers/api/whoami?q=1',
    signedIn: false,
  });
  assert.deepEqual((await read('/tools/dealers/api/whoami', 'lender=session; dealer=session')).body, {
    id: 'dealer',
    path: '/tools/dealers/api/whoami',
    signedIn: true,
  });
  assert.equal((await read('/tools/dealers-other')).body.id, 'lender', 'mount matching requires a complete segment');
  assert.equal((await read('/elsewhere')).status, 404);
  await suite.close();
  await suite.close();
  assert.deepEqual(closed, ['stop:lender', 'stop:dealer', 'close:dealer', 'close:lender']);
});

test('startup validates addresses before opening and rolls back opened hosts after failure', async () => {
  let opened = 0,
    closed = 0;
  const open = async () => {
    opened++;
    return {
      server: createServer(),
      stop: async () => {},
      close: async () => {
        closed++;
      },
    };
  };
  await assert.rejects(
    createSuite([
      { id: 'a', open },
      { id: 'a', open },
    ]),
    /distinct/,
  );
  await assert.rejects(
    createSuite(
      [
        { id: 'a', open },
        { id: 'b', open },
      ],
      { mounts: { a: '', b: '' } },
    ),
    /both mounted/,
  );
  await assert.rejects(createSuite([{ id: 'a', open }], { mounts: { a: 'api' } }), /server's own/);
  assert.equal(opened, 0);
  await assert.rejects(
    createSuite([
      { id: 'a', open },
      {
        id: 'b',
        open: async () => {
          throw new Error('Unavailable auth store');
        },
      },
    ]),
    /Unavailable auth store/,
  );
  assert.equal(opened, 1);
  assert.equal(closed, 1);
});

test('upgrades reach only the selected App and keep their original target', async (t) => {
  const suite = await createSuite(
    ['a', 'b'].map((id) => ({
      id,
      open: async () => {
        const server = createServer();
        server.on('upgrade', (req, socket) => {
          socket.end(
            `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\nX-App: ${id}\r\nX-Target: ${req.url}\r\n\r\n`,
          );
        });
        return { server, stop: async () => {}, close: async () => {} };
      },
    })),
  );
  t.after(() => suite.close());
  const origin = await listen(suite.server);
  const answer = await new Promise<{ app: unknown; target: unknown }>((resolve, reject) => {
    const req = request(`${origin}/b/_mistri/hmr?q=1`, { headers: { connection: 'Upgrade', upgrade: 'test' } });
    req.on('error', reject);
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ app: res.headers['x-app'], target: res.headers['x-target'] });
    });
    req.end();
  });
  assert.deepEqual(answer, { app: 'b', target: '/b/_mistri/hmr?q=1' });
  const absent = await fetch(`${origin}/api/whoami`);
  assert.equal(absent.status, 404, 'no root App means no implicit first-App fallback');
  await absent.text();
});

test('shutdown waits for an accepted response before releasing App resources', async () => {
  let entered!: () => void, release!: () => void;
  const accepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  let stopped!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const suite = await createSuite([
    {
      id: 'a',
      open: async () => ({
        server: createServer(async (_req, res) => {
          entered();
          await held;
          events.push('response');
          res.end('done');
        }),
        stop: async () => {
          events.push('stop');
          stopped();
        },
        close: async () => {
          events.push('close');
        },
      }),
    },
  ]);
  const origin = await listen(suite.server);
  const request = fetch(origin).then((response) => response.text());
  await accepted;
  const closing = suite.close();
  await stopping;
  try {
    assert.deepEqual(events, ['stop']);
  } finally {
    release();
    await request;
    await closing;
  }
  assert.deepEqual(events, ['stop', 'response', 'close']);
});

test('cleanup continues after one host fails to stop or close', async () => {
  const closed: string[] = [];
  const suite = await createSuite(
    ['a', 'b'].map((id) => ({
      id,
      open: async () => ({
        server: createServer(),
        stop: async () => {
          if (id === 'a') throw new Error('stop');
        },
        close: async () => {
          closed.push(id);
          if (id === 'b') throw new Error('close');
        },
      }),
    })),
  );
  await assert.rejects(suite.close(), (error: unknown) => error instanceof AggregateError && error.errors.length === 2);
  assert.deepEqual(closed, ['b', 'a']);
});

test('shutdown publishes its promise before a host can reenter it', async () => {
  let reentered: Promise<void> | undefined,
    stops = 0;
  const suite = await createSuite([
    {
      id: 'a',
      open: async () => ({
        server: createServer(),
        stop: async () => {
          if (++stops === 1) reentered = suite.close();
        },
        close: async () => {},
      }),
    },
  ]);
  const closing = suite.close();
  await closing;
  assert.equal(reentered, closing);
  assert.equal(stops, 1);
});

test('the shared HMR endpoint bypasses child upgrades and invalid aliases are closed', async (t) => {
  let childUpgrades = 0;
  const suite = await createSuite([
    {
      id: 'a',
      open: async () => {
        const server = createServer();
        server.on('upgrade', (_req, socket) => {
          childUpgrades++;
          socket.destroy();
        });
        return { server, stop: async () => {}, close: async () => {} };
      },
    },
  ]);
  t.after(() => suite.close());
  suite.server.on('upgrade', (req, socket) => {
    if (req.url !== '/?token=test') return;
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const origin = await listen(suite.server);
  const upgrade = (path: string) =>
    new Promise<void>((resolve, reject) => {
      const req = request(`${origin}${path}`, {
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr' },
      });
      req.on('error', reject);
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve();
      });
      req.end();
    });
  await upgrade('/?token=test');
  await assert.rejects(upgrade('/a/?token=test'), /socket hang up/);
  assert.equal(childUpgrades, 0);
});

test('server endpoints cannot be captured by an App id, and custom mounts reject hostile paths', async (t) => {
  const suite = await createSuite(
    ['main', 'api'].map((id) => ({
      id,
      open: async () => ({
        server: createServer((_req, res) => res.end(id)),
        stop: async () => {},
        close: async () => {},
      }),
    })),
    { base: '/tools', mounts: { main: '', api: 'billing' } },
  );
  t.after(() => suite.close());
  const origin = await listen(suite.server);
  for (const [path, expected] of [
    ['/tools/api/whoami', 'main'],
    ['/tools/billing/api/whoami', 'api'],
    ['/tools/billing-other', 'main'],
    ['/tools/%62illing', 'api'],
    ['/tools/billing%2Fapi', 'main'],
  ]) {
    assert.equal(await (await fetch(`${origin}${path}`)).text(), expected, path);
  }
  const outside = await fetch(`${origin}/tools/../outside`);
  assert.equal(outside.status, 404);
  await outside.text();
});

test('background owners start once after listen and all retire after partial startup failure', async () => {
  const events: string[] = [];
  const suite = await createSuite(
    ['main', 'child'].map((id) => ({
      id,
      open: async () => ({
        server: createServer(),
        start: () => {
          events.push(`start:${id}`);
          if (id === 'child') throw new Error('worker startup failed');
        },
        stop: async () => {
          events.push(`stop:${id}`);
        },
        close: async () => {
          events.push(`close:${id}`);
        },
      }),
    })),
  );
  await assert.rejects(suite.start(), /must be listening/);
  assert.deepEqual(events, []);
  await listen(suite.server);
  const starting = suite.start();
  assert.equal(suite.start(), starting);
  await assert.rejects(starting, /worker startup failed/);
  assert.equal(suite.server.listening, false);
  assert.deepEqual(events, ['start:main', 'start:child', 'stop:main', 'stop:child', 'close:child', 'close:main']);
  await assert.rejects(suite.start(), /must be listening/);
});

test('shutdown cancels background admission and waits for its work before releasing stores', async () => {
  const events: string[] = [];
  let release!: () => void, stopEntered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stopping = new Promise<void>((resolve) => {
    stopEntered = resolve;
  });
  const suite = await createSuite([
    {
      id: 'main',
      open: async () => ({
        server: createServer(),
        start: () => {
          events.push('started');
        },
        stop: async () => {
          events.push('cancel');
          stopEntered();
          await held;
          events.push('drained');
        },
        close: async () => {
          events.push('store closed');
        },
      }),
    },
    {
      id: 'child',
      open: async () => ({
        server: createServer(),
        stop: async () => {
          events.push('child cancelled');
        },
        close: async () => {},
      }),
    },
  ]);
  await listen(suite.server);
  await suite.start();
  const closing = suite.close();
  await stopping;
  try {
    assert.deepEqual(events, ['started', 'cancel', 'child cancelled']);
  } finally {
    release();
    await closing;
  }
  assert.deepEqual(events, ['started', 'cancel', 'child cancelled', 'drained', 'store closed']);
});
