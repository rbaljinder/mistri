/** Typed process boundary for test-only production maintenance operations. */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type TestMaintenanceRequest =
  | { kind: 'validate'; directory: string }
  | { kind: 'account'; file: string; input: { name: string; email: string; password: string } }
  | { kind: 'grant'; file: string; input: { appId: string; subjectId: string; roles: readonly string[]; expectedRevision: number } };

/** The child owns the server graph; the public entry exposes only plain data. */
export async function runTestMaintenance<T>(
  request: TestMaintenanceRequest,
  environment: Record<string, string> = {},
  allowedHosts: readonly string[] = [],
): Promise<T> {
  const built = fileURLToPath(new URL('./maintenanceWorker.js', import.meta.url));
  const source = !existsSync(built);
  const guard = new URL(source ? './networkGuard.ts' : './networkGuard.js', import.meta.url).href;
  const home = await mkdtemp(join(tmpdir(), 'mistri-maintenance-'));
  const config = join(home, 'config');
  const absoluteRequest =
    request.kind === 'validate' ? { ...request, directory: resolve(request.directory) } : { ...request, file: resolve(request.file) };
  try {
    await mkdir(config);
    return await new Promise<T>((resolve, reject) => {
      const child = fork(source ? fileURLToPath(new URL('./maintenanceWorker.ts', import.meta.url)) : built, [], {
        cwd: home,
        execArgv: [...(source ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : []), '--import', guard],
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          NODE_ENV: 'test',
          ...environment,
          MISTRI_TEST_ALLOWED_HOSTS: JSON.stringify(allowedHosts),
          HOME: home,
          XDG_CONFIG_HOME: config,
          ...(source ? { TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../tsconfig.json', import.meta.url)) } : {}),
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let response: { ok: boolean; value?: T; error?: string } | undefined,
        logs = '',
        denied = false,
        markerTail = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      timer.unref();
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        denied ||= (markerTail + text).includes('[mistri-test-network-denied]');
        markerTail = (markerTail + text).slice(-40);
        logs = (logs + text).slice(-8000);
      });
      child.on('message', (value) => {
        response = value as typeof response;
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (denied) reject(new Error('Test maintenance attempted an unexpected outbound connection.'));
        else if (code === 0 && response?.ok) resolve(response.value as T);
        else reject(new Error(response?.error ?? `Test maintenance ${request.kind} failed. ${logs}`));
      });
      child.send(absoluteRequest);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
