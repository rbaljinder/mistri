import { spawn } from './spawned.js';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { TenantPublicFormOptions } from '../../test/support/tenantPublicForms.js';

/**
 * The tenant public-forms host (test/support/tenantPublicForms.ts) in a process of its own, with the options a spec
 * asks for, on SQLite: two dealers, each with an intake address. `statusCheck` also seeds one application, `YRD-1`, in
 * each place (north's Ada is reviewing, south's Bea approved), and with `'sms'` saves north's FakePay key. What the
 * host sent — mail, texts — and the database are read over IPC: there is no test authority on the HTTP host.
 */
export interface TenantPublicFormsApp {
  origin: string;
  /** The messages the host's email service sent, oldest first. */
  mail(): Promise<Array<{ to: string; subject: string; text: string }>>;
  /** The texts FakePay's sms channel sent, oldest first. */
  texts(): Promise<Array<{ to: string; apiKey: string; text: string }>>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  stop(): Promise<void>;
}

/* The dealers' intake addresses, as the fixture names them: written here so a spec does not load the server to know them. */
export const NORTH = 'north-intake-AAAAAAAAAAAAAAAA';
export const SOUTH = 'south-intake-CCCCCCCCCCCCCCCC';
export const via = (address: string) => `?via=${encodeURIComponent(address)}`;

type Options = Pick<TenantPublicFormOptions, 'publicReads' | 'words' | 'localMakes' | 'models' | 'localeReference'> & {
  statusCheck?: true | 'sms';
};
type Ask = { id: number; type: 'mail' | 'texts' } | { id: number; type: 'rows'; sql: string };
type Message = { type: 'ready'; origin: string } | { type: 'reply'; id: number; value?: unknown; error?: string };

export async function startTenantPublicForms(options: Options = {}): Promise<TenantPublicFormsApp> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), '--public-forms-child', JSON.stringify(options)],
    {
      env: { ...process.env, DATABASE_URL: '', MISTRI_OPEN: '0', MISTRI_AUTH_ADMIN_EMAIL: '', MISTRI_AUTH_ADMIN_PASSWORD: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let log = '';
  const output = (chunk: Buffer) => (log = (log + String(chunk)).slice(-16384));
  child.stdout!.on('data', output);
  child.stderr!.on('data', output);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  };
  let next = 0;
  const ask = <T>(payload: { type: 'mail' | 'texts' } | { type: 'rows'; sql: string }) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => done(new Error('The public-forms fixture did not answer')), 10000);
      const message = (value: Message) => {
        if (value.type === 'reply' && value.id === id) done(value.error ? new Error(value.error) : undefined, value.value as T);
      };
      const done = (error?: Error, value?: T) => {
        clearTimeout(timer);
        child.off('message', message);
        if (error) reject(error);
        else resolve(value!);
      };
      child.on('message', message);
      child.send({ ...payload, id } satisfies Ask, (error) => {
        if (error) done(error);
      });
    });
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The public-forms fixture did not start: ${log}`)), 25000);
      child.on('message', (value: Message) => {
        if (value.type !== 'ready') return;
        clearTimeout(timer);
        resolve(value.origin);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`The public-forms fixture exited during startup: ${log}`));
      });
    });
    return {
      origin,
      mail: () => ask({ type: 'mail' }),
      texts: () => ask({ type: 'texts' }),
      rows: (sql) => ask({ type: 'rows', sql }),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[2] === '--public-forms-child') {
  const options = JSON.parse(process.argv[3]!) as Options;
  const { openTenantPublicForms, publicFormsDatabase } = await import('../../test/support/tenantPublicForms.js');
  const { provider } = await import('../../test/fixtures/integrations/fakepay/index.js');
  const cleanups: Array<() => unknown> = [];
  const context = { after: (fn: () => unknown) => cleanups.push(fn) } as unknown as TestContext;
  const forms = await openTenantPublicForms(context, 'sqlite', publicFormsDatabase(), options);
  if (options.statusCheck) {
    // The same reference in each place, as test/tenant-status-check.test.ts seeds it.
    await forms.engine.exec(
      `INSERT INTO lead (id, tenant_id, reference, name, status, email, mobile, more) VALUES
        ('n1', 'north', 'YRD-1', 'Ada', 'reviewing', 'ada@example.test', '+1 (555) 010-0001', 'North detail'),
        ('s1', 'south', 'YRD-1', 'Bea', 'approved', 'bea@example.test', '+1 (555) 010-0002', 'South detail')`,
    );
  }
  if (options.statusCheck === 'sms') {
    const { integrationRuntimeOf, saveIntegrationSettings } =
      await import('../../packages/mistri/src/server/integrations/integrationRuntime.js');
    await saveIntegrationSettings(integrationRuntimeOf('yard')!, 'north', 'north-owner', {
      integration: 'fakepay',
      secrets: { apiKey: 'sk_north', webhookSecret: 'whsec_north_0123456789abcdef' },
    });
  }
  process.on('message', (asked: Ask) => {
    void (async () => {
      try {
        const value =
          asked.type === 'mail'
            ? forms.mail()
            : asked.type === 'texts'
              ? provider.texts.map((sent) => ({ ...sent }))
              : await forms.rows(asked.sql);
        process.send?.({ type: 'reply', id: asked.id, value });
      } catch (error) {
        process.send?.({ type: 'reply', id: asked.id, error: String(error) });
      }
    })();
  });
  const stop = async () => {
    for (const fn of cleanups.reverse()) await Promise.resolve(fn()).catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.send?.({ type: 'ready', origin: forms.origin });
}
