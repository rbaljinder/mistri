/**
 * The real DeployRunner: the one place `mistri deploy` touches wrangler, the network, a shell, git, the database
 * and the build. Everything else is tested against a fake (test/deploy-flow.test.ts); this is exercised by a deploy.
 *
 * The migrations run from this machine over `--migrate-url` / MISTRI_MIGRATE_URL (a direct database address, never
 * the container's pooled one), through the same code `mistri migrate up` runs: the history table, its advisory
 * lock. `migrate stores up` for the App's own stores does NOT use it: it reads the store URLs the App's config names
 * from this process's environment, as it does anywhere else.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { createInterface as createLineInterface } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from '@mistriwork/engine/server/cli/args.js';
import { readStartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { migrateUp, migrationStatus, type MigrateTarget } from '@mistriwork/engine/server/migrate/runner.js';
import { resolveTarget } from '@mistriwork/engine/server/migrate/target.js';
import { appDockerfile } from '../build/dockerfile.js';
import { MIGRATE_APPS } from '../cli/appTargets.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';
import { openLedger } from './ledger.js';
import type { CheckFinding, CheckResult, DeployConfig, DeployFlags, DeployRunner, Exec, HttpAnswer } from './types.js';

const HTTP_MS = 20_000;

/** Calls `onLine` for each line of `stream`, as the lines complete. */
function createLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  createLineInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine);
}

const run = (command: string, args: string[], cwd: string): Promise<Exec> =>
  new Promise((done) => {
    execFile(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
    );
  });

/** The App's flags for the commands that read its configuration, as the command line spells them. */
const flagsOf = (config: DeployConfig, only: readonly (keyof DeployConfig)[]): string[] =>
  only.flatMap((key) => {
    const value = config[key];
    return typeof value === 'string' ? [`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value] : [];
  });

export async function realRunner(flags: DeployFlags, config: DeployConfig): Promise<DeployRunner> {
  const appDir = resolve(config.app);
  let target: Promise<MigrateTarget> | undefined;
  const migrateTarget = (): Promise<MigrateTarget> =>
    (target ??= (async () => {
      /* The database's narration is not a deploy's to print. */
      const log = console.log;
      console.log = () => {};
      try {
        const opts = parseArgs(flagsOf(config, ['config', 'appEntry', 'policy']));
        const registry = new Registry();
        const startup = await readStartupConfig(opts, registry, CONFIG_SECTIONS);
        const app = await MIGRATE_APPS.app(appDir, { opts, config: startup, command: 'up', flags: {} });
        const resolved = await resolveTarget(registry, startup, { schemas: opts.schemas }, appDir, app.binding);
        return {
          url: flags.migrateUrl ?? resolved.url,
          schemas: resolved.schemas,
          dir: flags.migrationsDir ? resolve(flags.migrationsDir) : resolved.dir,
          table: resolved.table,
        };
      } finally {
        console.log = log;
      }
    })());

  return {
    say: (line) => console.log(line),
    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    wrangler(args, options) {
      if (options.stream)
        return new Promise((done) => {
          const child = spawn('npx', ['wrangler', ...args], { cwd: options.cwd, stdio: ['inherit', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          /* Line by line to this process's own streams as they arrive; stdout is kept for the caller to read a version from. */
          child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
          createLineReader(child.stdout, (line) => process.stdout.write(`${line}\n`));
          createLineReader(child.stderr, (line) => process.stderr.write(`${line}\n`));
          child.on('exit', (code) => done({ code: code ?? 1, stdout, stderr }));
          child.on('error', (error) => done({ code: 1, stdout, stderr: error.message }));
        });
      if (!options.inherit) return run('npx', ['wrangler', ...args], options.cwd);
      return new Promise((done) => {
        const child = spawn('npx', ['wrangler', ...args], { cwd: options.cwd, stdio: 'inherit' });
        child.on('exit', (code) => done({ code: code ?? 1, stdout: '', stderr: '' }));
        child.on('error', (error) => done({ code: 1, stdout: '', stderr: error.message }));
      });
    },
    async http(url, init) {
      try {
        const answer = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(HTTP_MS) });
        const result: HttpAnswer = {
          status: answer.status,
          headers: Object.fromEntries(answer.headers),
          body: await answer.text(),
        };
        return result;
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
    hook: (command, env) =>
      new Promise((done) => {
        const child = spawn(command, { shell: true, stdio: 'inherit', env: { ...process.env, ...env } });
        child.on('exit', (code) => done(code ?? 1));
        child.on('error', () => done(1));
      }),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    newId: () => randomUUID(),
    env: (name) => process.env[name],
    async git() {
      const sha = await run('git', ['rev-parse', 'HEAD'], process.cwd());
      const dirty = await run('git', ['status', '--porcelain'], process.cwd());
      return { sha: sha.code === 0 ? sha.stdout.trim() : null, dirty: dirty.code === 0 && dirty.stdout.trim() !== '' };
    },
    operator: () => `${userInfo().username}@${hostname()}`,
    async check(): Promise<CheckResult> {
      const { runCheck } = await import('../build/check.js');
      let text = '';
      let connections: string[] = [];
      await runCheck(
        [
          '--app',
          appDir,
          '--deploy',
          '--json',
          ...(flags.migrationsDir ? ['--migrations', flags.migrationsDir] : []),
          ...(flags.connectionLimit !== undefined ? ['--connection-limit', String(flags.connectionLimit)] : []),
          ...flagsOf(config, ['config', 'appEntry', 'commands', 'jobs', 'policy']),
        ],
        (line) => {
          text += line;
        },
        (report) => {
          connections = (report.steps.find((step) => step.step === 'deploy')?.lines ?? [])
            .filter((line) => line.startsWith('connections '))
            .map((line) => line.slice('connections '.length));
        },
      );
      const report = JSON.parse(text) as { problems: Array<CheckFinding & { step: string }> };
      return {
        problems: report.problems.map(({ code, severity, message, fix }) => ({ code, severity, message, ...(fix ? { fix } : {}) })),
        connections,
      };
    },
    async build() {
      const request = {
        app: config.app,
        ...(config.appEntry ? { appEntry: config.appEntry } : {}),
        ...(config.out ? { out: config.out } : {}),
        ...(config.config ? { config: config.config } : {}),
        ...(config.commands ? { commands: config.commands } : {}),
        ...(config.jobs ? { jobs: config.jobs } : {}),
        ...(config.policy ? { policy: config.policy } : {}),
      };
      const { buildApp } = await import('../build/build.js');
      const { buildInputId } = await import('../build/fingerprint.js');
      const log = console.log;
      console.log = (...args: unknown[]) => console.error(...args);
      try {
        const built = await buildApp(request, {}, (line) => console.log(`  ${line}`));
        /* The image is made from the Dockerfile at the project root; one the project already has is its own. */
        if (!existsSync('Dockerfile')) await writeFile('Dockerfile', appDockerfile(request));
        return { out: built.out, buildId: await buildInputId(request) };
      } finally {
        console.log = log;
      }
    },
    migrations: {
      async pending() {
        const status = await migrationStatus(await migrateTarget());
        return {
          files: status.plan.pending.filter((file) => file.kind === 'versioned').map(({ script, sql }) => ({ script, sql })),
          problems: [...status.plan.problems],
        };
      },
      async up() {
        const done = await migrateUp(await migrateTarget());
        if (done.refused) throw new Error(done.refused);
        if (done.failure) throw new Error(`${done.failure.file.script}: ${done.failure.message}`);
        const { runMigrate } = await import('@mistriwork/engine/server/migrate/cli.js');
        let said = '';
        const code = await runMigrate(
          ['stores', 'up', '--app', appDir, ...flagsOf(config, ['config', 'appEntry', 'policy', 'jobs'])],
          (line) => {
            said += `${line}\n`;
          },
          CONFIG_SECTIONS,
          MIGRATE_APPS,
        );
        if (code !== 0) throw new Error(`migrate stores up exited ${code}: ${said.trim().split('\n').pop() ?? ''}`);
        return done.applied.map(({ file }) => file.script);
      },
    },
    async ledger() {
      const { url, schemas } = await migrateTarget();
      return openLedger(url, schemas);
    },
  };
}
