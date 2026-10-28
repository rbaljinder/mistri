/**
 * The validation record (tenantValidationRecord.ts): a production build's start
 * reads one row beside the catalog digest, and checks only what the row does not
 * vouch for.
 *
 * The planning and the fingerprints run everywhere: a source App, `mistri dev`
 * and `mistri check` have none, a build's look is not a declaration, and a
 * record that cannot be read is a full check. The starts run on Ignition
 * deployed on PostgreSQL (live and opt-in: TABLEWALK_TEST_PG), through a relay
 * that counts what each start sends: no record is a full check that keeps one,
 * the same build on the same catalog skips the catalog checks, another build is
 * the catalog read once and checked whole, another catalog is a full check, a
 * record store that is gone is a full check that keeps nothing, and two starts
 * at once each keep a record that is true.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { loadApp, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { buildApp } from '../packages/mistri/src/server/build/build.js';
import { loadRolldown } from '../packages/mistri/src/server/build/bundle.js';
import {
  provisionPostgresValidationRecordAt,
  readPostgresValidationRecord,
  writePostgresValidationRecord,
} from '../packages/mistri/src/adapters/validation/postgresValidationRecord.js';
import { TENANT_STARTUP_CHECKS } from '../packages/mistri/src/server/tenant/tenantFeatures.js';
import { prepareTenantStartup } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import {
  buildFingerprints,
  changedTables,
  planValidation,
  type BuildFingerprints,
  type ValidationPlan,
} from '../packages/mistri/src/server/tenant/tenantValidationRecord.js';
import { liveSkip } from './live.js';
import { IGNITION_DIR, openIgnitionLending } from './support/ignitionLendingFixture.js';
import { pgClient } from './support/tenantDialects.js';
import { startLatencyProxy } from '../e2e/support/latencyProxy.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const fingerprints = (build: string, declarations: string): BuildFingerprints => ({
  build: build.repeat(64).slice(0, 64),
  declarations: declarations.repeat(64).slice(0, 64),
});
const stored = (over: Partial<Parameters<typeof writePostgresValidationRecord>[2]> = {}) => ({
  build: 'a'.repeat(64),
  declarations: 'b'.repeat(64),
  schema: 'digest',
  migration: null,
  tables: { lead: 'x' },
  stores: [],
  mistri: '0',
  checkedAt: '2026-10-27T00:00:00.000Z',
  ...over,
});

describe('planning from a record', () => {
  test('no record, another catalog, or a record that cannot be read is a full check', async () => {
    const live = fingerprints('a', 'b');
    assert.equal((await planValidation(live, async () => ({ schema: 'digest' }))).mode, 'full');
    const moved = await planValidation(live, async () => ({ schema: 'other', stored: stored() }));
    assert.equal(moved.mode, 'full');
    assert.match(moved.reason, /the catalog changed/);
    const gone = await planValidation(live, async () => {
      throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    });
    assert.equal(gone.mode, 'full');
    assert.equal(gone.unreadable, true);
    assert.match(gone.reason, /not provisioned/);
    // What it says names the remedy, never the database's address or the error's text.
    assert.doesNotMatch(gone.reason, /relation|postgres:\/\//);
    const silent = await planValidation(live, async () => {
      throw new Error('connect ECONNREFUSED');
    });
    assert.deepEqual([silent.mode, silent.unreadable, /ECONNREFUSED/.test(silent.reason)], ['full', true, false]);
  });

  test('the same build, or another build of the same declarations, skips; other declarations are selective', async () => {
    const same: ValidationPlan = await planValidation(fingerprints('a', 'b'), async () => ({ schema: 'digest', stored: stored() }));
    assert.equal(same.mode, 'skip');
    const look = await planValidation(fingerprints('c', 'b'), async () => ({ schema: 'digest', stored: stored() }));
    assert.equal(look.mode, 'skip');
    assert.match(look.reason, /only its look or client changed/);
    assert.equal((await planValidation(fingerprints('c', 'd'), async () => ({ schema: 'digest', stored: stored() }))).mode, 'selective');
  });

  test('the tables a record names anew are the ones whose own declaration moved, came or went', () => {
    assert.deepEqual(changedTables({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' }), ['b', 'c', 'd']);
    assert.deepEqual(changedTables({ a: '1' }, { a: '1' }), []);
  });

  test('a commands check that reads the catalog says so, or a start that skipped it reads it anyway', () => {
    /* An unmarked check that reads `owned` starts the validation again in full (tenantStartup.ts): slower, never
       unchecked. This keeps that path the exception: every commands check naming `owned` is marked. */
    for (const check of TENANT_STARTUP_CHECKS) {
      if (check.phase !== 'commands' || check.catalog) continue;
      assert.doesNotMatch(String(check.run), /\bowned\b/, `${check.stage ?? 'a commands check'} reads the catalog: mark it catalog: true`);
    }
  });
});

describe("a build's fingerprints", () => {
  const work = mkdtempSync(join(tmpdir(), 'tablewalk-validation-build-'));
  after(() => rmSync(work, { recursive: true, force: true }));
  const connections: ConnectionConfig[] = [
    { id: 'loans', name: 'loans', url: 'postgres://u@h/loans', source: 'config', writable: true },
    { id: 'applicants', name: 'applicants', url: 'postgres://u@h/applicants', source: 'config' },
  ];
  let built: { out: string; loaded: LoadedApp } | undefined;
  const build = async () => {
    if (!built) {
      const { out } = await buildApp(
        {
          app: IGNITION_DIR,
          out: join(work, 'ignition'),
          policy: join(IGNITION_DIR, 'tenant-policy.ts'),
          commands: join(IGNITION_DIR, 'commands.ts'),
        },
        { bundler: loadRolldown, typecheck: false },
      );
      built = { out, loaded: await loadApp(out) };
    }
    return built;
  };
  const files = (out: string) => ({ policy: join(out, 'server/policy.mjs'), commands: join(out, 'server/commands.mjs') });

  test('a source App, `mistri dev` and `mistri check` have none, so each checks in full', async () => {
    const source = await loadApp(IGNITION_DIR);
    assert.equal(await buildFingerprints(source, { policy: join(IGNITION_DIR, 'tenant-policy.ts') }, connections), undefined);
    const { out, loaded } = await build();
    assert.ok(await buildFingerprints(loaded, files(out), connections));
    assert.equal(await buildFingerprints(loaded, files(out), connections, { dev: true }), undefined);
    assert.equal(await buildFingerprints(loaded, files(out), connections, { check: true }), undefined);
  });

  test('a build started with code that is not its own has none', async () => {
    const { out, loaded } = await build();
    assert.equal(
      await buildFingerprints(loaded, { ...files(out), policy: join(IGNITION_DIR, 'tenant-policy.ts') }, connections),
      undefined,
    );
    assert.equal(await buildFingerprints(loaded, { policy: files(out).policy }, connections), undefined);
  });

  test('the same build is the same fingerprint; its look is not a declaration; a declaration or a connection is', async () => {
    const { out, loaded } = await build();
    const first = (await buildFingerprints(loaded, files(out), connections))!;
    assert.deepEqual(await buildFingerprints(await loadApp(out), files(out), connections), first);
    const restyled = { ...loaded, app: { ...loaded.app, ui: { ...loaded.app.ui, theme: 'sage' } } } as LoadedApp;
    assert.equal((await buildFingerprints(restyled, files(out), connections))!.declarations, first.declarations);
    const renamed = { ...loaded, app: { ...loaded.app, name: 'Ignition, renamed' } } as LoadedApp;
    assert.notEqual((await buildFingerprints(renamed, files(out), connections))!.declarations, first.declarations);
    const readOnly = connections.map((each) => ({ ...each, writable: false }));
    const other = (await buildFingerprints(loaded, files(out), readOnly))!;
    assert.notEqual(other.build, first.build);
    assert.notEqual(other.declarations, first.declarations);
  });
});

describe('starts of Ignition on PostgreSQL with a validation record', { skip: liveSkip('postgres', LIVE) }, () => {
  async function deployment(t: TestContext) {
    const lending = await openIgnitionLending(t, 'postgres', { events: true });
    const relay = await startLatencyProxy(LIVE!, 0);
    t.after(() => relay.close());
    const url = lending.source.url!;
    await provisionPostgresValidationRecordAt(url);
    const loaded = await loadApp(IGNITION_DIR);
    const connections: ConnectionConfig[] = [
      { id: 'loans', name: 'loans', url: relay.route(url), source: 'config', writable: true },
      { id: 'applicants', name: 'applicants', url: relay.route(lending.platformSources[0].url!), source: 'config' },
    ];
    const input = {
      loaded,
      connections,
      policyFile: join(IGNITION_DIR, 'tenant-policy.ts'),
      commandsFile: join(IGNITION_DIR, 'commands.ts'),
    };
    /** One start, and the statements it sent. */
    const start = async (record?: BuildFingerprints) => {
      const since = Date.now();
      const prepared = await prepareTenantStartup(input, process.env, record ? { record } : {});
      return { prepared, statements: relay.statements(since).length };
    };
    const row = async () => (await readPostgresValidationRecord(url, { app: loaded.app.id, source: 'lending' })).stored;
    const ddl = async (sql: string) => {
      const client = await pgClient(url);
      try {
        await client.query(sql);
      } finally {
        await client.end();
      }
    };
    return { url, start, row, ddl, loaded };
  }

  test('no record is a full check that keeps one; the same build then skips the catalog checks', async (t) => {
    const { start, row } = await deployment(t);
    const live = fingerprints('1', '2');
    const full = await start(live);
    assert.equal(full.prepared.validation?.plan.mode, 'full');
    assert.match(full.prepared.validation!.say, /none yet/);
    assert.ok(full.prepared.linkSurfaces.length, 'a full check gives what it validated');
    assert.equal(await row(), undefined, 'nothing is kept before the host serves');
    await full.prepared.validation!.commit();
    const kept = (await row())!;
    assert.deepEqual([kept.build, kept.declarations], [live.build, live.declarations]);
    assert.ok(kept.stores.includes('command-journal'), 'the stores it attested');
    assert.ok(Object.keys(kept.tables).includes('loan_application'), 'each table it checked');

    const skipped = await start(live);
    assert.equal(skipped.prepared.validation?.plan.mode, 'skip');
    assert.match(skipped.prepared.validation!.say, /the catalog checks were skipped/);
    assert.ok(skipped.prepared.enrollment, 'it still enrolls the host, which attests what it serves from');
    assert.ok(
      skipped.statements * 3 < full.statements,
      `a skipped start sends a fraction of a full one: ${skipped.statements} statements against ${full.statements}`,
    );
    // Nothing new to keep: the row stands as it was.
    await skipped.prepared.validation!.commit();
    assert.equal((await row())!.checkedAt, kept.checkedAt);
    // Without a record (a source App, --dev, mistri check) the start is the full one, and says nothing of a record.
    const plain = await start();
    assert.equal(plain.prepared.validation, undefined);
    assert.ok(plain.prepared.linkSurfaces.length);
  });

  test('another build reads the catalog once and checks it whole, naming the resources declared anew', async (t) => {
    const { start, row, url, loaded } = await deployment(t);
    const first = await start(fingerprints('1', '2'));
    await first.prepared.validation!.commit();
    const kept = (await row())!;
    // As though the build that wrote it had declared one resource differently.
    await writePostgresValidationRecord(
      url,
      { app: loaded.app.id, source: 'lending' },
      { ...kept, tables: { ...kept.tables, loan_application: '0'.repeat(64) } },
    );
    const selective = await start(fingerprints('3', '4'));
    assert.equal(selective.prepared.validation?.plan.mode, 'selective');
    assert.match(selective.prepared.validation!.say, /one resource is declared anew \(loan_application\)/);
    assert.match(selective.prepared.validation!.say, /read once and checked whole/);
    assert.ok(selective.prepared.linkSurfaces.length, 'a selective start validated the catalog');
    assert.ok(selective.statements < first.statements, `${selective.statements} statements against a full ${first.statements}`);
    await selective.prepared.validation!.commit();
    assert.equal((await row())!.build, fingerprints('3', '4').build);
    assert.equal((await start(fingerprints('3', '4'))).prepared.validation?.plan.mode, 'skip');
    // Another build of the same declarations (its look) skips too, and keeps its own name for the next start.
    const look = await start(fingerprints('5', '4'));
    assert.equal(look.prepared.validation?.plan.mode, 'skip');
    await look.prepared.validation!.commit();
    assert.equal((await row())!.build, fingerprints('5', '4').build);
  });

  test('another catalog is a full check', async (t) => {
    const { start, ddl } = await deployment(t);
    const live = fingerprints('1', '2');
    await (await start(live)).prepared.validation!.commit();
    await ddl('CREATE INDEX validation_record_probe ON loan_application (id)');
    const moved = await start(live);
    assert.equal(moved.prepared.validation?.plan.mode, 'full');
    assert.match(moved.prepared.validation!.say, /the catalog changed/);
    await moved.prepared.validation!.commit();
    assert.equal((await start(live)).prepared.validation?.plan.mode, 'skip');
  });

  test('a record store that cannot be read is a full check that keeps nothing, and the start goes on', async (t) => {
    const { start, ddl, row } = await deployment(t);
    const live = fingerprints('1', '2');
    await (await start(live)).prepared.validation!.commit();
    await ddl('DROP TABLE mistri.validation_record');
    const gone = await start(live);
    assert.equal(gone.prepared.validation?.plan.mode, 'full');
    assert.equal(gone.prepared.validation?.plan.unreadable, true);
    assert.match(gone.prepared.validation!.say, /not provisioned/);
    assert.ok(gone.prepared.enrollment);
    await gone.prepared.validation!.commit();
    await assert.rejects(row(), { code: '42P01' });
  });

  test('two starts at once each check in full and keep a record that is true; the next start skips', async (t) => {
    const { start, row } = await deployment(t);
    const live = fingerprints('1', '2');
    const both = await Promise.all([start(live), start(live)]);
    assert.deepEqual(
      both.map((each) => each.prepared.validation?.plan.mode),
      ['full', 'full'],
    );
    await Promise.all(both.map((each) => each.prepared.validation!.commit()));
    assert.equal((await row())!.build, live.build);
    const racing = await Promise.all([start(live), start(fingerprints('6', '7'))]);
    assert.deepEqual(
      racing.map((each) => each.prepared.validation?.plan.mode),
      ['skip', 'selective'],
    );
    await Promise.all(racing.map((each) => each.prepared.validation!.commit()));
    // Last writer wins, and either row is one a start validated.
    assert.equal((await row())!.build, fingerprints('6', '7').build);
    assert.equal((await start(fingerprints('6', '7'))).prepared.validation?.plan.mode, 'skip');
  });
});
