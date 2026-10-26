/**
 * An App's words (`messages/<locale>.ts`, `msg()`): the catalogs a load reads
 * and checks, each reader's definition said in their language, the one locale
 * resolution, a notice said per recipient, a tenant's own words checked as
 * they are written and skipped as they are read, never another tenant's, and
 * the same served over HTTP on SQLite and (when TABLEWALK_TEST_PG names a
 * server) PostgreSQL.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import {
  dashboard,
  defineMessages,
  document,
  fields,
  fromRecord,
  funnel,
  metric,
  msg,
  navGroup,
  note,
  page,
} from '../packages/mistri/schema/app.mjs';
import { CAPTION_KEYS, isMessageRef, parseCaption } from '../packages/engine/src/shared/appMessages.js';
import { canonicalLocale, negotiateLocale, resolveLocale } from '../packages/engine/src/shared/appLocale.js';
import { appAdvisories, appProblems, loadApp, localizedApp, type AppHost, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { appCatalogs, componentMessages } from '../packages/mistri/src/server/app/appMessages.js';
import {
  localeRow,
  pickedLocale,
  requestLocale,
  unvaryOnLanguage,
  varyOnLanguage,
} from '../packages/mistri/src/server/app/readerLocale.js';
import { nameSectionWindows } from '../packages/mistri/src/shared/appDashSections.js';
import { cardRequest, drawShareCardsWith, shareCardImage } from '../packages/mistri/src/server/http/shareCard.js';
import { localePreloads } from '../packages/engine/src/server/clientSurface.js';
import { recipientLocale } from '../packages/mistri/src/server/email/noticeBody.js';
import { messageOf } from '../packages/mistri/src/server/email/outbox.js';
import { literalCaptions, runMessagesCommand } from '../packages/mistri/src/server/cli/messagesCommand.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import { checkTenantMessages, messageRowProblem } from '../packages/mistri/src/server/app/recordMessages.js';
import { noticeWords } from '../packages/mistri/src/server/app/noticeWords.js';
import { compileAppDefinitionValidation, validateStoredPostImage } from '../packages/mistri/src/server/app/appValidation.js';
import { buildApp } from '../packages/mistri/src/server/build/build.js';
import { loadBuiltApp } from '../packages/mistri/src/server/app/appBuild.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { retireDevClient } from '../packages/engine/src/server/devclient.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';

const work = mkdtempSync(join(tmpdir(), 'tablewalk-messages-'));
after(() => rmSync(work, { recursive: true, force: true }));

const EN = {
  'ticket.plural': 'Tickets',
  'ticket.title': 'Title',
  'ticket.open': 'Open',
  'ticket.name': 'Ticket {number}',
  'ticket.count': '{count, plural, one {# ticket} other {# tickets}}',
  'ticket.assigned': 'Assigned: {title}',
};
const ES = {
  'ticket.plural': 'Incidencias',
  'ticket.title': 'Título',
  'ticket.open': 'Abiertas',
  'ticket.name': 'Incidencia {number}',
  'ticket.assigned': 'Asignada: {title}',
};

const catalog = (locale: string, entries: Record<string, string>) =>
  `export default ${JSON.stringify({ kind: 'messages', locale, entries })};\n`;

/** An App definition naming its words: a list's label and tab, a column's caption, a record's name, a notice. */
/** The one tab the views name: its caption is a message, so it is the segment's. */
const OPEN = { open: { query: "status = 'open'", label: msg('ticket.open') } };

function definition(extra: Record<string, unknown> = {}) {
  return {
    id: 'words',
    name: 'Words',
    connection: 'words-data',
    resources: {
      ticket: {
        labels: { title: msg('ticket.title') },
        recordLabel: msg('ticket.name', { number: 'id' }),
        segments: OPEN,
        notify: [{ on: 'insert', to: 'assignee', title: msg('ticket.assigned', { title: 'title' }) }],
      },
      tenant_message: {},
      person: {},
    },
    views: {
      tickets: {
        kind: 'list',
        from: 'ticket',
        label: msg('ticket.plural'),
        tabs: ['open'],
      },
    },
    home: 'tickets',
    nav: ['tickets'],
    ui: {
      locale: 'en-US',
      messages: fromRecord('tenant_message', {
        by: 'tenant',
        tenantField: 'tenant_id',
        fields: { key: 'key', locale: 'locale', text: 'text' },
      }),
    },
    ...extra,
  };
}

/** A throwaway App directory: its manifest and its catalogs. */
function appDir(
  name: string,
  manifest: unknown,
  catalogs: Record<string, string> = { 'en.mjs': catalog('en', EN), 'es.mjs': catalog('es', ES) },
) {
  const dir = join(work, name);
  mkdirSync(join(dir, 'messages'), { recursive: true });
  writeFileSync(join(dir, 'app.json'), JSON.stringify(manifest));
  for (const [file, text] of Object.entries(catalogs)) writeFileSync(join(dir, 'messages', file), text);
  return dir;
}

const SCHEMA: DatabaseSchema = {
  label: 'words',
  dialect: 'sqlite',
  tables: [
    {
      id: 'ticket',
      name: 'ticket',
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: 'title', type: 'TEXT' },
        { name: 'status', type: 'TEXT' },
        { name: 'assignee', type: 'TEXT' },
      ],
      foreignKeys: [],
    },
    {
      id: 'tenant_message',
      name: 'tenant_message',
      columns: ['id', 'tenant_id', 'key', 'locale', 'text'].map((name) =>
        name === 'id' ? { name, type: 'INTEGER', primaryKey: true } : { name, type: 'TEXT' },
      ),
      foreignKeys: [],
    },
    {
      id: 'person',
      name: 'person',
      columns: ['id', 'email', 'locale'].map((name) =>
        name === 'id' ? { name, type: 'INTEGER', primaryKey: true } : { name, type: 'TEXT' },
      ),
      foreignKeys: [],
    },
  ],
} as unknown as DatabaseSchema;

let shared: LoadedApp | undefined;
const words = async () => (shared ??= await loadApp(appDir('words', definition()), { lock: 'report' }));
const listOf = (loaded: Pick<LoadedApp, 'app'>) =>
  loaded.app.views.tickets as unknown as { label: string; tabs: Array<{ label: string; slug?: string }> };

describe('authoring', () => {
  test('defineMessages and msg make plain data, and refuse what is not a key or a tag', () => {
    const es = defineMessages('es', { 'lead.title': 'Prospecto' });
    assert.deepEqual([es.kind, es.locale, { ...es.entries }], ['messages', 'es', { 'lead.title': 'Prospecto' }]);
    assert.deepEqual(msg('lead.due', { days: 'due_in' }), { message: 'lead.due', args: { days: 'due_in' } });
    assert.ok(isMessageRef(msg('lead.title')));
    assert.throws(() => msg('title'), /not a message key/);
    assert.throws(() => defineMessages('not a tag', {}), /not a language tag/);
    assert.throws(() => msg('lead.due', { 'a.b': 'x' }), /msg/);
  });

  test('a reference that reaches a parser unsaid names the catalogs, and a blank caption is refused', () => {
    assert.throws(() => parseCaption(msg('lead.title'), 'views.leads.label'), /\[message-missing\] views\.leads\.label/);
    assert.throws(() => parseCaption('  ', 'views.leads.label'), /Invalid caption at views\.leads\.label/);
    assert.equal(parseCaption(' Leads ', 'x'), 'Leads');
  });
});

describe('a stock refusal', () => {
  test("takes msg(), its places bound to the parent paths the write reads, in the reader's language", async () => {
    const base = definition();
    const manifest = definition({
      resources: {
        ...base.resources,
        line: {
          consumes: { column: 'part_id.on_hand', by: 'qty', message: msg('ticket.short', { left: 'part_id.on_hand' }) },
        },
      },
    });
    const loaded = await loadApp(
      appDir('stock', manifest, {
        'en.mjs': catalog('en', { ...EN, 'ticket.short': 'Only {left} left' }),
        'es.mjs': catalog('es', { ...ES, 'ticket.short': 'Quedan {left}' }),
      }),
      { lock: 'report' },
    );
    const said = (app: Pick<LoadedApp, 'app'>) => app.app.resources!.line.consumes![0].message;
    assert.equal(said(loaded), 'Only {part_id.on_hand} left');
    assert.equal(said(localizedApp(loaded, 'es-MX')), 'Quedan {part_id.on_hand}');
  });
});

describe('the one locale resolution', () => {
  test('canonical tags, and Accept-Language negotiated by lookup among the catalogs', () => {
    assert.equal(canonicalLocale('es-mx'), 'es-MX');
    assert.equal(canonicalLocale('not a tag'), undefined);
    assert.equal(canonicalLocale(7), undefined);
    assert.equal(
      negotiateLocale('fr-CA, es-MX;q=0.8, en;q=0.5', ['en', 'es']),
      'es-MX',
      "the header's tag is kept where its language is offered",
    );
    assert.equal(negotiateLocale('es;q=0.2, en;q=0.9', ['en', 'es']), 'en', 'by quality, not order');
    assert.equal(negotiateLocale('de, *', ['en', 'es']), undefined);
    assert.equal(negotiateLocale('es;q=0', ['en', 'es']), undefined, 'q=0 refuses');
    assert.equal(negotiateLocale(undefined, ['en']), undefined);
  });

  test('nearest first: the person, the tenant, the browser, the App', () => {
    assert.equal(resolveLocale({ person: 'pt-BR', tenant: 'es', browser: 'fr', app: 'en-US' }), 'pt-BR');
    assert.equal(resolveLocale({ person: 'bogus tag', tenant: 'es', browser: 'fr', app: 'en-US' }), 'es');
    assert.equal(resolveLocale({ browser: 'fr', app: 'en-US' }), 'fr');
    assert.equal(resolveLocale({ app: 'en-US' }), 'en-US');
    assert.equal(resolveLocale({}), undefined);
  });

  test('the browser is asked only for a visitor of an App with words to choose between, and the answer varies on it', async () => {
    const { app } = await words();
    const headers: Record<string, string | number | string[]> = {};
    const res = {
      getHeader: (name: string) => headers[name],
      setHeader: (name: string, value: string | number | string[]) => void (headers[name] = value),
    } as unknown as ServerResponse;
    const req = { headers: { 'accept-language': 'es-ES,es;q=0.9' } };
    assert.equal(requestLocale(app, { visitor: true, req, res }), 'es-ES');
    assert.equal(headers.vary, 'Accept-Language');
    assert.equal(requestLocale(app, { visitor: false, req }), 'en-US', 'a signed-in reader is not judged by their browser');
    assert.equal(requestLocale(app, { visitor: false, person: 'es', req }), 'es');
    varyOnLanguage(res);
    headers.vary = 'Origin';
    varyOnLanguage(res);
    assert.equal(headers.vary, 'Origin, Accept-Language');
  });
});

describe('loading', () => {
  test("the load reads the catalogs and is said in the App's own words; a reader's in theirs, addresses kept", async () => {
    const loaded = await words();
    assert.deepEqual(loaded.messageFiles, ['messages/en.mjs', 'messages/es.mjs']);
    assert.equal(appCatalogs(loaded.app)?.source, 'en');
    assert.equal(listOf(loaded).label, 'Tickets');
    assert.equal(loaded.app.resources!.ticket.labels!.title, 'Title');
    assert.equal(loaded.app.resources!.ticket.recordLabel, 'Ticket {id}', 'a record name is a template of its columns');
    assert.equal(loaded.app.ui.locale, 'en-US');
    const es = localizedApp(loaded, 'es-MX');
    assert.notEqual(es.app, loaded.app);
    assert.equal(listOf(es).label, 'Incidencias');
    assert.equal(es.app.resources!.ticket.labels!.title, 'Título');
    assert.equal(es.app.resources!.ticket.recordLabel, 'Incidencia {id}');
    assert.equal(listOf(es).tabs[0].label, 'Abiertas');
    assert.equal(listOf(es).tabs[0].slug, 'open', "a tab's address word stays the source's");
    assert.equal(localizedApp(loaded, 'es-MX').app, es.app, 'each locale is parsed once');
    assert.equal(localizedApp(loaded, 'en-GB'), loaded, "the source's language is the load itself");
    assert.equal(localizedApp(loaded, 'fr'), loaded, 'a language with no catalog is the source');
    assert.equal(localizedApp(loaded, undefined), loaded);
  });

  test("a free-form page's label and description are messages, said in the reader's words as a view's", async () => {
    const dir = appDir('page-words', definition());
    mkdirSync(join(dir, 'pages'));
    writeFileSync(
      join(dir, 'pages', 'help.page.tsx'),
      `import { definePage, Empty } from '@mistriwork/mistri/page';
export default definePage({ label: { message: 'ticket.plural' }, description: { message: 'ticket.open' },
  reads: ['ticket'], component: () => <Empty title="x" /> });\n`,
    );
    const loaded = await loadApp(dir, { lock: 'report' });
    const help = (app: Pick<LoadedApp, 'app'>) => app.app.views.help as unknown as { label: string; description: string };
    assert.deepEqual([help(loaded).label, help(loaded).description], ['Tickets', 'Open']);
    const es = localizedApp(loaded, 'es-MX');
    assert.deepEqual([help(es).label, help(es).description], ['Incidencias', 'Abiertas']);
  });

  test("every caption a reader sees is said in their words: a dashboard's, its sections' and a funnel's stages, a page's, a document's, an action's, a nav group's", async () => {
    const said = (en: string, es: string) => ({ en, es });
    const words: Record<string, { en: string; es: string }> = {
      'desk.label': said('Desk', 'Mesa'),
      'desk.description': said('What is open today', 'Lo abierto hoy'),
      'desk.open': said('Open now', 'Abiertas ahora'),
      'desk.note': said('Answer within a day.', 'Responda en un día.'),
      'desk.close': said('Close', 'Cerrar'),
      'desk.details': said('Details', 'Detalles'),
      'desk.slip': said('Ticket slip', 'Comprobante'),
      'desk.work': said('Work', 'Trabajo'),
      'desk.empty': said('Nothing open', 'Nada abierto'),
      'desk.opened': said('Opened', 'Abiertas'),
      'desk.closed': said('Closed', 'Cerradas'),
    };
    const pick = (locale: 'en' | 'es', base: Record<string, string>) => ({
      ...base,
      ...Object.fromEntries(Object.entries(words).map(([key, both]) => [key, both[locale]])),
    });
    const manifest = definition({
      views: {
        tickets: { ...definition().views.tickets, empty: { title: msg('desk.empty') } },
        desk: dashboard(
          msg('desk.label'),
          [
            metric(msg('desk.open'), 'ticket', { query: "status = 'open'" }),
            note(msg('desk.note')),
            funnel('Road', 'ticket', [{ label: msg('desk.opened') }, { label: msg('desk.closed'), query: "status = 'closed'" }]),
          ],
          {
            description: msg('desk.description'),
          },
        ),
      },
      nav: [navGroup('work', msg('desk.work'), ['tickets', 'desk'])],
      pages: {
        ticket: page('ticket', [fields(['title'], { title: msg('desk.details') })]),
        slip: document('ticket', [fields(['title', 'status'])], { label: msg('desk.slip') }),
      },
    });
    manifest.resources.ticket = {
      ...manifest.resources.ticket,
      actions: { close: { label: msg('desk.close'), set: { status: 'closed' } } },
    } as never;
    const dir = appDir('every-caption', manifest, {
      'en.mjs': catalog('en', pick('en', EN)),
      'es.mjs': catalog('es', pick('es', ES)),
    });
    const loaded = await loadApp(dir, { lock: 'report' });
    const read = (app: Pick<LoadedApp, 'app' | 'pages'>) => {
      const desk = app.app.views.desk as unknown as {
        label: string;
        description: string;
        sections: Array<{ title?: string; text?: string; stages?: Array<{ label: string }> }>;
      };
      const tickets = app.app.views.tickets as unknown as { empty: { title: string } };
      const group = (app.app.nav as unknown as Array<{ label: string }>)[0];
      const pageOf = (id: string) => app.pages.find((one) => one.id === id) as unknown as Record<string, never>;
      const ticket = pageOf('ticket') as unknown as { sections: Array<{ title?: string }> };
      const slip = pageOf('slip') as unknown as { document: { label: string } };
      const close = (app.app.resources!.ticket.actions as unknown as Array<{ id: string; label: string }>).find(
        (one) => one.id === 'close',
      )!;
      return [
        desk.label,
        desk.description,
        desk.sections[0].title,
        desk.sections[1].text,
        desk.sections[2].stages?.map((stage) => stage.label).join(' / '),
        tickets.empty.title,
        group.label,
        ticket.sections.find((section) => section.title)?.title,
        slip.document.label,
        close.label,
      ];
    };
    assert.deepEqual(read(loaded), [
      'Desk',
      'What is open today',
      'Open now',
      'Answer within a day.',
      'Opened / Closed',
      'Nothing open',
      'Work',
      'Details',
      'Ticket slip',
      'Close',
    ]);
    assert.deepEqual(read(localizedApp(loaded, 'es-MX')), [
      'Mesa',
      'Lo abierto hoy',
      'Abiertas ahora',
      'Responda en un día.',
      'Abiertas / Cerradas',
      'Nada abierto',
      'Trabajo',
      'Detalles',
      'Comprobante',
      'Cerrar',
    ]);
  });

  test("one rule for what a caption is: every key it names takes msg() in the authored types, but the few that are not a reader's words", () => {
    /* Each with why it stays text. A command's inputs are parsed when defineCommand runs, before any catalog is
       read, and the same contract is the App API's and MCP's; the served shapes are said already; an API's words are
       its OpenAPI document's, one per App, not a reader's; a composer's template `text` names a column. */
    const STRING_ONLY = new Set([
      'app.d.ts TimelineComposer.text',
      'app.d.ts ApiExposureOptions.description',
      'app.d.ts DraftApiConfig.label',
      'app.d.ts DraftApiConfig.description',
      'app.d.ts ApiConfig.label',
      'app.d.ts ApiConfig.description',
      'command.d.ts FieldBase.label',
      'command.d.ts FieldBase.help',
      'model.d.ts AppCommandChoice.label',
      'model.d.ts AppCommandChoice.help',
      'command.d.ts CommandGroupField.label',
      'command.d.ts CommandGroupField.description',
      'command.d.ts CommandLinesField.label',
      'command.d.ts CommandLinesField.description',
      'model.d.ts CommandValueBase.label',
      'model.d.ts CommandValueBase.help',
      'model.d.ts AppCommandLines.label',
      'model.d.ts AppCommandLines.help',
      'model.d.ts AppCommandGroup.label',
      'model.d.ts AppCommandGroup.help',
      'model.d.ts AppCommandAction.label',
      /* The reference's own key, which is how a caption is told from a sentence. */
      'model.d.ts AppMessageRef.message',
      /* A command's input rules are parsed when defineCommand runs, before any catalog is read. */
      'command.d.ts CommandTextField.message',
      'model.d.ts AppCommandField.message',
      'command.d.ts CommandRule.message',
      'model.d.ts AppCommandRule.message',
      /* A display's subtitle names a column of the record, not words. */
      'app.d.ts AppDisplayRule.subtitle',
      /* An embed names its tab by the tab's address word, which no language changes. */
      'app.d.ts AppViewDashSection.tab',
    ]);
    const found = new Set<string>();
    const property = new RegExp(`\\b(${[...CAPTION_KEYS].join('|')})\\??: ([^;,)=]*)`, 'g');
    for (const file of ['app.d.ts', 'command.d.ts', 'model.d.ts']) {
      let owner = '';
      for (const line of readFileSync(
        new URL(`../packages/${file === 'model.d.ts' ? 'engine' : 'mistri'}/schema/${file}`, import.meta.url),
        'utf8',
      ).split('\n')) {
        owner = line.match(/^(?:export )?(?:declare )?(?:interface|type|function) (\w+)/)?.[1] ?? owner;
        if (/^\s*(\/\*\*|\*)/.test(line)) continue;
        for (const [, key, type] of line.matchAll(property))
          if (/^string\b/.test(type!) && !type!.includes('AppMessageRef')) found.add(`${file} ${owner}.${key}`);
      }
    }
    assert.deepEqual(
      [...found].filter((caption) => !STRING_ONLY.has(caption)),
      [],
      'a caption that takes no msg()',
    );
    assert.deepEqual(
      [...STRING_ONLY].filter((caption) => !found.has(caption)),
      [],
      'a caption left text that now takes msg(): take it off the list',
    );
  });

  test("a component's catalog is every message in the reader's words, parsed for the browser to say", async () => {
    const loaded = await words();
    const IntlMessageFormat = (await import('intl-messageformat')).default;
    const say = (catalog: ReturnType<typeof componentMessages>, key: string) =>
      String(new IntlMessageFormat(catalog![key] as never, 'es-MX').format());
    const es = componentMessages(loaded.app, 'es-MX');
    assert.equal(say(es, 'ticket.open'), 'Abiertas');
    assert.equal(say(componentMessages(loaded.app, undefined), 'ticket.open'), 'Open', "with no reader's locale, the source's");
    assert.deepEqual(Object.keys(es!).sort(), Object.keys(appCatalogs(loaded.app)!.locales.en).sort(), 'every key of the source');
    assert.equal(componentMessages(loaded.app, 'es-MX'), es, 'each locale is said once');
    const north = { stamp: 'north-1', words: new Map([['ticket.open', new Map([['es', 'Pendientes']])]]) };
    assert.equal(say(componentMessages(loaded.app, 'es-MX', north), 'ticket.open'), 'Pendientes', "a tenant's words over the App's");
  });

  test("a tenant's words are over the catalogs for that tenant only, keyed by their content", async () => {
    const loaded = await words();
    const spec = loaded.app.ui.messages!;
    const north = await checkTenantMessages('words', spec, 'north', [
      { tenant_id: 'north', key: 'ticket.plural', locale: 'es', text: 'Casos' },
      { tenant_id: 'south', key: 'ticket.plural', locale: 'es', text: 'Not north' },
    ]);
    assert.ok(north);
    assert.deepEqual(north.skipped.length, 1);
    assert.equal(listOf(localizedApp(loaded, 'es', north)).label, 'Casos');
    const south = await checkTenantMessages('words', spec, 'south', [
      { tenant_id: 'south', key: 'ticket.plural', locale: 'en', text: 'Cases' },
    ]);
    assert.equal(listOf(localizedApp(loaded, 'en-US', south)).label, 'Cases', 'an override in the source language parses too');
    assert.equal(listOf(localizedApp(loaded, 'es', south)).label, 'Incidencias', "south's English words are not north's Spanish");
    assert.notEqual(north.stamp, south!.stamp);
  });

  test('check codes: a catalog that does not parse, a missing source, a new placeholder, a key no catalog has', async () => {
    const refused = async (name: string, manifest: unknown, catalogs: Record<string, string>, pattern: RegExp) =>
      assert.rejects(loadApp(appDir(name, manifest, catalogs), { lock: 'report' }), pattern);
    await refused(
      'syntax',
      definition(),
      { 'en.mjs': catalog('en', { ...EN, 'ticket.plural': 'Tickets {' }) },
      /\[message-syntax\] messages\/en\.mjs: "ticket\.plural"/,
    );
    await refused(
      'nosource',
      definition(),
      { 'es.mjs': catalog('es', ES) },
      /\[message-missing\] messages\/ has messages\/es\.mjs, and no catalog for the App's own language "en-US"/,
    );
    await refused(
      'placeholder',
      definition(),
      { 'en.mjs': catalog('en', EN), 'es.mjs': catalog('es', { ...ES, 'ticket.open': 'Abiertas {extra}' }) },
      /\[message-placeholder\] messages\/es\.mjs: "ticket\.open" reads \{extra\}/,
    );
    await refused(
      'unknown',
      definition({ nav: ['tickets'], views: { tickets: { kind: 'list', from: 'ticket', label: msg('ticket.nope') } } }),
      { 'en.mjs': catalog('en', EN) },
      /\[message-missing\]/,
    );
    await refused(
      'misnamed',
      definition(),
      { 'en.mjs': catalog('es', EN) },
      /\[message-syntax\] messages\/en\.mjs says defineMessages\('es'\)/,
    );
    await refused(
      'args-at-a-caption',
      definition({ views: { tickets: { kind: 'list', from: 'ticket', label: msg('ticket.name', { number: 'id' }) } } }),
      { 'en.mjs': catalog('en', EN) },
      /\[message-arg\]/,
    );
    await refused('no-catalogs', definition(), {}, /\[message-missing\]/);
  });

  test('check: an argument bound to no column, a locale column the catalog lacks, and advice on what is untranslated or unused', async () => {
    const loaded = await loadApp(
      appDir(
        'advice',
        definition({
          resources: {
            ticket: { segments: OPEN, notify: [{ on: 'insert', to: 'assignee', title: msg('ticket.assigned', { title: 'nowhere' }) }] },
            tenant_message: {},
            person: {},
          },
          ui: { locale: { column: 'person.language', default: 'en-US' } },
        }),
      ),
      { lock: 'report' },
    );
    const problems = appProblems(loaded, SCHEMA).join('\n');
    assert.match(problems, /\[message-arg\][^\n]*nowhere/);
    assert.match(problems, /"ui\.locale" reads "person\.language", and "person" has no column "language"/);
    const advice = appAdvisories(loaded, SCHEMA).join('\n');
    assert.match(
      advice,
      /\[message-untranslated\] messages\/es\.mjs translates 5 of 6 messages; 1 say messages\/en\.mjs's words \(ticket\.count\)/,
    );
    assert.match(advice, /\[message-unused\] messages\/en\.mjs: "ticket\.count" is named by no msg\(\)/);
  });

  test("check: a label said from the App's messages restates nothing, in a feature as at the top", async () => {
    const restated = async (name: string, extra: Record<string, unknown>) => {
      const loaded = await loadApp(appDir(name, definition(extra)), { lock: 'report' });
      return appAdvisories(loaded, SCHEMA).filter((warning) => warning.includes('[restated]'));
    };
    assert.deepEqual(await restated('restated-top', {}), []);
    const inFeature = await restated('restated-feature', {
      resources: { tenant_message: {}, person: {} },
      features: [{ id: 'desk', resources: { ticket: { segments: OPEN, labels: { title: msg('ticket.title') } } } }],
    });
    assert.deepEqual(inFeature, []);
  });

  test("the browser's payload never hears of the binding or the column a locale is read from", async () => {
    const loaded = await loadApp(appDir('column', definition({ ui: { locale: { column: 'person.locale', default: 'es-MX' } } })), {
      lock: 'report',
    });
    assert.equal(loaded.app.ui.locale, 'es-MX');
    assert.equal(loaded.app.ui.localeColumn, 'person.locale');
    const { servedUi } = await import('../packages/mistri/src/shared/appPayload.js');
    const served = servedUi(loaded.app.ui) as Record<string, unknown>;
    assert.equal(served.localeColumn, undefined);
    assert.equal(served.messages, undefined);
  });
});

describe("a tenant's own words, as they are written", () => {
  test('a row is checked against the source: its key, its tag, its ICU and its arguments', async () => {
    const spec = (await words()).app.ui.messages!;
    assert.equal(await messageRowProblem(spec, 'ticket.assigned', 'es-MX', 'Para ti: {title}'), undefined);
    assert.equal((await messageRowProblem(spec, 'ticket.nope', 'es', 'x'))?.field, 'key');
    assert.equal((await messageRowProblem(spec, 'ticket.title', 'not a tag', 'x'))?.field, 'locale');
    assert.equal((await messageRowProblem(spec, 'ticket.title', 'es', 'Título {'))?.field, 'text');
    assert.match((await messageRowProblem(spec, 'ticket.title', 'es', 'Título {secret}'))!.reason, /say no \{secret\}/);
    assert.equal((await messageRowProblem(spec, 'ticket.title', 'es', 'x'.repeat(4001)))?.field, 'text');
  });

  test("the write is refused with the column's reason, in the write's own transaction", async () => {
    const { app } = await words();
    const rules = compileAppDefinitionValidation(SCHEMA, app);
    const tx = {
      query: async () => ({ rows: [{ id: 1, tenant_id: 'north', key: 'ticket.title', locale: 'es', text: 'Título {secret}' }] }),
      rows: async () => [{ id: 1, tenant_id: 'north', key: 'ticket.title', locale: 'es', text: 'Título {secret}' }],
    };
    await assert.rejects(
      validateStoredPostImage(tx as never, SCHEMA, rules, 'tenant_message', { id: 1 }, 'insert'),
      (error: Error & { fields?: string[]; reasons?: Record<string, string> }) => {
        assert.deepEqual(error.fields, ['text']);
        assert.match(String(error.reasons?.text), /\{secret\}/);
        return true;
      },
    );
  });
});

describe('a notice, said per recipient', () => {
  test("each recipient's own tag, then their tenant's, then the App's; a tenant's words over the catalogs; never a failed write", async () => {
    const { app } = await words();
    const say = noticeWords(app, 'ticket.assigned', [{ name: 'title', path: ['title'] }] as never, {
      schema: SCHEMA,
      physical: (table) => `p_${table}`,
      tenantLocale: async (tenant) => (tenant === 'south' ? 'es' : undefined),
    });
    assert.ok(say);
    const sink = (tenantRows: Record<string, unknown>[] = []) => ({
      rows: async (table: string, where: Record<string, unknown>) => {
        if (table === 'p_tenant_message') return tenantRows.filter((row) => row.tenant_id === where.tenant_id);
        return [];
      },
    });
    const values = { title: 'Printer jam' };
    assert.equal(await say.words(values, 'bob@example.test', undefined, sink()), 'Assigned: Printer jam');
    assert.equal(await say.words(values, 'bob@example.test', 'south', sink()), 'Asignada: Printer jam', "the tenant's tag");
    assert.equal(
      await say.words(
        values,
        'bob@example.test',
        'south',
        sink([{ tenant_id: 'south', key: 'ticket.assigned', locale: 'es', text: 'Para ti: {title}' }]),
      ),
      'Para ti: Printer jam',
    );
    assert.equal(
      await say.words(
        values,
        'bob@example.test',
        'north',
        sink([{ tenant_id: 'south', key: 'ticket.assigned', locale: 'en', text: 'South only: {title}' }]),
      ),
      'Assigned: Printer jam',
      "another tenant's row is never this one's",
    );
  });

  test('an App without catalogs says its titles as it always did, and loads no formatter for them', async () => {
    const plain = await loadApp(
      appDir(
        'plain',
        {
          id: 'plain',
          name: 'Plain',
          connection: 'words-data',
          resources: { ticket: {} },
          views: { tickets: { kind: 'list', from: 'ticket' } },
          home: 'tickets',
        },
        {},
      ),
      { lock: 'report' },
    );
    assert.equal(appCatalogs(plain.app), undefined);
    assert.equal(noticeWords(plain.app, 'ticket.assigned', [], { schema: SCHEMA, physical: (table) => table }), undefined);
    assert.equal(localizedApp(plain, 'es'), plain);
  });
});

describe('a build', () => {
  test("keeps the catalogs and what a reader's words are parsed from, and says itself again from app.json", async () => {
    const dir = appDir('built', definition());
    const source = await loadApp(dir, { lock: 'report' });
    const { out } = await buildApp({ app: dir, out: join(work, 'built-out') }, { bundler: async () => undefined, typecheck: false });
    const built = await loadBuiltApp(out, { lock: 'report' });
    assert.equal(listOf(built).label, 'Tickets');
    assert.deepEqual(appCatalogs(built.app)?.locales, appCatalogs(source.app)?.locales);
    assert.equal(listOf(localizedApp(built, 'es')).label, 'Incidencias');
    assert.equal(listOf(localizedApp(built, 'es')).tabs[0].slug, 'open');
  });
});

/* ---------- over HTTP ---------- */

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

let servings = 0;

/** The App served on a database holding two tenants' words, a reader signed in or not. */
async function served(
  connection: { url: string; seed: (sql: (text: string) => Promise<void>) => Promise<void>; exec: (text: string) => Promise<void> },
  run: (ask: (path: string, headers?: Record<string, string>) => Promise<Reply>, signIn: () => void) => Promise<void>,
) {
  await connection.seed(connection.exec);
  /* No notify rule here: a rule needs a writable table and the inbox's tables, which a notice's own test covers. */
  const loaded = await loadApp(
    appDir(
      `served-${++servings}`,
      definition({
        resources: {
          ticket: { segments: OPEN, labels: { title: msg('ticket.title') }, recordLabel: msg('ticket.name', { number: 'id' }) },
          tenant_message: {},
          person: {},
        },
        auth: { roles: { staff: { read: true } }, public: { read: ['ticket'] } },
      }),
    ),
    { lock: 'report' },
  );
  const registry = new Registry();
  registry.add({ id: 'words-data', name: 'Words', url: connection.url, source: 'config' });
  let signedIn = false;
  const host: AppHost = {
    app: loaded,
    pages: [],
    auth: {
      spec: loaded.app.auth!,
      store: 'unused',
      handler: async () => {},
      close() {},
      session: async () => (signedIn ? { id: 'staff', who: 'staff@example.test', role: 'staff' } : null),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const child = createApp({ registry, bound, apps: [host] });
  const server = createServer((req, res) => child.emit('request', req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const ask = (path: string, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: bound.port,
          path,
          headers: { host: `127.0.0.1:${bound.port}`, 'accept-encoding': 'identity', ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  try {
    await run(ask, () => {
      signedIn = true;
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await retireDevClient(child);
    await registry.closeAll();
  }
}

const SEED = [
  'CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT, status TEXT, assignee TEXT)',
  'CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT, locale TEXT)',
  'CREATE TABLE tenant_message (id INTEGER PRIMARY KEY, tenant_id TEXT, key TEXT, locale TEXT, text TEXT)',
  "INSERT INTO ticket VALUES (1, 'Printer jam', 'open', 'ana@example.test')",
  "INSERT INTO tenant_message VALUES (1, 'north', 'ticket.plural', 'en', 'North cases')",
  "INSERT INTO tenant_message VALUES (2, 'south', 'ticket.plural', 'en', 'South cases')",
  "INSERT INTO tenant_message VALUES (3, 'north', 'ticket.title', 'en', 'Subject {secret}')",
];

async function exerciseHttp(connection: Parameters<typeof served>[0]) {
  await served(connection, async (ask, signIn) => {
    const payload = async (path: string, headers?: Record<string, string>) => {
      const reply = await ask(path, headers);
      assert.equal(reply.status, 200, reply.body);
      return { reply, app: JSON.parse(reply.body).app };
    };
    const visitorEs = await payload('/api/app', { 'accept-language': 'es-MX,es;q=0.9' });
    assert.equal(visitorEs.app.ui.locale, 'es-MX', 'the resolved tag is served');
    assert.match(String(visitorEs.reply.headers.vary), /Accept-Language/);
    assert.equal(visitorEs.app.views.tickets.label, 'Incidencias');
    assert.equal(visitorEs.app.ui.messages, undefined, 'the binding is never served');
    const visitorEn = await payload('/api/app', { 'accept-language': 'de' });
    assert.equal(visitorEn.app.views.tickets.label, 'Tickets');
    assert.equal(visitorEn.app.ui.locale, 'en-US');
    signIn();
    const staff = await payload('/api/app', { 'accept-language': 'es' });
    assert.equal(staff.app.views.tickets.label, 'Tickets', "a signed-in reader is said the App's language, not their browser's");
    const north = await payload('/api/app?tenant=north');
    assert.equal(north.app.views.tickets.label, 'North cases');
    assert.equal(
      north.app.resources.ticket.labels.title,
      'Title',
      'a row whose arguments the source does not say is skipped as it is read',
    );
    const south = await payload('/api/app?tenant=south');
    assert.equal(south.app.views.tickets.label, 'South cases', "south reads its own words, never north's");
    assert.doesNotMatch(south.reply.body, /North cases/);
    assert.doesNotMatch(north.reply.body, /South cases/);
  });
}

test('over HTTP on SQLite: the visitor negotiated, the reader said, each tenant its own words', async () => {
  const file = join(work, 'words.db');
  const db = new DatabaseSync(file);
  try {
    await exerciseHttp({
      url: file,
      exec: async (text) => db.exec(text),
      seed: async (exec) => {
        for (const line of SEED) await exec(line);
      },
    });
  } finally {
    db.close();
  }
});

test('over HTTP on PostgreSQL: the same, each tenant its own words', { skip: liveSkip('postgres', LIVE_PG) }, async () => {
  const url = await ownedPostgresDatabase();
  const control = await pgControl(url);
  try {
    await control.query('DROP TABLE IF EXISTS ticket, person, tenant_message');
    await exerciseHttp({
      url,
      exec: async (text) => void (await control.query(text)),
      seed: async (exec) => {
        for (const line of SEED) await exec(line);
      },
    });
  } finally {
    await control.query('DROP TABLE IF EXISTS ticket, person, tenant_message');
    await control.end();
  }
});

describe('i18n wave 2', () => {
  const W2_EN = {
    ...EN,
    'ticket.close': 'Close {count, plural, one {# ticket} other {# tickets}}',
    'ticket.details': 'Details',
    'ticket.related': 'Related',
  };
  const W2_ES = {
    ...ES,
    'ticket.close': 'Cerrar {count, plural, one {# incidencia} other {# incidencias}}',
    'ticket.details': 'Detalles',
    'ticket.related': 'Relacionadas',
  };
  let loadedW2: LoadedApp | undefined;
  const wave2 = async () =>
    (loadedW2 ??= await loadApp(
      appDir(
        'wave2',
        definition({
          resources: {
            ...definition().resources,
            ticket: {
              ...(definition().resources as Record<string, Record<string, unknown>>).ticket,
              actions: { close: { label: msg('ticket.close'), set: { status: 'closed' }, bulk: true } },
            },
          },
          pages: {
            'ticket-page': {
              base: 'ticket',
              sections: [
                { kind: 'fields', show: ['title'], tab: msg('ticket.details') },
                { kind: 'fields', show: ['status'], tab: msg('ticket.related'), title: msg('ticket.open') },
              ],
            },
          },
        }),
        { 'en.mjs': catalog('en', W2_EN), 'es.mjs': catalog('es', W2_ES) },
      ),
      { lock: 'report' },
    ));

  test('a picked language is a cookie, read among the catalogs; a person row is where the picker writes', async () => {
    const loaded = await wave2();
    const cookie = (value: string) => ({ headers: { cookie: `a=b; mistri-locale-words=${value}` } });
    assert.equal(pickedLocale(loaded.app, cookie('es-MX')), 'es-MX');
    assert.equal(pickedLocale(loaded.app, cookie('fr')), undefined, 'a tag outside the catalogs is no choice');
    assert.equal(pickedLocale(loaded.app, { headers: {} }), undefined);
    assert.equal(
      requestLocale(loaded.app, { visitor: true, req: { headers: { cookie: 'mistri-locale-words=es', 'accept-language': 'en' } } }),
      'es',
      "the reader's pick is over the browser's header",
    );
    const app = { ...loaded.app, ui: { ...loaded.app.ui, localeColumn: 'person.locale' } } as unknown as AppDef;
    assert.deepEqual(localeRow(app, SCHEMA, { person: { table: 'person', key: 7 } } as never), {
      table: 'person',
      key: { id: 7 },
      column: 'locale',
    });
    assert.equal(localeRow(app, SCHEMA, { person: { table: 'ticket', key: 7 } } as never), undefined, "only the column's own table");
    assert.equal(localeRow(loaded.app, SCHEMA, { person: { table: 'person', key: 7 } } as never), undefined, 'no column, no row');
  });

  test("a counting action label is said for one record, and travels parsed in the reader's language", async () => {
    const loaded = await wave2();
    const close = loaded.app.resources!.ticket.actions![0] as { id: string; label: string; counted?: unknown };
    assert.equal(close.label, 'Close 1 ticket');
    assert.ok(Array.isArray(close.counted), 'the parsed message rides beside the words');
    const es = localizedApp(loaded, 'es').app.resources!.ticket.actions![0] as typeof close;
    assert.equal(es.label, 'Cerrar 1 incidencia');
    assert.notDeepEqual(es.counted, close.counted);
    assert.equal(loaded.app.resources!.ticket.actions!.length, 1);
  });

  test("a page section's tab keeps its source words beside the reader's: one address in every language", async () => {
    const loaded = await wave2();
    const page = (pages: readonly { id: string; sections: unknown[] }[]) =>
      pages.find((p) => p.id === 'ticket-page')!.sections as Array<{ tab?: string; title?: string; addressWords?: unknown }>;
    assert.equal(page(loaded.pages)[0].addressWords, undefined, 'the source needs no second spelling');
    const es = page(localizedApp(loaded, 'es').pages);
    assert.equal(es[0].tab, 'Detalles');
    assert.deepEqual(es[0].addressWords, { tab: 'Details' });
    assert.deepEqual(es[1].addressWords, { tab: 'Related', title: 'Open' });
  });

  test("a noun and the word after a fact take msg() with a plural, said for one and for many in the reader's language", async () => {
    const loaded = await loadApp(
      appDir(
        'plural-words',
        definition({
          resources: {
            ...definition().resources,
            ticket: {
              ...(definition().resources as Record<string, Record<string, unknown>>).ticket,
              noun: msg('ticket.noun'),
            },
          },
          pages: {
            'ticket-page': {
              base: 'ticket',
              sections: [{ kind: 'header', facts: [{ column: 'title', after: msg('ticket.noun') }] }],
            },
          },
        }),
        {
          'en.mjs': catalog('en', { ...EN, 'ticket.noun': '{count, plural, one {ticket} other {tickets}}' }),
          'es.mjs': catalog('es', { ...ES, 'ticket.noun': '{count, plural, one {incidencia} other {incidencias}}' }),
        },
      ),
      { lock: 'report' },
    );
    const nounOf = (app: AppDef) => (app.resources!.ticket as { noun?: unknown }).noun;
    assert.deepEqual(nounOf(loaded.app), { one: 'ticket', many: 'tickets' });
    assert.deepEqual(nounOf(localizedApp(loaded, 'es').app), { one: 'incidencia', many: 'incidencias' });
    const fact = (pages: readonly { id: string; sections: unknown[] }[]) =>
      (pages.find((p) => p.id === 'ticket-page')!.sections[0] as { factLabels?: Record<string, unknown> }).factLabels?.title;
    assert.deepEqual(fact(loaded.pages), { one: 'ticket', many: 'tickets' });
    assert.deepEqual(fact(localizedApp(loaded, 'es').pages), { one: 'incidencia', many: 'incidencias' });
  });

  test('a windowed section whose title has no letters an address can carry is named by its place', () => {
    const sections = [
      { kind: 'metric', title: 'Totals' },
      { kind: 'chart', title: '売上', windows: ['last 7 days'] },
      { kind: 'chart', title: 'Lines moved', windows: ['last 7 days'] },
    ] as unknown as Parameters<typeof nameSectionWindows>[0];
    nameSectionWindows(sections, 'views.home');
    assert.equal((sections[1] as { windowKey?: string }).windowKey, 'section-2');
    assert.equal((sections[2] as { windowKey?: string }).windowKey, 'lines-moved');
  });

  test("the share card's locale is in its address, and the route reads only that", async () => {
    drawShareCardsWith(async () => ({}) as never);
    try {
      const card = { site: 'Words', title: 'Tickets', ground: '#fff', ink: '#000', muted: '#666', accent: '#00f' } as never;
      const image = await shareCardImage('https://words.test', { base: '' } as never, '/words/tickets', card, 'es-MX');
      const url = new URL(image!);
      assert.equal(url.searchParams.get('locale'), 'es-MX');
      assert.deepEqual(cardRequest(url)?.locale, 'es-MX');
      url.searchParams.set('locale', 'not a tag');
      assert.equal(cardRequest(url), undefined);
      assert.equal(
        new URL((await shareCardImage('https://words.test', { base: '' } as never, '/words', card))!).searchParams.has('locale'),
        false,
      );
    } finally {
      drawShareCardsWith(async () => undefined);
    }
    const headers: Record<string, string> = { vary: 'Origin, Accept-Language' };
    const res = {
      getHeader: (name: string) => headers[name],
      setHeader: (name: string, value: string) => void (headers[name] = value),
      removeHeader: (name: string) => void delete headers[name],
    } as unknown as ServerResponse;
    unvaryOnLanguage(res);
    assert.equal(headers.vary, 'Origin');
    headers.vary = 'Accept-Language';
    unvaryOnLanguage(res);
    assert.equal(headers.vary, undefined);
  });

  test("a non-English reader's chrome words are preloaded beside the entry; English needs none", () => {
    const files = ['assets/index-abc.js', 'assets/copy.es-Dz12_x.js', 'assets/copy.es-Dz12_x.js.map'];
    assert.equal(localePreloads('es-MX', files), '    <link rel="modulepreload" crossorigin href="/assets/copy.es-Dz12_x.js">\n');
    assert.equal(localePreloads('en-US', files), '');
    assert.equal(localePreloads('fr', files), '', 'a language the chrome has no words for has nothing to preload');
    assert.equal(localePreloads(undefined, files), '');
  });

  test("a notice email's lines are said in the recipient's language, read from their row", async () => {
    const app = {
      id: 'words',
      name: 'Words',
      auth: { me: { from: 'person', column: 'email' } },
      ui: { locale: 'en-US', localeColumn: 'person.locale' },
    } as unknown as AppDef;
    const asked: unknown[] = [];
    const locale = await recipientLocale(
      app,
      SCHEMA,
      async (request) => {
        asked.push(request.filter);
        return { columns: ['locale'], rows: [{ locale: 'es-MX' }] } as never;
      },
      'ana@example.test',
    );
    assert.equal(locale, 'es-MX');
    assert.deepEqual(asked, [{ groups: [[{ column: 'email', op: '=', value: 'ana@example.test' }]] }]);
    const es = messageOf(app, 'https://words.test/words/tickets/1', 'Asignada: Printer', 'Ana', 'North', locale);
    assert.equal(
      es.text,
      'Asignada: Printer\n\nEn North.\nPor Ana.\nÁbrelo: https://words.test/words/tickets/1\n\nRecibes esto porque las notificaciones por correo están activadas en tu cuenta de Words. Desactívalas en Notificaciones, en Words.',
    );
    assert.match(messageOf(app, 'https://x', 'T', '', undefined, 'fr').text, /^T\n\nOpen it: https:\/\/x\n\nYou get this/);
    const failing = await recipientLocale(app, SCHEMA, async () => Promise.reject(new Error('down')), 'ana@example.test');
    assert.equal(failing, 'en-US', "a read that fails says the App's own");
  });

  test('messages extract: a catalog gains its missing keys as comments once; literal captions are listed with keys', async () => {
    const dir = appDir(
      'extract',
      definition({ views: { ...definition().views, board: { kind: 'list', from: 'ticket', label: 'Open board' } } }),
      {
        'en.mjs': catalog('en', EN),
        'es.mjs': catalog('es', ES),
      },
    );
    /* The catalog it writes imports @mistriwork/mistri/app, as an App's own does: this checkout is that package here. */
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(process.cwd(), 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    const said: string[] = [];
    const log = console.log;
    console.log = (line: string) => void said.push(line);
    try {
      await runMessagesCommand(['extract', '--app', dir, '--locale', 'fr']);
      await runMessagesCommand(['extract', '--app', dir, '--locale', 'fr']);
      await runMessagesCommand(['extract', '--app', dir]);
    } finally {
      console.log = log;
    }
    assert.match(said[0], /Wrote messages\/fr\.ts with 6 keys/);
    assert.match(said[1], /has every key/);
    const fr = readFileSync(join(dir, 'messages', 'fr.ts'), 'utf8');
    assert.match(fr, /defineMessages<typeof en>\('fr', \{\n {2}\/\/ 'ticket\.plural': 'Tickets',/);
    assert.equal(fr.match(/'ticket\.plural'/g)?.length, 1, 'appended once');
    assert.ok(said.some((line) => /views\.board\.label\s+"Open board"\s+→ board\.openBoard/.test(line)));
    assert.deepEqual(
      literalCaptions({ views: { a: { label: msg('ticket.plural'), title: 'x1' } } }).map((c) => c.key),
      ['a.x1'],
    );
    await assert.rejects(runMessagesCommand(['extract', '--app', dir, '--locale', 'en']), /source catalog/);
  });
});
