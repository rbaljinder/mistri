import { spawn } from './spawned.js';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

/**
 * The tenant public-forms host (test/support/tenantPublicForms.ts) with north's saved branding naming a font its App
 * ships, in a process of its own: a form reached by north's intake address is dressed in that tenant's look, face
 * included. The child prints its origin and the address once it listens, and cleans up when it is told to stop.
 */
export interface BrandedFontApp {
  origin: string;
  /** The form's page, as north's visitors reach it. */
  page: string;
  stop(): Promise<void>;
}

export async function startBrandedFontApp(): Promise<BrandedFontApp> {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--branded-font-child'], {
    env: { ...process.env, DATABASE_URL: '', MISTRI_OPEN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr!.on('data', (chunk: Buffer) => (log = (log + String(chunk)).slice(-16384)));
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
  try {
    const ready = await new Promise<{ origin: string; page: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The branded-font fixture did not start: ${log}`)), 25000);
      let out = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        out += String(chunk);
        const line = /^READY (\S+) (\S+)$/m.exec(out);
        if (line) {
          clearTimeout(timer);
          resolve({ origin: line[1]!, page: line[2]! });
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`The branded-font fixture exited during startup: ${log}`));
      });
    });
    return { ...ready, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[2] === '--branded-font-child') {
  const { openTenantPublicForms, publicFormsDatabase, NORTH, via } = await import('../../test/support/tenantPublicForms.js');
  const cleanups: Array<() => unknown> = [];
  const context = { after: (fn: () => unknown) => cleanups.push(fn) } as unknown as TestContext;
  const forms = await openTenantPublicForms(context, 'sqlite', publicFormsDatabase(), { tenantBranding: true, tenantFont: true });
  const stop = async () => {
    for (const fn of cleanups.reverse()) await Promise.resolve(fn()).catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  console.log(`READY ${forms.origin} ${forms.origin}/yard/form/apply${via(NORTH)}`);
}
