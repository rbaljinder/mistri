/**
 * TC4: a theme per audience, `ui.theme.for = { public, roles }`. A portal's riders and a workshop's mechanics wear
 * the App's design for each, and a storefront's signed-out pages one look for everyone. One rule ranks them
 * (themeResolve.ts): a public page wears `for.public`, then the reader's pick, the role's theme, the tenant's, the
 * App's preset and Lumen. The server hands each principal its theme as the preset it wears.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appLook } from '../packages/mistri/src/shared/appUi.js';
import { appForRoles } from '../packages/mistri/src/shared/appViewRoles.js';
import { lookDensityFor, lookSheetsFor } from '../packages/engine/src/server/clientSurface.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';

const cadence = { kind: 'theme', id: 'cadence', label: 'Cadence', extends: 'sage', density: 'spacious' };
const workshop = { kind: 'theme', id: 'workshop', label: 'Workshop', extends: 'mono' };
const app = (theme: Record<string, unknown>) =>
  parseAppConfig(
    {
      name: 'Rides',
      resources: { ride: {} },
      views: { rides: { kind: 'list', from: 'ride' } },
      home: 'rides',
      auth: { roles: { rider: { read: true }, mechanic: { read: true }, manager: { read: true } } },
      ui: { customThemes: [cadence, workshop], theme },
    },
    'app',
  );
const FOR = { public: 'cadence', roles: { rider: 'cadence', mechanic: 'workshop' } };

test('each role wears its theme, the first entry it holds in written order, and the rest the App preset', () => {
  const parsed = app({ preset: 'lumen', palette: 'violet', accent: '#0e7490', for: FOR });
  assert.deepEqual(parsed.ui.theme?.for, FOR);
  const worn = (roles: string[]) => appForRoles(parsed, roles).ui!.theme;
  assert.equal(worn(['rider'])!.preset, 'cadence');
  assert.equal(worn(['mechanic'])!.preset, 'workshop');
  assert.equal(worn(['mechanic', 'rider'])!.preset, 'cadence');
  // A palette is its preset's: under another theme it goes; the App's accent stays over whichever is worn.
  assert.equal(worn(['rider'])!.palette, undefined);
  assert.equal(worn(['rider'])!.accent, '#0e7490');
  assert.equal(worn(['manager']), parsed.ui.theme);
  assert.equal(worn([]), parsed.ui.theme);
  // The same principal is projected once.
  assert.equal(appForRoles(parsed, ['rider']), appForRoles(parsed, ['rider']));
});

test('a signed-out visitor is told the public theme, worn whatever a reader picked', () => {
  const parsed = app({ preset: 'lumen', for: FOR });
  const look = appLook({ ...parsed, id: 'rides' });
  assert.deepEqual(look.theme, { preset: 'cadence', audience: 'public' });
  // Without for.public a visitor is told the App's theme, as before.
  assert.deepEqual(appLook({ id: 'rides', name: 'Rides', ui: app({ preset: 'lumen', for: { roles: FOR.roles } }).ui }).theme, {
    preset: 'lumen',
    for: { roles: FOR.roles },
  });
});

test("a page's first paint is guessed for its audience: a visitor's public theme, a member's role's", () => {
  const ui = app({ preset: 'lumen', for: FOR }).ui;
  assert.deepEqual(lookSheetsFor(ui), ['lumen']);
  assert.deepEqual(lookSheetsFor(ui, { public: true }), ['sage']);
  assert.equal(lookDensityFor(ui, { public: true }), 'spacious');
  assert.deepEqual(lookSheetsFor(ui, { roles: ['mechanic'] }), []);
  assert.deepEqual(lookSheetsFor(ui, { roles: ['manager'] }), ['lumen']);
});

test('an audience names a theme the App offers and a role it declares', () => {
  const refuse = (theme: Record<string, unknown>, pattern: RegExp) => {
    let message = '';
    assert.throws(
      () => app(theme),
      (error: Error) => ((message = error.message), pattern.test(message)),
    );
    return message;
  };
  const off = refuse({ for: { public: 'harbor' } }, /ui\.theme\.for\.public "harbor" is not a built-in theme or one of ui\.customThemes/);
  assert.equal(validationCode(off), 'theme-audience');
  refuse(
    { for: { roles: { rider: 'harbor' } } },
    /ui\.theme\.for\.roles\.rider "harbor" is not a built-in theme or one of ui\.customThemes/,
  );
  refuse({ for: { roles: { courier: 'mono' } } }, /ui\.theme\.for has "roles" naming "courier", which auth\.roles does not declare/);
  refuse({ for: { everyone: 'mono' } }, /ui\.theme\.for has no "everyone"\. It takes: public, roles/);
  refuse({ for: {} }, /ui\.theme\.for names no audience/);
  refuse({ for: { roles: { rider: 7 } } }, /ui\.theme\.for\.roles\.rider must be a theme's id/);
});
