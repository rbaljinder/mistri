/**
 * Regression suite for P1 hardening & polish fixes:
 * - P1-16: S3 Bucket.send() retries transient socket resets and 5xx errors without retrying TimeoutError or 404
 * - P1-17: sweepOverdueWorkflows() recovers stranded waiting/running instances
 * - P1-18: liveFilter evicts rejected authority.probe promises from shared memo so healthy subscribers still receive updates
 * - P1-21: mistri new --help exits 0, mistri new --api writes relative DB url + node_modules/ in .gitignore,
 *          and <DescriptionList resource="…" /> does not trigger [page-undeclared]
 * - Foundry smoke test: seeds Foundry DB, runs mistri check --warnings with 0 errors / 0 warnings
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Bucket } from '../packages/mistri/src/server/files/bucket.js';
import {
  deliverChange,
  emptyDelivery,
  keyText,
  type LiveAuthority,
  type LiveGrant,
  type ProbeMemo,
} from '../packages/mistri/src/server/live/liveFilter.js';
import { sweepOverdueWorkflows } from '../packages/mistri/src/server/workflows/workflowHost.js';
import type { WorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStoreContract.js';
import type { JobStore } from '../packages/mistri/src/adapters/jobs/jobStoreContract.js';
import { runNewApp } from '../packages/mistri/src/server/cli/newApp.js';
import { runNewApi } from '../packages/mistri/src/server/cli/newApi.js';
import { astParser, scanPageSource } from '../packages/mistri/src/server/app/appPages.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('P1-16: Bucket.send() retries transient network drops and 503 responses, but does not retry 404 or TimeoutError', async () => {
  let calls = 0;
  const bucket = new Bucket(
    { name: 'test-bucket', endpoint: 'http://127.0.0.1:19999', pathStyle: true },
    { accessKeyId: 'test', secretAccessKey: 'secret' },
    async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      if (calls === 2) return new Response('busy', { status: 503 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    },
  );
  const bytes = await bucket.bytes('hello.bin');
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
  assert.equal(calls, 3);

  let notFoundCalls = 0;
  const bucket404 = new Bucket(
    { name: 'test-bucket', endpoint: 'http://127.0.0.1:19999', pathStyle: true },
    { accessKeyId: 'test', secretAccessKey: 'secret' },
    async () => {
      notFoundCalls++;
      return new Response('', { status: 404 });
    },
  );
  assert.equal(await bucket404.bytes('missing.bin'), undefined);
  assert.equal(notFoundCalls, 1);

  let timeoutCalls = 0;
  const bucketTimeout = new Bucket(
    { name: 'test-bucket', endpoint: 'http://127.0.0.1:19999', pathStyle: true },
    { accessKeyId: 'test', secretAccessKey: 'secret' },
    async () => {
      timeoutCalls++;
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    },
  );
  await assert.rejects(() => bucketTimeout.bytes('slow.bin'), /could not be reached/);
  assert.equal(timeoutCalls, 1);
});

test('P1-17: sweepOverdueWorkflows wakes overdue waiting and stalled running instances', async () => {
  const enqueued: Array<{ job: string; key: string; instance: string; tenantId?: string }> = [];
  const now = 1_000_000;
  const workflows = {
    inspect: async (filter?: { state?: string }) => {
      if (filter?.state === 'waiting') {
        return [
          {
            id: '00000000-0000-4000-8000-000000000001',
            workflow: 'onboard',
            version: 1,
            key: 'k1',
            state: 'waiting' as const,
            currentStep: 'wait-email',
            waitEvent: null,
            wakeAt: now - 30_000,
            problem: null,
            problemStep: null,
            createdAt: now - 60_000,
            updatedAt: now - 30_000,
          },
          {
            id: '00000000-0000-4000-8000-000000000002',
            workflow: 'onboard',
            version: 1,
            key: 'k2',
            state: 'waiting' as const,
            currentStep: 'future-step',
            waitEvent: null,
            wakeAt: now + 60_000,
            problem: null,
            problemStep: null,
            createdAt: now - 10_000,
            updatedAt: now - 10_000,
          },
        ];
      }
      return [
        {
          id: '00000000-0000-4000-8000-000000000003',
          workflow: 'onboard',
          version: 1,
          key: 'k3',
          state: 'running' as const,
          currentStep: 'step-1',
          waitEvent: null,
          wakeAt: null,
          problem: null,
          problemStep: null,
          createdAt: now - 200_000,
          updatedAt: now - 180_000,
        },
      ];
    },
  } as unknown as WorkflowStore;
  const jobs = {
    enqueue: async (req: { job: string; idempotencyKey: string; input: { instance: string }; provenance: { tenantId?: string } }) => {
      enqueued.push({
        job: req.job,
        key: req.idempotencyKey,
        instance: req.input.instance,
        tenantId: req.provenance.tenantId,
      });
      return { id: 'j1', replayed: false };
    },
  } as unknown as JobStore;
  const module = {
    workflows: new Map([['onboard', { name: 'onboard', version: 1, runAs: 'worker' }]]),
  } as unknown as Parameters<typeof sweepOverdueWorkflows>[0]['module'];

  const woken = await sweepOverdueWorkflows(
    {
      module,
      appId: 'demo',
      workflows,
      jobs,
      now: () => now,
      attemptTimeoutMs: 30_000,
    },
    now,
  );
  assert.equal(woken, 2);
  assert.deepEqual(
    enqueued.map((e) => [e.job, e.instance]),
    [
      ['wf-onboard', '00000000-0000-4000-8000-000000000001'],
      ['wf-onboard', '00000000-0000-4000-8000-000000000003'],
    ],
  );
});

test('P1-18: liveFilter evicts rejected authority.probe from shared memo so healthy subscribers still receive updates', async () => {
  const change = {
    seq: 1,
    at: Date.now(),
    appId: 'demo',
    entries: [{ table: 'listing', kind: 'update', keys: [{ id: 42 }] }],
  } as unknown as Parameters<typeof deliverChange>[0];
  const grant: LiveGrant = {
    id: 'listing',
    key: ['id'],
    columns: 'all',
    fingerprint: 'same-role-fingerprint',
    scope: { column: 'org_id', values: ['org-1'] } as unknown as LiveGrant['scope'],
  };
  const memo: ProbeMemo = new Map();
  const failingAuthority: LiveAuthority = {
    actor: 'user:1',
    tables: new Map([['listing', grant]]),
    probe: async () => {
      throw new Error('lease expired');
    },
  };
  const healthyAuthority: LiveAuthority = {
    actor: 'user:2',
    tables: new Map([['listing', grant]]),
    probe: async () => new Set([keyText({ id: 42 })]),
  };

  const firstInto = emptyDelivery();
  const firstTold = await deliverChange(change, failingAuthority, firstInto, memo);
  assert.equal(firstTold, false);
  assert.equal(memo.size, 0, 'rejected probe promise must be evicted from shared memo');

  const secondInto = emptyDelivery();
  const secondTold = await deliverChange(change, healthyAuthority, secondInto, memo);
  assert.equal(secondTold, true);
  assert.equal(secondInto.tables.has('listing'), true);
});

test('P1-21: mistri new --help exits 0, new --api uses relative DB url + node_modules/ .gitignore, and DescriptionList resource is not flagged', async () => {
  const code = await runNewApp(['--help']);
  assert.equal(code, 0);

  const dir = mkdtempSync(join(tmpdir(), 'mistri-new-api-p1-'));
  try {
    const outDir = join(dir, 'orders');
    const apiCode = await runNewApi(['--api', 'Orders', outDir]);
    assert.equal(apiCode, 0);
    const config = JSON.parse(readFileSync(join(outDir, 'mistri.json'), 'utf8')) as { connections: Array<{ url: string }> };
    assert.equal(config.connections[0]!.url, 'orders.db');
    const gitignore = readFileSync(join(outDir, '.gitignore'), 'utf8');
    assert.match(gitignore, /^node_modules\/$/m);

    const parseAst = await astParser();
    const scan = scanPageSource(
      parseAst,
      `import { DescriptionList } from '@mistriwork/mistri/page';
export default function Detail({ data }: { data: { title: string } }) {
  return <DescriptionList resource="listing" items={[{ label: 'Title', value: data.title }]} />;
}
`,
      'tsx',
      { key: 'detail', reads: [], commands: [] },
    );
    assert.deepEqual(scan.undeclared, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Foundry sample smoke test: seeds database and passes mistri check --warnings cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-foundry-smoke-'));
  try {
    const dbPath = join(dir, 'foundry.db');
    const run = async (args: string[]) => {
      const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        stdout += c;
      });
      child.stderr.on('data', (c: string) => {
        stderr += c;
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const [status] = await once(child, 'exit').finally(() => clearTimeout(timer));
      return { status, stdout, stderr };
    };

    const seeded = await run([join(ROOT, 'examples/databases/foundry/seed.mjs'), dbPath]);
    assert.equal(seeded.status, 0, seeded.stderr);

    const configText = readFileSync(`${dbPath}.json`, 'utf8');
    assert.ok(configText.includes('foundry'));

    const checked = await run([
      '--import',
      import.meta.resolve('tsx'),
      join(ROOT, 'packages/mistri/src/server/index.ts'),
      'check',
      '--warnings',
      '--app',
      join(ROOT, 'examples/apps/foundry'),
      '--config',
      `${dbPath}.json`,
    ]);
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
