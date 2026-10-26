import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceThemes, resolveTheme, roleTheme, type ThemeAsk } from '../packages/engine/src/shared/themeResolve.js';

const OFFERED = new Set(['lumen', 'mono', 'sage', 'cadence', 'workshop']);
const ask = (more: Partial<ThemeAsk>): ThemeAsk => ({
  offered: (id) => OFFERED.has(id),
  preset: 'sage',
  for: { public: 'cadence', roles: { rider: 'cadence', mechanic: 'workshop' } },
  ...more,
});

test('resolveTheme ranks public, then the reader, then the role, the tenant, the App and Lumen', () => {
  const rows: Array<[string, Partial<ThemeAsk>, string, string]> = [
    // A public surface wears for.public, a reader's pick included: the page is the same for everyone.
    ['public page, reader picked mono', { public: true, pick: 'mono' }, 'cadence', 'public'],
    // With no for.public, a public page keeps today's chain.
    ['public page, no for.public', { public: true, pick: 'mono', for: { roles: { rider: 'cadence' } } }, 'mono', 'reader'],
    ['public page, nothing picked, no for.public', { public: true, for: {} }, 'sage', 'app'],
    // A signed-in reader's own pick wins over the role map.
    ['rider who picked mono', { roles: ['rider'], pick: 'mono' }, 'mono', 'reader'],
    ['rider', { roles: ['rider'] }, 'cadence', 'role'],
    ['mechanic', { roles: ['mechanic'] }, 'workshop', 'role'],
    // The first entry in written order the account holds, not the order of its roles.
    ['mechanic who rides', { roles: ['mechanic', 'rider'] }, 'cadence', 'role'],
    // The role map ranks above the tenant's saved theme.
    ['rider at a tenant with mono', { roles: ['rider'], tenant: 'mono' }, 'cadence', 'role'],
    ['manager at a tenant with mono', { roles: ['manager'], tenant: 'mono' }, 'mono', 'tenant'],
    ['manager', { roles: ['manager'] }, 'sage', 'app'],
    // An id the App no longer offers falls through to the next rank.
    ['a retired pick', { roles: ['manager'], pick: 'harbor' }, 'sage', 'app'],
    ['nothing at all', { preset: undefined, for: undefined }, 'lumen', 'default'],
  ];
  for (const [name, more, id, source] of rows) {
    const worn = resolveTheme(ask(more));
    assert.equal(worn.id, id, name);
    assert.equal(worn.source, source, name);
  }
  assert.equal(resolveTheme(ask({ roles: ['mechanic'] })).role, 'mechanic');
});

test('a role mapped to a theme the App does not offer falls through to the next entry', () => {
  const worn = resolveTheme(ask({ roles: ['rider', 'mechanic'], for: { roles: { rider: 'harbor', mechanic: 'workshop' } } }));
  assert.deepEqual(worn, { id: 'workshop', source: 'role', role: 'mechanic' });
});

test('roleTheme and audienceThemes read the mapping in written order', () => {
  const audiences = { public: 'cadence', roles: { rider: 'cadence', mechanic: 'workshop' } };
  assert.equal(roleTheme(audiences, ['mechanic', 'rider']), 'cadence');
  assert.equal(roleTheme(audiences, ['manager']), undefined);
  assert.deepEqual(audienceThemes(audiences), ['cadence', 'workshop']);
  assert.deepEqual(audienceThemes(undefined), []);
});
