/**
 * A tenant App's public form is said in its visitor's language, on SQLite and on PostgreSQL: the form a dealer's
 * intake address (`?via=`) serves, and the App's list of them, are localized for what the visitor picked (the App's locale
 * cookie), else what their browser asks (`Accept-Language`), else the App's own. The answer varies by both. An App with
 * one catalog has nothing to choose between, so it does not vary by the browser's language. The client reads a form
 * without cookies, so it names the pick in the address (`?locale=`), and that is the answer for the read and the
 * submission alike: among the App's catalogs, else the App's own. A choice from a dealer's
 * table naming a Spanish column (`labelColumns`) offers a Spanish reader that dealer's rows by it, in Spanish order, and
 * a row with none by `labelColumn`; each language's rows are kept in an entry of their own.
 *
 * Its own file: a load holds an App's catalogs under its id, and every fixture here is the App `yard`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, test } from 'node:test';
import { dropDedicatedPostgresDatabase, TENANT_DIALECTS } from './support/tenantDialects.js';
import { cachedTenantChoices } from '../packages/mistri/src/server/forms/choiceCache.js';
import { tenantLiveHub } from '../packages/mistri/src/server/tenant/tenantLive.js';
import {
  APP_ID,
  binding,
  NORTH,
  openTenantPublicForms,
  publicFormsDatabase,
  via,
  type TenantPublicForms,
} from './support/tenantPublicForms.js';

const vary = (headers: Record<string, string | string[] | undefined>) => String(headers.vary ?? '').toLowerCase();

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a tenant App's public form is said in its visitor's language (${dialect})`, { skip }, () => {
    const database = publicFormsDatabase();
    after(async () => {
      if (dialect === 'postgres') await dropDedicatedPostgresDatabase(database);
    });
    const read = async (f: TenantPublicForms, headers: Record<string, string> = {}) => {
      const answer = await f.call(`/api/forms/apply${via(NORTH)}`, { headers });
      assert.equal(answer.status, 200, answer.text);
      return answer;
    };
    const label = async (f: TenantPublicForms, headers: Record<string, string> = {}) => (await read(f, headers)).body.form.label as string;

    test("the form and the list are said in the visitor's pick, else their browser's language, else the App's", async (t) => {
      const f = await openTenantPublicForms(t, dialect, database, { words: 'both' });
      const english = await read(f);
      assert.equal(english.body.form.label, 'Apply for financing');
      assert.match(vary(english.headers), /accept-language/);
      assert.match(vary(english.headers), /cookie/);
      assert.equal(await label(f, { 'accept-language': 'es-MX,es;q=0.9' }), 'Solicitar financiación');
      assert.equal(await label(f, { cookie: 'mistri-locale-yard=es' }), 'Solicitar financiación');
      assert.equal(
        await label(f, { 'accept-language': 'es', cookie: 'mistri-locale-yard=en' }),
        'Apply for financing',
        'the pick over the browser',
      );
      assert.equal(await label(f, { 'accept-language': 'fr' }), 'Apply for financing', 'no French: the App’s own');
      // The platform's words the Spanish catalog says ride with a Spanish form only.
      const spanish = await read(f, { cookie: 'mistri-locale-yard=es' });
      assert.deepEqual(spanish.body.form.words, { 'mistri.form.step': 'Paso {step} de {count}', 'mistri.form.back': 'Atrás' });
      assert.equal(english.body.form.words, undefined);

      // The list names no address (a `?via=` on it is refused): it is the App's, said in the visitor's language too.
      const list = await f.call('/api/forms', { headers: { 'accept-language': 'es' } });
      assert.equal(list.status, 200, list.text);
      const forms = list.body.forms as Array<{ id: string; label: string }>;
      assert.equal(forms.find((form) => form.id === 'apply')?.label, 'Solicitar financiación');
      assert.match(vary(list.headers), /accept-language/);
    });

    test('a form fetched without cookies is said in the language its address names, and so is its submission', async (t) => {
      const f = await openTenantPublicForms(t, dialect, database, { words: 'both', localeReference: true });
      const named = (locale: string) => `/api/forms/apply${via(NORTH)}&locale=${encodeURIComponent(locale)}`;
      const at = async (path: string, headers: Record<string, string> = {}) => {
        const answer = await f.call(path, { headers });
        assert.equal(answer.status, 200, answer.text);
        return answer.body.form.label as string;
      };
      // An English browser with no cookie: the address's pick is the answer, a region's by its language's words.
      assert.equal(await at(named('es'), { 'accept-language': 'en' }), 'Solicitar financiación');
      assert.equal(await at(named('es-MX')), 'Solicitar financiación');
      // Named, the pick is the request's own: neither the cookie nor the browser is asked.
      assert.equal(await at(named('en'), { 'accept-language': 'es', cookie: 'mistri-locale-yard=es' }), 'Apply for financing');
      // A language the App has no words in, or no language at all, is the App's own.
      assert.equal(await at(named('fr'), { 'accept-language': 'es' }), 'Apply for financing');
      assert.equal(await at(named('not a tag!'), { 'accept-language': 'es' }), 'Apply for financing');
      // The form's read names it once, as it names its address once.
      const twice = await f.call(`${named('es')}&locale=en`);
      assert.equal(twice.status, 400, twice.text);
      assert.equal(twice.body.code, 'invalid_input');
      // The list of forms names nothing in its address.
      assert.equal((await f.call('/api/forms?locale=es')).status, 400);

      // The submission's command is run in the language its address names, over the browser's.
      const submit = async (path: string, name: string) => {
        const answer = await f.call(path, { headers: { 'accept-language': 'en' }, body: { input: { name }, submission: randomUUID() } });
        assert.equal(answer.status, 200, answer.text);
        return answer.body.reference as string;
      };
      assert.equal(await submit(named('es-MX'), 'Ada'), 'YRD-Ada-es-MX');
      // No French: the App's own.
      assert.equal(await submit(named('fr'), 'Bea'), 'YRD-Bea-en');
      assert.equal(await submit(`/api/forms/apply${via(NORTH)}`, 'Cy'), 'YRD-Cy-en');
      const doubled = await f.call(`${named('es')}&locale=en`, { body: { input: { name: 'Di' }, submission: randomUUID() } });
      assert.equal(doubled.status, 400, doubled.text);
    });

    test('a saved form is saved and submitted in the language its address names, over the browser and the cookie', async (t) => {
      const f = await openTenantPublicForms(t, dialect, database, { words: 'both', localeReference: true });
      const named = (path: string, locale?: string) =>
        `/api/forms/draft${path}${via(NORTH)}${locale === undefined ? '' : `&locale=${encodeURIComponent(locale)}`}`;
      /* Each call is a visitor of its own (no resume cookie), so each step begins a draft whose reference says the
         language its step ran in. */
      const begin = async (locale: string | undefined, headers: Record<string, string> = {}) => {
        const answer = await f.call(named('/steps/name', locale), {
          headers: { 'accept-language': 'en', ...headers },
          body: { input: { name: 'Ada' }, submission: randomUUID() },
        });
        assert.equal(answer.status, 200, answer.text);
        return String(
          ([] as string[]).concat(answer.headers['set-cookie'] ?? []).find((value) => value.startsWith('mistri_form_draft=')),
        ).split(';')[0]!;
      };
      const languages = async () =>
        (await f.rows('SELECT reference FROM lead'))
          .map((row) => /^YRD-D-([^-]+(?:-[^-]+)?)-[0-9a-f]{8}$/.exec(String(row.reference))?.[1])
          .sort();
      const resume = await begin('es-MX');
      assert.deepEqual(await languages(), ['es-MX'], "the address's pick, a region's, though the browser asks English");
      // Named, the pick is the request's own: neither the browser nor the cookie is asked.
      await begin('en', { 'accept-language': 'es', cookie: 'mistri-locale-yard=es' });
      // A language the App has no words in, and a string that is no tag, are the App's own.
      await begin('fr', { 'accept-language': 'es' });
      await begin('not a tag!', { 'accept-language': 'es' });
      assert.deepEqual(await languages(), ['en', 'en', 'en', 'es-MX']);
      // The submit of the first draft is run in the language its address names, not the one the step was saved in.
      const submitted = await f.call(named('', 'fr'), {
        headers: { 'accept-language': 'es', cookie: resume },
        body: { input: { note: 'Hi' }, submission: randomUUID() },
      });
      assert.equal(submitted.status, 200, submitted.text);
      assert.match(String(submitted.body.reference), /^YRD-D-es-MX-[0-9a-f]{8}\/en$/);
      // Named once on a step, as on the read.
      const twice = await f.call(`${named('/steps/name', 'es')}&locale=en`, { body: { input: { name: 'Bo' }, submission: randomUUID() } });
      assert.equal(twice.status, 400, twice.text);
    });

    test("an App with one catalog does not vary by the browser's language", async (t) => {
      const f = await openTenantPublicForms(t, dialect, database, { words: 'english' });
      const answer = await read(f, { 'accept-language': 'es' });
      assert.equal(answer.body.form.label, 'Apply for financing');
      assert.doesNotMatch(vary(answer.headers), /accept-language/);
    });

    test("a dealer's choices are said by its Spanish column to a Spanish reader, kept apart from its English ones", async (t) => {
      const f = await openTenantPublicForms(t, dialect, database, { words: 'both', publicReads: true, localMakes: true });
      const makes = async (headers: Record<string, string> = {}) => {
        const answer = await f.call(`/api/forms/quote${via(NORTH)}`, { headers });
        assert.equal(answer.status, 200, answer.text);
        const field = answer.body.form.input.find((each: { name: string }) => each.name === 'make');
        return (field.options as Array<{ value: string; label: string }>).map((option) => `${option.value}:${option.label}`);
      };
      const spanish = ['n-kia:Kia', 'n-ford:Vado'];
      assert.deepEqual(await makes({ 'accept-language': 'es-MX,es;q=0.9' }), spanish, 'by name_es, in its order; Kia has none');
      assert.deepEqual(await makes(), ['n-ford:Ford', 'n-kia:Kia'], 'by labelColumn');
      assert.deepEqual(await makes({ cookie: 'mistri-locale-yard=es' }), spanish);
      const hub = tenantLiveHub({ appId: APP_ID, source: binding.source });
      assert.ok(hub);
      const english = { resource: 'make', by: 'id', labelColumn: 'name' };
      const inSpanish = { ...english, local: { locale: 'es', column: 'name_es' } };
      const kept = (source: typeof english) => cachedTenantChoices(hub, APP_ID, 'north', source)?.options.map((each) => each.label);
      // Kept once the change store is heard: read each again until both are.
      for (const deadline = Date.now() + 10_000; !(kept(english) && kept(inSpanish)); await sleep(50)) {
        assert.ok(Date.now() < deadline, 'both entries are kept');
        await makes();
        await makes({ 'accept-language': 'es' });
      }
      assert.deepEqual(kept(inSpanish), ['Kia', 'Vado'], 'an entry for Spanish');
      assert.deepEqual(kept(english), ['Ford', 'Kia']);
    });
  });
}
