import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/* T1, from a field report: an App with sign-in whose look ships a font file stopped at startup with only "the tenant
   context could not be verified", while check and build passed. Sign-in takes a loaded App only by keys it names, and
   `fonts` was not one of them (apps.ts LOADED_APP_KEYS). The tenant start had the same list (tenant-startup.test.ts). */
test('an App with sign-in whose look ships font files starts its sign-in', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-fonts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const auth = await createAppAuth(
    {
      path: join(directory, 'app.ts'),
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: 'fonts-app',
          name: 'Fonts fixture',
          auth: { signUp: 'open', store: join(directory, 'auth.db') },
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'fonts fixture',
      ),
      fonts: { files: { 'face-0123456789ab.woff2': Buffer.from('wOF2') }, sources: {} },
    },
    {
      baseURL: 'http://127.0.0.1:1',
      trustedOrigins: ['http://127.0.0.1:1'],
      environment: { BETTER_AUTH_SECRET: 'synthetic-fonts-secret-at-least-thirty-two-characters' },
    },
  );
  t.after(() => auth.close());
  assert.equal(typeof auth.handler, 'function');
});
