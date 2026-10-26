import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlagValidationError, normalizeFlagCatalog, type FlagContext } from '../packages/mistri/src/shared/appFlags.js';
import { audienceBucket, inAudience, provenEmailDomain } from '../packages/mistri/src/server/flags/audience.js';
import { createFlagEvaluator } from '../packages/mistri/src/server/flags/evaluation.js';
import { epochAdmits } from '../packages/mistri/src/server/experiments/eligibility.js';
import { identifyEpoch } from '../packages/mistri/src/server/experiments/contracts.js';

const at = { appId: 'market', environment: 'production' };
const subject = (id: string, extra: Partial<FlagContext> = {}): FlagContext => ({ identity: { kind: 'subject', id }, ...extra });
const member = (audience: Parameters<typeof inAudience>[1], context: FlagContext, tenantId: string | null = null, name = 'a') =>
  inAudience(name, audience, { ...at, tenantId, context });
const ids = Array.from({ length: 2000 }, (_, i) => `account-${i}`);

test('roles: a member of any one listed role', () => {
  assert.equal(member({ roles: ['staff', 'ops'] }, subject('s', { roles: ['ops'] })), true);
  assert.equal(member({ roles: ['staff'] }, subject('s', { roles: ['reader'] })), false);
  assert.equal(member({ roles: ['staff'] }, {}), false);
});

test('tenants: only inside a listed tenant, never outside every tenant', () => {
  assert.equal(member({ tenants: ['north'] }, {}, 'north'), true);
  assert.equal(member({ tenants: ['north'] }, {}, 'south'), false);
  assert.equal(member({ tenants: ['north'] }, {}, null), false);
});

test('attributes: an email domain the server verified, and nothing a caller could have typed', () => {
  const partners = { attributes: { emailDomain: ['partner.example'] } };
  assert.equal(member(partners, subject('s', { attributes: { emailDomain: 'partner.example' } })), true);
  assert.equal(member(partners, subject('s', { attributes: { emailDomain: 'other.example' } })), false);
  assert.equal(member(partners, subject('s')), false, 'a visitor or service has no proven address');
  assert.equal(provenEmailDomain({ who: 'Ada@Partner.Example' }), 'partner.example');
  assert.equal(provenEmailDomain({ who: 'ada@partner.example', emailUnproven: true }), undefined);
  assert.equal(provenEmailDomain({ who: 'not-an-address' }), undefined);
  assert.equal(provenEmailDomain({}), undefined);
});

test('allow and deny name accounts and decide first; a list alone is the whole audience', () => {
  const staff = { roles: ['staff'], allow: ['guest'], deny: ['leaver'] };
  assert.equal(member(staff, subject('guest')), true, 'allowed without the role');
  assert.equal(member(staff, subject('leaver', { roles: ['staff'] })), false, 'denied despite the role');
  assert.equal(member(staff, subject('other', { roles: ['staff'] })), true);
  assert.equal(member({ allow: ['guest'] }, subject('guest')), true);
  assert.equal(member({ allow: ['guest'] }, subject('other')), false);
  assert.equal(member({ deny: ['leaver'] }, subject('leaver')), false);
  assert.equal(member({ deny: ['leaver'] }, subject('other')), true);
  // A visitor id is a cookie anyone holds, never an account a list names.
  assert.equal(member({ allow: ['guest'] }, { identity: { kind: 'visitor', id: 'guest' } }), false);
});

test('every condition given must hold', () => {
  const audience = { roles: ['staff'], tenants: ['north'], attributes: { emailDomain: ['partner.example'] } };
  const all = subject('s', { roles: ['staff'], attributes: { emailDomain: 'partner.example' } });
  assert.equal(member(audience, all, 'north'), true);
  assert.equal(member(audience, all, 'south'), false);
  assert.equal(member(audience, { ...all, roles: [] }, 'north'), false);
  assert.equal(member(audience, { ...all, attributes: {} }, 'north'), false);
});

test('rollout: 0 and 100 are exact, an identity is needed, and widening only adds people', () => {
  assert.equal(
    ids.every((id) => !member({ rollout: 0 }, subject(id))),
    true,
  );
  assert.equal(
    ids.every((id) => member({ rollout: 100 }, subject(id))),
    true,
  );
  assert.equal(member({ rollout: 100 }, {}), false);
  const at10 = new Set(ids.filter((id) => member({ rollout: 10 }, subject(id)))),
    at30 = ids.filter((id) => member({ rollout: 30 }, subject(id)));
  assert.ok(
    [...at10].every((id) => at30.includes(id)),
    'everyone in at 10% stays in at 30%',
  );
  assert.ok(at30.length > 500 && at30.length < 700, `${at30.length} of 2000 at 30%`);
});

test('the bucket is stable across releases and salted by the audience, not by a flag', () => {
  const bucket = audienceBucket({ ...at, audience: 'beta', kind: 'subject', id: 'account-1' });
  assert.equal(bucket, audienceBucket({ ...at, audience: 'beta', kind: 'subject', id: 'account-1' }));
  assert.ok(bucket >= 0 && bucket < 100);
  // Pinned: a change here would reshuffle every rollout already serving.
  assert.equal(bucket.toFixed(6), '59.646969');
  const beta = new Set(ids.filter((id) => member({ rollout: 20 }, subject(id), null, 'beta')));
  const pilot = ids.filter((id) => member({ rollout: 20 }, subject(id), null, 'pilot'));
  assert.notDeepEqual(pilot, [...beta], 'two audiences of the same share are different people');
  assert.notEqual(
    audienceBucket({ ...at, audience: 'beta', kind: 'subject', id: 'x' }),
    audienceBucket({ ...at, audience: 'beta', kind: 'visitor', id: 'x' }),
  );
});

test('a flag rule and an experiment naming the same audience reach the same people', () => {
  const catalog = normalizeFlagCatalog({
    flags: { copy: { type: 'string', default: 'a', variants: ['a', 'b'], owner: 'team', tenantManaged: true } },
    roles: ['member'],
    audiences: { beta: { roles: ['member'], rollout: 25 } },
  });
  const scope = { appId: at.appId, environment: at.environment, tenantId: null };
  const epoch = identifyEpoch(
    { suiteId: 'suite', deploymentId: 'deployment' },
    {
      scope: { appId: at.appId, environment: at.environment, controlTenantId: null, evaluationTenantId: null },
      flagId: 'copy',
      version: 'v1',
      owner: 'team',
      unit: 'subject',
      control: 'a',
      arms: [
        { id: 'a', value: 'a', weight: 50 },
        { id: 'b', value: 'b', weight: 50 },
      ],
      eligibility: { rollout: 100, audiences: { beta: catalog.audiences.beta } },
      startsAtMs: 1000,
      endsAtMs: 2000,
      conversionWindowMs: 100,
      deliveryGraceMs: 0,
      primary: { id: 'submitted', event: 'submitted', eventVersion: 1, unitField: 'actorId' },
      guardrails: [],
    },
  ).declaration;
  let both = 0;
  for (const id of ids.slice(0, 400)) {
    const context = subject(id, { roles: ['member'] });
    const flagged =
      createFlagEvaluator({
        catalog,
        scope,
        context,
        snapshot: { ...scope, revision: 1, overrides: { copy: { rules: [{ audiences: ['beta'], value: 'b' }] } } },
      }).evaluate('copy').reason === 'target';
    assert.equal(epochAdmits(epoch, context, null), flagged, id);
    if (flagged) both++;
  }
  assert.ok(both > 50 && both < 150, `${both} of 400`);
});

test('an audience is closed: a condition, declared roles, lowercase domains, and no account both allowed and denied', () => {
  const catalog = (audience: unknown) => normalizeFlagCatalog({ flags: {}, roles: ['staff'], audiences: { a: audience } });
  for (const audience of [
    {},
    { roles: [] },
    { roles: ['auditor'] },
    { attributes: {} },
    { attributes: { emailDomain: [] } },
    { attributes: { emailDomain: ['Partner.Example'] } },
    { attributes: { emailDomain: ['@partner.example'] } },
    { attributes: { plan: ['enterprise'] } },
    { rollout: 101 },
    { allow: ['x'], deny: ['x'] },
    { expression: 'true' },
  ])
    assert.throws(() => catalog(audience), FlagValidationError, JSON.stringify(audience));
  assert.deepEqual(catalog({ deny: ['b', 'a'], roles: ['staff'] }).audiences.a, { roles: ['staff'], deny: ['a', 'b'] });
});

test("a tenant's public intake: an anonymous visitor is bucketed by its visitor id, inside that tenant only", () => {
  const intake = { tenants: ['north'], rollout: 50 };
  const visitors = ids.map((id) => ({ identity: { kind: 'visitor' as const, id: `visitor-${id}` }, tenantId: 'north' }));
  const admitted = visitors.filter((context) => member(intake, context, 'north'));
  assert.ok(admitted.length > 900 && admitted.length < 1100, `${admitted.length} of 2000`);
  assert.equal(
    admitted.every((context) => member(intake, context, 'north')),
    true,
    'the same visitor gets the same answer on every request',
  );
  assert.equal(
    visitors.some((context) => member(intake, { ...context, tenantId: 'south' }, 'south')),
    false,
  );
  // Without a visitor cookie (no consent) a share has nobody to bucket.
  assert.equal(member(intake, { tenantId: 'north' }, 'north'), false);
});
