/**
 * The tenant docs' policy reference (site/src/content/docs/docs/tenant-apps.md, "Policy reference") and its whole
 * example, held to the validator they describe (packages/mistri/src/server/policy/appTenantPolicy.ts): the example loads as
 * written; the table names exactly the keys the policy takes, each part's keys exactly the ones it takes; what it
 * says is required is refused when absent, and what it gives a default is not; and each limit it states is the one
 * the validator draws, at it and one past it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  defineAppTenantPolicy,
  loadAppTenantPolicy,
  TENANT_ASSISTANT_RETENTION_DAYS,
  type AppTenantPolicy,
} from '../packages/mistri/src/server/policy/appTenantPolicy.ts';
import { refusalReasons } from '../packages/engine/src/shared/refusal.ts';

const PAGE = readFileSync(resolve('site/src/content/docs/docs/tenant-apps.md'), 'utf8');
const DAY = 24 * 60 * 60 * 1000;

/** The reference table's rows, by key: `administration.id`, `.version` is two rows. */
function reference() {
  const section = PAGE.slice(PAGE.indexOf('### Policy reference'));
  const rows = new Map<string, { type: string; fallback: string; limit: string }>();
  for (const line of section.split('\n').slice(1)) {
    if (line.startsWith('## ') || line.startsWith('### ')) break;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    if (cells.length < 6 || !cells[1].startsWith('`')) continue;
    const [, keys, type, fallback, limit] = cells;
    let parent = '';
    for (const [, key] of keys.matchAll(/`([^`]+)`/g)) {
      const path = key.startsWith('.') ? `${parent}${key}` : key;
      parent = path.includes('.') ? path.slice(0, path.indexOf('.')) : '';
      rows.set(path, { type, fallback, limit });
    }
  }
  return rows;
}
const ROWS = reference();
const top = [...new Set([...ROWS.keys()].map((path) => path.split('.')[0]))].sort();
const under = (part: string) =>
  [...ROWS.keys()]
    .filter((path) => path.startsWith(`${part}.`))
    .map((path) => path.slice(part.length + 1))
    .sort();

/** The page's whole example, loaded as an author's module is. */
async function example(): Promise<AppTenantPolicy> {
  const start = PAGE.indexOf('A whole policy');
  const block = /```ts\n([\s\S]*?)```/.exec(PAGE.slice(start));
  assert.ok(start > 0 && block, 'the page has its whole policy example');
  const directory = mkdtempSync(join(resolve('test'), '.policy-reference-'));
  try {
    const file = join(directory, 'tenant-policy.ts');
    writeFileSync(file, block[1]);
    return await loadAppTenantPolicy(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Whether the validator takes `policy`, and its reason when it does not. */
function judged(policy: unknown): { ok: true } | { ok: false; reason: string } {
  try {
    defineAppTenantPolicy(policy as AppTenantPolicy);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: refusalReasons(error).join(' / ') };
  }
}
const takes = (policy: unknown, what: string) => {
  const verdict = judged(policy);
  assert.ok(verdict.ok, `${what}: ${verdict.ok ? '' : verdict.reason}`);
};
const refuses = (policy: unknown, what: string) => assert.equal(judged(policy).ok, false, `${what} is refused`);

test("the tenant docs' policy reference and example agree with the validator", async (t) => {
  const policy = await example();
  const whole = { ...policy } as Record<string, any>;

  await t.test('the example declares every key the table names, and loads', () => {
    assert.deepEqual(Object.keys(whole).sort(), top);
    for (const part of top) {
      const keys = under(part);
      if (keys.length) assert.deepEqual(Object.keys(whole[part]).sort(), keys, part);
    }
  });

  await t.test('the table names exactly the keys a policy takes', () => {
    const verdict = judged({ ...whole, notAKey: true });
    assert.equal(verdict.ok, false);
    const named = /which is not one of (.+)\./.exec(verdict.ok ? '' : verdict.reason)?.[1];
    assert.ok(named, verdict.ok ? '' : verdict.reason);
    assert.deepEqual(named.split(', ').sort(), top);
    // Each part takes no key the table leaves out.
    for (const part of ['administration', 'invitations', 'support', 'intake', 'public', 'assistant'])
      refuses({ ...whole, [part]: { ...whole[part], notAKey: 1 } }, `${part}.notAKey`);
  });

  await t.test('what it calls required is refused when absent, and what it defaults is not', () => {
    for (const [path, row] of ROWS) {
      const [part, key] = path.split('.');
      const without = key === undefined ? { ...whole, [part]: undefined } : { ...whole, [part]: { ...whole[part], [key]: undefined } };
      // A key left undefined is still named: delete it, as an author who never wrote it.
      if (key === undefined) delete (without as Record<string, unknown>)[part];
      else delete (without as Record<string, Record<string, unknown>>)[part][key];
      // `public` and `resolvePublicRows` come together: either alone is refused, both absent is not.
      if (part === 'public' || part === 'resolvePublicRows') {
        refuses(without, `${path} without its partner`);
        const neither = { ...without };
        delete (neither as Record<string, unknown>).public;
        delete (neither as Record<string, unknown>).resolvePublicRows;
        takes(neither, 'a policy with neither public nor resolvePublicRows');
        continue;
      }
      // Required once a table is the platform's: shown on its own below.
      if (path === 'resolvePlatformRows') continue;
      // A part whose one key is optional is the part left out: no public form, no intake.
      if (key !== undefined && row.fallback !== 'required' && under(part).length === 1) delete (without as Record<string, unknown>)[part];
      if (row.fallback === 'required') refuses(without, `${path} absent`);
      else takes(without, `${path} absent (${row.fallback})`);
    }
    // Every part past the six the table requires may be left out whole.
    for (const part of ['administration', 'invitations', 'support', 'intake', 'assistant']) {
      const { [part]: _left, ...rest } = whole;
      takes(rest, `a policy without ${part}`);
    }
    // resolvePlatformRows is required once a table is the platform's.
    const tenantOnly = { ...whole, ownership: { lead: whole.ownership.lead } };
    for (const name of ['intake', 'public', 'resolvePublicRows', 'resolvePlatformRows'])
      delete (tenantOnly as Record<string, unknown>)[name];
    takes(tenantOnly, 'no platform table and no resolvePlatformRows');
    refuses({ ...tenantOnly, ownership: whole.ownership }, 'a platform table without resolvePlatformRows');
    // Operators may be empty beside delegates, never without.
    for (const part of ['administration', 'invitations']) {
      const { delegates: _delegates, ...alone } = whole[part];
      refuses({ ...whole, [part]: { ...alone, operators: [] } }, `${part} with no operators and no delegates`);
      takes({ ...whole, [part]: { ...whole[part], operators: [] } }, `${part} with delegates and no operators`);
    }
  });

  await t.test('each limit it states is the one the validator draws', () => {
    const at = (path: string, text: string) => assert.ok(ROWS.get(path)?.limit.includes(text), `${path}'s limit says ${text}`);
    const operator = whole.administration.operators[0];
    const many = <T>(count: number, rule: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => rule(index));
    const cases: Array<[string, string, (n: number) => unknown, number]> = [
      ['appId', '256 characters', (n) => ({ ...whole, appId: 'a'.repeat(n) }), 256],
      ['storeId', '256 characters', (n) => ({ ...whole, storeId: 's'.repeat(n) }), 256],
      [
        'ownership',
        '1 to 256 tables',
        (n) => ({
          ...whole,
          ownership: {
            ...whole.ownership,
            ...Object.fromEntries(many(n - 5, (i) => [`extra_${i}`, { kind: 'tenant', column: 'dealer_id' }] as const)),
          },
        }),
        256,
      ],
      [
        'administration.maxMembershipLifetimeMs',
        '366 days',
        (n) => ({ ...whole, administration: { ...whole.administration, maxMembershipLifetimeMs: n } }),
        366 * DAY,
      ],
      [
        'administration.operators',
        '256 rules',
        (n) => ({
          ...whole,
          administration: { ...whole.administration, operators: many(n, (i) => ({ ...operator, accountId: `operator-${i}` })) },
        }),
        256,
      ],
      [
        'administration.operators',
        '1 to 256 tenants',
        (n) => ({
          ...whole,
          administration: { ...whole.administration, operators: [{ ...operator, tenants: many(n, (i) => `tenant-${i}`) }] },
        }),
        256,
      ],
      [
        'invitations.maxMembershipLifetimeMs',
        '366 days',
        (n) => ({ ...whole, invitations: { ...whole.invitations, maxMembershipLifetimeMs: n } }),
        366 * DAY,
      ],
      [
        'invitations.maxRedemptionLifetimeMs',
        '7 days',
        (n) => ({ ...whole, invitations: { ...whole.invitations, maxRedemptionLifetimeMs: n } }),
        7 * DAY,
      ],
      [
        'invitations.maxPendingPerTenant',
        '10000',
        (n) => ({ ...whole, invitations: { ...whole.invitations, maxPendingPerTenant: n } }),
        10000,
      ],
      [
        'invitations.operators',
        '256 rules',
        (n) => ({
          ...whole,
          invitations: {
            ...whole.invitations,
            operators: many(n, (i) => ({
              accountId: `operator-${i}`,
              tenants: ['north'],
              operations: ['issueInvitation'],
              roles: ['staff'],
            })),
          },
        }),
        256,
      ],
      [
        'support.grants',
        '1 to 256',
        (n) => ({
          ...whole,
          support: { ...whole.support, grants: many(n, (i) => ({ platformRole: `role-${i}`, tenants: 'all', dealerRoles: ['staff'] })) },
        }),
        256,
      ],
      [
        'support.grants',
        '1024 tenants',
        (n) => ({
          ...whole,
          support: {
            ...whole.support,
            grants: [{ platformRole: 'automation', tenants: many(n, (i) => `t-${i}`), dealerRoles: ['staff'] }],
          },
        }),
        1024,
      ],
      [
        'assistant.tokensPerTenantPerDay',
        '1000000000',
        (n) => ({ ...whole, assistant: { ...whole.assistant, tokensPerTenantPerDay: n } }),
        1_000_000_000,
      ],
      ['assistant.retentionDays', '3650', (n) => ({ ...whole, assistant: { ...whole.assistant, retentionDays: n } }), 3650],
    ];
    for (const [path, text, build, most] of cases) {
      at(path, text);
      takes(build(most), `${path} at ${most}`);
      refuses(build(most + 1), `${path} at ${most + 1}`);
    }
    // A delegate rule names each operation once across the rules.
    for (const part of ['administration', 'invitations']) {
      at(`${part}.delegates`, 'each operation in one rule');
      const [rule] = whole[part].delegates;
      refuses(
        { ...whole, [part]: { ...whole[part], delegates: [rule, { ...rule, role: 'staff' }] } },
        `${part}: one operation in two rules`,
      );
    }
    // The assistant's retention defaults to what the table says.
    assert.equal(ROWS.get('assistant.retentionDays')!.fallback, String(TENANT_ASSISTANT_RETENTION_DAYS));
  });
});
