/**
 * A tenant's kind of words (`ui.catalog: 'tenant.<column>'`, `messages/<variant>/<locale>.ts`): a variant rewords the
 * App's keys in the App's languages, a reader is said the variant's word before the base's, and each variant is
 * parsed once per locale. A command's input takes `msg()` too: the reader's form is said in their language, the
 * handler and the App API read the App's own words.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { msg } from '../packages/mistri/schema/app.mjs';
import { appProblems, loadApp, localizedApp, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { appCatalogs } from '../packages/mistri/src/server/app/appMessages.js';
import { catalogColumnProblems } from '../packages/mistri/src/server/app/appTenantProfile.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { sourceUrl } from './support/policyServer.js';

const work = mkdtempSync(join(tmpdir(), 'mistri-variants-'));
after(() => rmSync(work, { recursive: true, force: true }));

const catalog = (locale: string, entries: Record<string, string>) =>
  `export default ${JSON.stringify({ kind: 'messages', locale, entries })};\n`;

const EN = {
  'ticket.plural': 'Tickets',
  'ticket.reason': 'Reason',
  'ticket.reasonHelp': 'Why it is flagged',
  'ticket.urgent': 'Urgent',
  'ticket.urgentIcon': 'flame',
};
const ES = { 'ticket.plural': 'Incidencias', 'ticket.reason': 'Motivo', 'ticket.urgentIcon': 'alert-triangle' };

const COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
import { field } from ${sourceUrl('packages/mistri/src/server/commands/commandFields.ts')};
import { msg } from ${sourceUrl('packages/mistri/schema/app.mjs')};
export default defineCommands({
  flag: defineCommand({
    source: 'words',
    target: 'ticket',
    input: {
      reason: field.text({ label: msg('ticket.reason'), help: msg('ticket.reasonHelp') }),
      level: field.choice({ options: [{ value: 'urgent', label: msg('ticket.urgent'), icon: msg('ticket.urgentIcon') }] }),
    },
    async handle() {},
  }),
});
`;

function appDir(name: string, extra: Record<string, unknown>, catalogs: Record<string, string>, commands = false) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const file of Object.keys(catalogs)) mkdirSync(join(dir, 'messages', file, '..'), { recursive: true });
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({
      id: name,
      name: 'Words',
      ...(commands ? { sources: { words: { connection: 'words-data', default: true } } } : { connection: 'words-data' }),
      resources: { ticket: commands ? { actions: { flag: { label: 'Flag', command: 'flag' } } } : {}, office: {} },
      views: { tickets: { kind: 'list', from: 'ticket', label: msg('ticket.plural') } },
      home: 'tickets',
      nav: ['tickets'],
      ui: { locale: 'en-US' },
      ...extra,
    }),
  );
  for (const [file, text] of Object.entries(catalogs)) writeFileSync(join(dir, 'messages', file), text);
  if (commands) writeFileSync(join(dir, 'commands.mjs'), COMMANDS);
  return dir;
}

const VARIANTS = {
  'en.mjs': catalog('en', EN),
  'es.mjs': catalog('es', ES),
  'clinic/en.mjs': catalog('en', { 'ticket.plural': 'Patients' }),
  'clinic/es.mjs': catalog('es', { 'ticket.plural': 'Pacientes' }),
  'garage/en.mjs': catalog('en', { 'ticket.plural': 'Vehicles' }),
};

const label = (loaded: Pick<LoadedApp, 'app'>) => (loaded.app.views.tickets as unknown as { label: string }).label;

test("a variant's word comes before the base's, in the reader's language, then in the source's", async () => {
  const loaded = await loadApp(appDir('kinds', {}, VARIANTS), { lock: 'report' });
  assert.equal(label(loaded), 'Tickets', 'no variant named: the base words');
  assert.equal(label(localizedApp(loaded, undefined, undefined, 'clinic')), 'Patients');
  assert.equal(label(localizedApp(loaded, 'es-MX', undefined, 'clinic')), 'Pacientes');
  assert.equal(label(localizedApp(loaded, 'es', undefined, 'garage')), 'Incidencias', "the base's Spanish before the variant's source");
  assert.equal(label(localizedApp(loaded, 'fr', undefined, 'garage')), 'Vehicles', 'no French: the variant in the source language');
  assert.equal(label(localizedApp(loaded, 'es', undefined, 'unknown')), 'Incidencias', 'a value naming no folder: the base words');
  assert.equal(localizedApp(loaded, 'es', undefined, 'clinic').app, localizedApp(loaded, 'es', undefined, 'clinic').app, 'parsed once');
  assert.notEqual(localizedApp(loaded, 'es', undefined, 'clinic').app, localizedApp(loaded, 'es').app);
  assert.deepEqual(Object.keys(appCatalogs(loaded.app)!.variants).sort(), ['clinic', 'garage']);
});

test('a variant rewords keys the App has, in languages it has', async () => {
  const extra = await loadApp(appDir('new-key', {}, { ...VARIANTS, 'clinic/en.mjs': catalog('en', { 'ticket.extra': 'Extra' }) }), {
    lock: 'report',
  });
  assert.match(
    appCatalogs(extra.app)!.advisories.join('\n'),
    /\[message-unused\] messages\/clinic\/en\.ts: "ticket\.extra" is not in messages\/en\.mjs/,
    'a key the source lacks is advice, as in a translation',
  );
  await assert.rejects(
    loadApp(appDir('new-language', {}, { ...VARIANTS, 'clinic/fr.mjs': catalog('fr', { 'ticket.plural': 'Patients' }) }), {
      lock: 'report',
    }),
    /\[message-missing\] messages\/clinic\/fr\.ts has no messages\/fr\.ts/,
  );
});

const SCHEMA = {
  label: 'words',
  dialect: 'sqlite',
  tables: [
    { id: 'ticket', name: 'ticket', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }], foreignKeys: [] },
    {
      id: 'office',
      name: 'office',
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: 'kind', type: 'TEXT' },
        { name: 'seats', type: 'INTEGER' },
      ],
      foreignKeys: [],
    },
  ],
  foreignKeys: [],
} as unknown as DatabaseSchema;

test('ui.catalog names a shared text column of the profile, and a variant folder needs one', async () => {
  const loaded = await loadApp(appDir('unchosen', {}, VARIANTS), { lock: 'report' });
  assert.match(appProblems(loaded, SCHEMA).join('\n'), /messages\/ has clinic\/, garage\/, and no ui\.catalog .*\[ui-catalog\]/);
  /* The column's own checks, over the loaded catalogs: a tenant App's whole declaration is not what they judge. */
  const problems = (shared: string[] | undefined, column: string) =>
    catalogColumnProblems(
      {
        ...loaded.app,
        ui: { ...loaded.app.ui, catalog: column },
        auth: { providers: ['email'], ...(shared ? { tenancy: { label: 'Office', profile: 'office', shared } } : {}) },
      } as AppDef,
      SCHEMA,
      appCatalogs(loaded.app),
    ).join('\n');
  assert.match(problems(undefined, 'kind'), /has no auth\.tenancy\.profile to read it from \[ui-catalog\]/);
  assert.match(problems([], 'kind'), /does not list "kind" \[tenant-shared-column\]/);
  assert.match(problems(['seats'], 'seats'), /which is INTEGER; a folder's name is text .*\[ui-catalog\]/);
  assert.equal(problems(['kind'], 'kind'), '');
});

test("a command's input is said in the reader's words on the form and in the App's own to the handler", async () => {
  const loaded = await loadApp(appDir('command-words', {}, { 'en.mjs': catalog('en', EN), 'es.mjs': catalog('es', ES) }, true), {
    lock: 'report',
  });
  const [reason, level] = loaded.commands!.registry.flag.fields as unknown as Array<{
    label: string;
    help?: string;
    options?: Array<{ label: string; icon?: string }>;
  }>;
  assert.deepEqual(
    [reason.label, reason.help, level.options![0]],
    ['Reason', 'Why it is flagged', { value: 'urgent', label: 'Urgent', icon: 'flame' }],
  );
  const input = (app: Pick<LoadedApp, 'app'>) =>
    (app.app.resources!.ticket as unknown as { actions: Array<{ id: string; command: { input: (typeof reason)[] } }> }).actions.find(
      (action) => action.id === 'flag',
    )!.command.input;
  assert.equal(input(loaded)[0].label, 'Reason');
  const es = input(localizedApp(loaded, 'es'));
  assert.deepEqual([es[0].label, es[0].help, es[1].options![0].icon], ['Motivo', 'Why it is flagged', 'alert-triangle']);

  await assert.rejects(
    loadApp(appDir('bad-icon', {}, { 'en.mjs': catalog('en', { ...EN, 'ticket.urgentIcon': 'Not An Icon' }) }, true), { lock: 'report' }),
    /says the icon "Not An Icon"; a choice's icon is an App icon's name/,
  );
  await assert.rejects(
    loadApp(appDir('no-catalogs', { views: { tickets: { kind: 'list', from: 'ticket', label: 'Tickets' } } }, {}, true), {
      lock: 'report',
    }),
    /\[message-missing\].*ticket\.reason/,
  );
});
