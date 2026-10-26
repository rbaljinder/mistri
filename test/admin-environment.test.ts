/**
 * UX-4: the first-start admin variables (MISTRI_AUTH_ADMIN_EMAIL and
 * _PASSWORD) are read once, to make one account. Set and then ignored — half
 * of the pair, an App that signs no one in, or an account already in the store
 * with another password — the log says so and why, rather than leaving a
 * sign-in screen that refuses the password the operator just set.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAppAuth, ignoredAdminEnvironment } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

test('a half-set pair or an App with no sign-in is named as the reason no admin account was made', () => {
  assert.equal(ignoredAdminEnvironment({}, 'Desk', true), undefined);
  assert.equal(
    ignoredAdminEnvironment({ MISTRI_AUTH_ADMIN_EMAIL: 'a@example.org', MISTRI_AUTH_ADMIN_PASSWORD: 'pw' }, 'Desk', true),
    undefined,
  );
  assert.match(
    ignoredAdminEnvironment({ MISTRI_AUTH_ADMIN_EMAIL: 'a@example.org' }, 'Desk', true) ?? '',
    /MISTRI_AUTH_ADMIN_EMAIL is set but MISTRI_AUTH_ADMIN_PASSWORD is not, so no admin account was made for "Desk"/,
  );
  assert.match(
    ignoredAdminEnvironment({ MISTRI_AUTH_ADMIN_PASSWORD: 'pw' }, 'Desk', true) ?? '',
    /MISTRI_AUTH_ADMIN_PASSWORD is set but MISTRI_AUTH_ADMIN_EMAIL is not/,
  );
  assert.match(
    ignoredAdminEnvironment({ MISTRI_AUTH_ADMIN_EMAIL: 'a@example.org', MISTRI_AUTH_ADMIN_PASSWORD: 'pw' }, 'Desk', false) ?? '',
    /"Desk" declares no auth, so no one signs in to it and no admin account was made/,
  );
});

test(
  'an admin account already in the store with another password is said to be unchanged, and where the store is',
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-admin-env-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = join(directory, 'auth.db');
    const loaded = {
      path: join(directory, 'app.ts'),
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: 'desk',
          name: 'Desk',
          auth: { store },
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'admin environment fixture',
      ),
    };
    const start = async (password: string) => {
      const said: string[] = [];
      const error = t.mock.method(console, 'error', (...args: unknown[]) => void said.push(args.join(' ')));
      const log = t.mock.method(console, 'log', () => {});
      try {
        const auth = await createAppAuth(loaded, {
          baseURL: 'http://127.0.0.1:1',
          trustedOrigins: ['http://127.0.0.1:1'],
          environment: {
            BETTER_AUTH_SECRET: 'synthetic-admin-environment-secret-thirty-two-plus',
            MISTRI_AUTH_ADMIN_EMAIL: 'owner@example.org',
            MISTRI_AUTH_ADMIN_PASSWORD: password,
          },
        });
        auth.close();
      } finally {
        error.mock.restore();
        log.mock.restore();
      }
      return said.filter((line) => line.includes('MISTRI_AUTH_ADMIN'));
    };

    assert.deepEqual(await start('first-fixture-password-1'), []);
    // The same password again is the ordinary restart: nothing to say.
    assert.deepEqual(await start('first-fixture-password-1'), []);
    const changed = await start('second-fixture-password-2');
    assert.equal(changed.length, 1, changed.join('\n'));
    assert.ok(changed[0].includes(`owner@example.org already exists in ${store} with another password`), changed[0]);
    assert.match(changed[0], /MISTRI_AUTH_ADMIN_PASSWORD was not applied/);
  },
);
