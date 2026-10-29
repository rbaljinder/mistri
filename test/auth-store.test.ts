/**
 * The store selector and the PostgreSQL separation rule, without a server:
 * a `postgres://` URL in `auth.store` names the PostgreSQL store, `${VAR}`
 * expands for a URL and never for a file path, and the store may not be a
 * configured business database. The live half is postgres-auth-store.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { appAuthStore } from '../packages/mistri/src/server/auth/auth.js';
import { isPostgresAuthStore } from '../packages/mistri/src/server/auth/authStore.js';
import { assertPostgresAuthStoreSeparation } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { expandEnv, expandEnvReferences } from '../packages/engine/src/server/auth/credentials.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/* pg fills what a URL leaves out from these, and so does the comparison;
   this file sets them where it means them. */
for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER']) delete process.env[name];

const SEPARATION = { message: 'Authentication storage must remain separate from the captured business database and its SQLite sidecars.' };
const loaded = (store?: string): LoadedApp => ({
  path: '/srv/apps/demo/app.ts',
  dir: '/srv/apps/demo',
  pages: [],
  sources: {},
  app: parseAppConfig(
    {
      id: 'demo',
      name: 'Demo',
      auth: { signUp: 'open', ...(store === undefined ? {} : { store }) },
      resources: { item: {} },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'store fixture',
  ),
});
const withEnv = <T>(env: Record<string, string | undefined>, run: () => T): T => {
  const previous = Object.keys(env).map((name) => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

test('a postgres:// URL selects the PostgreSQL store; anything else is the file', () => {
  assert.equal(isPostgresAuthStore('postgres://auth@db.internal/authdb'), true);
  assert.equal(isPostgresAuthStore('postgresql://auth@db.internal/authdb'), true);
  assert.equal(isPostgresAuthStore('POSTGRES://auth@db.internal/authdb'), true);
  assert.equal(isPostgresAuthStore('auth.db'), false);
  assert.equal(isPostgresAuthStore('/var/lib/tablewalk/auth.db'), false);
});

test('an explicit App environment selects its own store without inheriting process references', () => {
  assert.equal(appAuthStore(loaded(), { XDG_CONFIG_HOME: '/srv/suite/dealer' }), '/srv/suite/dealer/mistri/auth/demo.db');
  assert.equal(appAuthStore(loaded('${APP_AUTH_STORE}'), { APP_AUTH_STORE: 'postgres://auth@db/isolated' }), 'postgres://auth@db/isolated');
  withEnv({ APP_AUTH_STORE: 'postgres://auth@db/process' }, () => {
    assert.throws(() => appAuthStore(loaded('${APP_AUTH_STORE}'), {}), /not set/);
  });
});

test('appAuthStore returns a URL as written and resolves a file path against the App directory, unchanged', () => {
  assert.equal(appAuthStore(loaded('postgres://auth:secret@db.internal:5433/authdb')), 'postgres://auth:secret@db.internal:5433/authdb');
  assert.equal(appAuthStore(loaded('auth.db')), resolve('/srv/apps/demo', 'auth.db'));
  assert.equal(appAuthStore(loaded('/var/lib/tablewalk/auth.db')), '/var/lib/tablewalk/auth.db');
  assert.match(appAuthStore(loaded()), /[\\/]auth[\\/]demo\.db$/);
});

test('${VAR} expands for a URL, or for a whole store named by reference, and never for a file path', () => {
  withEnv({ AUTH_DB_PASSWORD: 'hunter2', MISTRI_AUTH_STORE: 'postgres://auth@db.internal/authdb' }, () => {
    assert.equal(
      appAuthStore(loaded('postgres://auth:${AUTH_DB_PASSWORD}@db.internal/authdb')),
      'postgres://auth:hunter2@db.internal/authdb',
    );
    assert.equal(appAuthStore(loaded('${MISTRI_AUTH_STORE}')), 'postgres://auth@db.internal/authdb');
  });
  withEnv({ AUTH_DB_PASSWORD: undefined }, () => {
    assert.throws(
      () => appAuthStore(loaded('postgres://auth:${AUTH_DB_PASSWORD}@db.internal/authdb')),
      /AUTH_DB_PASSWORD, which is not set/,
    );
  });
  withEnv({ HOME_DIR: '/nowhere' }, () => {
    assert.equal(appAuthStore(loaded('${HOME_DIR}/stores/auth.db')), '/nowhere/stores/auth.db', 'a reference may name a file too');
    assert.equal(
      appAuthStore(loaded('stores/$HOME_DIR/auth.db')),
      resolve('/srv/apps/demo', 'stores/$HOME_DIR/auth.db'),
      'a path is a path',
    );
  });
});

test('the PostgreSQL store may not name the same server and database as a business connection', () => {
  const store = 'postgres://auth:secret@DB.internal/authdb';
  const business = (url: string) => [{ url: '/data/app.db' }, { url }];
  assert.doesNotThrow(() => assertPostgresAuthStoreSeparation(store, business('postgres://app:pw@db.internal/app')));
  assert.doesNotThrow(
    () => assertPostgresAuthStoreSeparation(store, business('postgres://app:pw@db.internal:5433/authdb')),
    'another port is another server',
  );
  assert.doesNotThrow(() => assertPostgresAuthStoreSeparation(store, business('postgres://app:pw@other.internal/authdb')));
  assert.doesNotThrow(() => assertPostgresAuthStoreSeparation(store, []));
  assert.throws(
    () => assertPostgresAuthStoreSeparation(store, business('postgres://app:other-pw@db.internal/authdb')),
    SEPARATION,
    'the password does not distinguish databases',
  );
  assert.throws(
    () => assertPostgresAuthStoreSeparation(store, business('postgresql://app@db.internal:5432/authdb')),
    SEPARATION,
    'the default port and the scheme spelling do not either',
  );
  assert.throws(
    () => assertPostgresAuthStoreSeparation('postgres://auth@db.internal/authdb', business('postgres://app@db.internal/authdb')),
    SEPARATION,
  );
  assert.throws(
    () => assertPostgresAuthStoreSeparation('postgres://authdb@db.internal', business('postgres://app@db.internal/authdb')),
    SEPARATION,
    'a URL without a database name means the user name, as pg does',
  );
  withEnv({ APP_DB_URL: 'postgres://app@db.internal/authdb' }, () => {
    assert.throws(
      () => assertPostgresAuthStoreSeparation(store, business('${APP_DB_URL}')),
      SEPARATION,
      'a connection named by reference is expanded before comparing',
    );
  });
  assert.throws(
    () => assertPostgresAuthStoreSeparation('/var/lib/auth.db', business('postgres://app@db.internal/app')),
    SEPARATION,
    'only a PostgreSQL store is compared here',
  );
  assert.throws(() => assertPostgresAuthStoreSeparation(store, [{ url: 42 as unknown as string }]), SEPARATION);
});

/* The review's bypass pairs: each names one database two ways, and every
   one of them was accepted while the comparison was of URL text. Each pair
   is refused in both directions. */
test('both URLs are read the way the pg driver reads them, so no spelling of one database passes', () => {
  const pairs: [string, string, string][] = [
    ['localhost and 127.0.0.1', 'postgres://u@localhost/biz', 'postgres://u@127.0.0.1/biz'],
    ['an explicit default port', 'postgres://u@db.internal:5432/biz', 'postgres://u@db.internal/biz'],
    ['host case', 'postgres://u@DB.internal/biz', 'postgres://u@db.internal/biz'],
    ['?host= overriding the authority', 'postgres://u@decoy/biz?host=db.internal', 'postgres://u@db.internal/biz'],
    ['?port= overriding the authority', 'postgres://u@db.internal:6543/biz?port=5432', 'postgres://u@db.internal/biz'],
    ['a Unix socket and localhost', 'postgres:///biz?host=/var/run/postgresql', 'postgres://localhost/biz'],
    ['an encoded Unix socket host', 'postgres://%2Fvar%2Frun%2Fpostgresql/biz', 'postgres://127.0.0.1/biz'],
    ['[::1] and localhost', 'postgres://u@[::1]/biz', 'postgres://u@localhost/biz'],
    ['IPv6 loopback, long form', 'postgres://u@[0:0:0:0:0:0:0:1]/biz', 'postgres://u@localhost/biz'],
    ['IPv4-mapped loopback', 'postgres://u@[::ffff:127.0.0.1]/biz', 'postgres://u@localhost/biz'],
    ['IPv4 shorthand', 'postgres://u@127.1/biz', 'postgres://u@localhost/biz'],
    ['the rest of 127.0.0.0/8', 'postgres://u@127.0.0.2/biz', 'postgres://u@localhost/biz'],
    ['a *.localhost name', 'postgres://u@db.localhost/biz', 'postgres://u@localhost/biz'],
    ['a trailing-dot hostname', 'postgres://u@db.internal./biz', 'postgres://u@db.internal/biz'],
    ['a trailing-dot localhost', 'postgres://u@localhost./biz', 'postgres://u@127.0.0.1/biz'],
    ['a percent-encoded database name', 'postgres://u@db.internal/b%69z', 'postgres://u@db.internal/biz'],
    ['a ?user= naming the default database', 'postgres://x@db.internal?user=biz', 'postgres://u@db.internal/biz'],
    ...(/^[\w.-]+$/.test(hostname())
      ? [['this machine by its own hostname', `postgres://u@${hostname()}/biz`, 'postgres://u@localhost/biz'] as [string, string, string]]
      : []),
  ];
  for (const [name, store, business] of pairs) {
    assert.throws(() => assertPostgresAuthStoreSeparation(store, [{ url: business }]), SEPARATION, name);
    assert.throws(() => assertPostgresAuthStoreSeparation(business, [{ url: store }]), SEPARATION, `${name}, the other way round`);
  }
  // Still distinct: a real difference in host, port or database is not a collision.
  for (const [store, business] of [
    ['postgres://u@localhost/biz', 'postgres://u@localhost/other'],
    ['postgres://u@localhost/biz', 'postgres://u@localhost:5433/biz'],
    ['postgres://u@db.internal/biz?host=other.internal', 'postgres://u@db.internal/biz'],
    ['postgres://u@db.internal:6543/biz', 'postgres://u@db.internal/biz'],
  ])
    assert.doesNotThrow(() => assertPostgresAuthStoreSeparation(store, [{ url: business }]), `${store} / ${business}`);
});

test('what a URL leaves out is filled the way pg fills it: PGHOST, PGPORT, PGDATABASE', () => {
  withEnv({ PGHOST: 'db.internal', PGPORT: '6000', PGDATABASE: 'biz' }, () => {
    assert.throws(() => assertPostgresAuthStoreSeparation('postgres://u@/', [{ url: 'postgres://u@db.internal:6000/biz' }]), SEPARATION);
    assert.throws(
      () => assertPostgresAuthStoreSeparation('postgres://u@db.internal/biz', [{ url: 'postgres://u@db.internal:6000/biz' }]),
      SEPARATION,
    );
    assert.doesNotThrow(() =>
      assertPostgresAuthStoreSeparation('postgres://u@db.internal/biz', [{ url: 'postgres://u@db.internal:5432/biz' }]),
    );
  });
});

test('a store URL expands only ${NAME}: a bare $ is literal, so a password may contain one', () => {
  withEnv({ word: 'expanded', AUTH_DB_PASSWORD: 'hunter2' }, () => {
    assert.equal(appAuthStore(loaded('postgres://auth:pa$word@db.internal/authdb')), 'postgres://auth:pa$word@db.internal/authdb');
    assert.equal(
      appAuthStore(loaded('postgres://auth:$${AUTH_DB_PASSWORD}@db.internal/authdb')),
      'postgres://auth:$hunter2@db.internal/authdb',
    );
  });
  withEnv({ word: undefined }, () => {
    assert.equal(
      appAuthStore(loaded('postgres://auth:pa$word@db.internal/authdb')),
      'postgres://auth:pa$word@db.internal/authdb',
      'an unset bare name is not a reference either',
    );
  });
  // A business connection keeps both spellings, as the registry reads it.
  assert.equal(expandEnv('a$b', { b: 'c' }), 'ac');
  assert.equal(expandEnvReferences('a$b${b}', { b: 'c' }), 'a$bc');
});

test('PostgreSQL store separation uses the captured App environment for URL references, but PG* driver defaults stay with process.env', () => {
  const store = 'postgres://auth:secret@db.internal/authdb';
  const appEnv = { APP_DB_URL: 'postgres://app:pw@db.internal/authdb' };
  const business = [{ url: '${APP_DB_URL}' }];
  // With the App-provided alias the two URLs reach the same database.
  assert.throws(() => assertPostgresAuthStoreSeparation(store, business, appEnv), SEPARATION, 'App env alias resolves to the store');
  // Without the alias the connection is compared as written and is not PostgreSQL-shaped.
  withEnv({ APP_DB_URL: undefined }, () => {
    assert.doesNotThrow(() => assertPostgresAuthStoreSeparation(store, business), 'process env must not supply a missing App alias');
  });
  // The actual pg driver fills omitted host/database/port from process.env PG*,
  // so the comparison does too, even when a captured App environment is present.
  withEnv({ PGHOST: 'db.internal', PGPORT: '5432', PGDATABASE: 'authdb', PGUSER: 'u' }, () => {
    assert.throws(
      () =>
        assertPostgresAuthStoreSeparation('postgres://u@/', [{ url: 'postgres://u@db.internal/authdb' }], {
          PGHOST: 'other.internal',
          PGPORT: '6000',
          PGDATABASE: 'otherdb',
          PGUSER: 'other',
        }),
      SEPARATION,
      'PG* defaults follow process.env, not the captured App environment',
    );
  });
  // A conflicting App PGDATABASE does not override the process default.
  withEnv({ PGHOST: 'db.internal', PGPORT: '5432', PGDATABASE: 'shared', PGUSER: 'u' }, () => {
    assert.throws(
      () =>
        assertPostgresAuthStoreSeparation('postgres://u@/', [{ url: 'postgres://u@db.internal/shared' }], {
          PGHOST: 'db.internal',
          PGPORT: '5432',
          PGDATABASE: 'not-shared',
          PGUSER: 'u',
        }),
      SEPARATION,
      'process PGDATABASE default wins over conflicting App PGDATABASE',
    );
  });
});
