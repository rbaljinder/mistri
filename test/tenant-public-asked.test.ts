/**
 * A tenant App's public form asks an input by its tenant's shared profile (`when: "tenant.country = 'US'"`), on SQLite
 * and on PostgreSQL. A public form is never prepared, so its read judges those parts for the tenant its link's `?via=`
 * places: north (in the US) is asked the state with nothing left to judge, south (in Canada) is not asked it, and an
 * address that places nobody holds no profile, so is not asked it either. The browser is told which, never the country.
 * The submission is judged by the same profile: a state sent to south is refused, and north's is required. A choice's
 * option offered by the profile (`reach`'s text message) is served to north alone, with no `when`, and refused from south.
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
      return answer.body.form.input as Array<{ name: string; when?: string; options?: Array<{ value: string; when?: string }> }>;
    };
    const submit = (f: TenantPublicForms, address: string, input: Record<string, unknown>) =>
      f.call(`/api/forms/ask${via(address)}`, { body: { input, submission: randomUUID() } });

    test("the read serves an input for the tenant's profile, and tells nothing of it", async (t) => {
      const f = await open(t);
      const north = await served(f, via(NORTH));
      assert.deepEqual(
        north.map((field) => field.name),
        ['name', 'state', 'reach'],
      );
      assert.equal(north.find((field) => field.name === 'state')!.when, undefined, 'judged whole, nothing left for the page');
      assert.deepEqual(
        north.find((field) => field.name === 'reach')!.options,
        [
          { value: 'email', label: 'Email' },
          { value: 'text', label: 'Text message' },
        ],
        'the offered option is served with no when',
      );
      for (const query of [via(SOUTH), via(UNKNOWN), '']) {
        const elsewhere = await served(f, query);
        assert.deepEqual(
          elsewhere.map((field) => field.name),
          ['name', 'reach'],
          `not asked: ${query || 'no address'}`,
        );
        assert.deepEqual(
          elsewhere.find((field) => field.name === 'reach')!.options!.map((option) => option.value),
          ['email'],
          `not offered: ${query || 'no address'}`,
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
      const northern = await submit(f, NORTH, { name: 'Di', state: 'NY', reach: 'text' });
      assert.equal(northern.status, 200, northern.text);
      const unoffered = await submit(f, SOUTH, { name: 'Ed', reach: 'text' });
      assert.equal(unoffered.status, 400, unoffered.text);
      assert.equal(unoffered.body.field, 'reach');
      assert.equal(unoffered.body.error, `"text" is not one of the choices.`);
      assert.deepEqual(await f.rows('SELECT tenant_id, reference FROM lead ORDER BY reference'), [
        { tenant_id: 'south', reference: 'YRD-A-Bea-none' },
        { tenant_id: 'north', reference: 'YRD-A-Di-NY' },
      ]);
    });
  });
}
