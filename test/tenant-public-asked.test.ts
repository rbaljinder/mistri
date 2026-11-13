/**
 * A tenant App's public form asks an input by its tenant's shared profile (`when: "tenant.country = 'US'"`), on SQLite
 * and on PostgreSQL. A public form is never prepared, so its read judges those parts for the tenant its link's `?via=`
 * places: north (in the US) is asked the state with nothing left to judge, south (in Canada) is not asked it, and an
 * address that places nobody holds no profile, so is not asked it either. The browser is told which, never the country.
 * The submission is judged by the same profile: a state sent to south is refused, and north's is required.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { dropDedicatedPostgresDatabase, TENANT_DIALECTS } from './support/tenantDialects.js';
import {
  NORTH,
  openTenantPublicForms,
  publicFormsDatabase,
  SOUTH,
  UNKNOWN,
  via,
  type TenantPublicForms,
} from './support/tenantPublicForms.js';

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a tenant App's public form asks by its tenant's profile (${dialect})`, { skip }, () => {
    const database = publicFormsDatabase();
    after(async () => {
      if (dialect === 'postgres') await dropDedicatedPostgresDatabase(database);
    });
    const open = (t: Parameters<typeof openTenantPublicForms>[0]) => openTenantPublicForms(t, dialect, database, { askByCountry: true });
    const served = async (f: TenantPublicForms, query: string) => {
      const answer = await f.call(`/api/forms/ask${query}`);
      assert.equal(answer.status, 200, answer.text);
      return answer.body.form.input as Array<{ name: string; when?: string }>;
    };
    const submit = (f: TenantPublicForms, address: string, input: Record<string, unknown>) =>
      f.call(`/api/forms/ask${via(address)}`, { body: { input, submission: randomUUID() } });

    test("the read serves an input for the tenant's profile, and tells nothing of it", async (t) => {
      const f = await open(t);
      const north = await served(f, via(NORTH));
      assert.deepEqual(
        north.map((field) => field.name),
        ['name', 'state'],
      );
      assert.equal(north.find((field) => field.name === 'state')!.when, undefined, 'judged whole, nothing left for the page');
      for (const query of [via(SOUTH), via(UNKNOWN), '']) {
        assert.deepEqual(
          (await served(f, query)).map((field) => field.name),
          ['name'],
          `not asked: ${query || 'no address'}`,
        );
      }
      const said = JSON.stringify(await f.call(`/api/forms/ask${via(NORTH)}`).then((answer) => answer.body));
      assert.doesNotMatch(said, /tenant\.country|"US"/);
    });

    test('the submission is judged by the same profile', async (t) => {
      const f = await open(t);
      const refused = await submit(f, SOUTH, { name: 'Ada', state: 'ON' });
      assert.equal(refused.status, 400, refused.text);
      assert.equal(refused.body.field, 'state');
      const southern = await submit(f, SOUTH, { name: 'Bea' });
      assert.equal(southern.status, 200, southern.text);
      const missing = await submit(f, NORTH, { name: 'Cy' });
      assert.equal(missing.status, 400, missing.text);
      const northern = await submit(f, NORTH, { name: 'Di', state: 'NY' });
      assert.equal(northern.status, 200, northern.text);
      assert.deepEqual(await f.rows('SELECT tenant_id, reference FROM lead ORDER BY reference'), [
        { tenant_id: 'south', reference: 'YRD-A-Bea-none' },
        { tenant_id: 'north', reference: 'YRD-A-Di-NY' },
      ]);
    });
  });
}
