/**
 * A tenant App's service principal, driven by the test kit (`host.service(tenant, role)`, testing/host.ts), on the
 * clinic fixture with a service role and a jobs module beside it, SQLite always and PostgreSQL live-gated.
 *
 * What is proved: the actor runs a command as a job's principal runs it (tenant/tenantJobs.ts) — its role's grant,
 * the tenant's anchors, the job door — so a service role runs what a member's role is refused; a role a person holds,
 * a platform role or one the App does not define is refused by name before anything runs; and the tenant named is
 * the only one written, a record of another tenant being out of the actor's reach as it is out of a member's.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startClinic, type Engine } from './support/clinicFixture.ts';

const ROOT = resolve('.');
const ENGINES: Engine[] = process.env.TABLEWALK_TEST_PG ? ['sqlite', 'postgres'] : ['sqlite'];

/** The clinic, copied beside the repository's packages and given a service role, its command and a jobs module. */
function serviceClinicApp(t: TestContext): string {
  const work = mkdtempSync(join(ROOT, 'test', '.service-actor-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const dir = join(work, 'clinic');
  cpSync(join(ROOT, 'test', 'fixtures', 'apps', 'clinic'), dir, { recursive: true });
  const edit = (file: string, from: string, to: string) => {
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    assert.ok(text.includes(from), `${file} holds ${from}`);
    writeFileSync(path, text.replace(from, to));
  };
  // Billing is the clinic's machine: it posts reminders, which no person's role is granted, and records payments.
  edit(
    'app.ts',
    '      operator: {',
    "      billing: { label: 'Billing', realm: 'tenant', service: true, read: clinicReads, commands: ['recordPayment', 'postReminder'] },\n      operator: {",
  );
  edit(
    'commands.ts',
    'export default defineCommands({ recordPayment, postNotice, requestVisit });',
    `/** A clinic's reminder, posted by its billing service. */
export const postReminder = defineCommand({
  source,
  target: 'notice',
  targets: 'none',
  input: { body: { label: 'Reminder', type: 'text', max: 200 } },
  output: shape({ notice: text(), visit: text() }),
  async handle({ db, publicLink }, value) {
    const id = \`nt-\${randomUUID()}\`;
    await db.notice.insert({ id, body: value.body });
    return { notice: id, visit: publicLink('request-visit') };
  },
});

export default defineCommands({ recordPayment, postNotice, requestVisit, postReminder });`,
  );
  edit(
    'server/tenant-policy.ts',
    '    requestVisit: () => [],',
    "    requestVisit: () => [],\n    postReminder: (result) => [{ table: 'notice', key: { id: (result as { notice: string }).notice } }],",
  );
  writeFileSync(
    join(dir, 'jobs.ts'),
    `import { defineJob, defineJobs } from '@mistriwork/mistri/jobs';

export default defineJobs(
  { morningReminders: defineJob({ every: '@daily', realm: 'tenant', runAs: 'billing', command: 'postReminder' }) },
  { principals: { billing: { roles: ['billing'] } }, store: { namespace: 'clinic' } },
);
`,
  );
  return dir;
}

for (const engine of ENGINES) {
  test(`host.service runs a tenant command as a service role, in one tenant only (${engine})`, { timeout: 240_000 }, async (t) => {
    const { host } = await startClinic(t, engine, { app: serviceClinicApp(t), jobs: true });
    // A service binds to the platform's anchor as well as the tenant's, as any job delivery does: the platform is made
    // active here as an operator's first sign-in makes it.
    await host.platform({ roles: ['operator'] });
    const northOwner = await host.tenant('north', { roles: ['owner'] });
    const northReception = await host.tenant('north', { roles: ['reception'] });
    const southOwner = await host.tenant('south', { roles: ['owner'] });
    const billing = host.service('north', 'billing');

    await t.test('the service role runs a command no member role is granted', async () => {
      const member = await northReception.command('postReminder', {}, { body: 'Your visit is tomorrow.' }, { version: 1 });
      assert.equal(member.ok, false);
      assert.equal(member.ok ? undefined : member.code, 'forbidden');

      const ran = await billing.run('postReminder', { body: 'Your visit is tomorrow.' });
      assert.ok(ran.ok, JSON.stringify(ran));
      assert.equal(ran.value.command, 'postReminder');
      const { notice, visit } = ran.value.result as { notice: string; visit: string };
      // The answer says the public link as the tenant's own address, never as the reference the handler returned.
      assert.match(visit, /^https?:\/\/[^ ]+\/request-visit\?via=/, visit);
      assert.ok(!JSON.stringify(ran.value).includes('mistri-public:'), 'no raw public reference is delivered');
      const north = await northOwner.rows('notice');
      assert.ok(north.ok);
      assert.ok(north.value.some((row) => row.id === notice && row.body === 'Your visit is tomorrow.'));
      const south = await southOwner.rows('notice');
      assert.ok(south.ok);
      assert.ok(!south.value.some((row) => row.id === notice), "the reminder is north's alone");
    });

    await t.test('a record command reaches the named tenant and no other', async () => {
      const paid = await billing.run('recordPayment', { amount_cents: 12000, method: 'card' }, { key: { id: 'ap-north-1' } });
      assert.ok(paid.ok, JSON.stringify(paid));
      const north = await northOwner.rows('appointment', { where: "id = 'ap-north-1'" });
      assert.ok(north.ok);
      assert.equal(north.value[0]?.status, 'paid');

      const foreign = await billing.run('recordPayment', { amount_cents: 9000, method: 'card' }, { key: { id: 'ap-south-1' } });
      assert.equal(foreign.ok, false, "south's appointment is out of north's service");
      assert.equal(foreign.ok ? undefined : foreign.status, 403, 'refused as a member is refused a record of another tenant');
      const south = await southOwner.rows('appointment', { where: "id = 'ap-south-1'" });
      assert.ok(south.ok);
      assert.equal(south.value[0]?.status, 'booked');

      const nowhere = await host.service('nowhere', 'billing').run('postReminder', { body: 'x' });
      assert.equal(nowhere.ok, false, 'a tenant that is not active is refused');
    });

    await t.test('a role a person holds, a platform role or an undefined one is refused by name', async () => {
      for (const role of ['reception', 'owner', 'operator', 'ghost']) {
        const refused = await host.service('north', role).run('postReminder', { body: 'x' });
        assert.equal(refused.ok, false, role);
        if (refused.ok) continue;
        assert.equal(refused.status, 403, role);
        assert.equal(refused.code, 'not_a_service_role', role);
        assert.match(refused.message, new RegExp(`"${role}"`), role);
      }
      const notices = await northOwner.rows('notice');
      assert.ok(notices.ok);
      assert.ok(!notices.value.some((row) => row.body === 'x'), 'nothing a refused actor ran was written');
    });
  });
}
