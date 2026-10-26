/**
 * `--tool flyway`: the same commands run by an installed Flyway instead of
 * tablewalk's runner, for a team that wants the real thing. The files and the
 * history table are the same ones either way (the layout is Flyway's and the
 * table is named to Flyway with `FLYWAY_TABLE`), so a team can switch tools
 * in either direction between two deploys.
 *
 * Everything reaches Flyway through its environment variables, never its
 * command line: a password on argv is readable by every user of the machine
 * in the process list. What only tablewalk can do still happens around it —
 * the schema recorded after `up` for drift, and the App checked.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { sqlitePath, type Dialect } from './database.js';
import type { MigrateTarget } from './runner.js';
import { envName, product, productEnv } from '../product.js';

export const FLYWAY_COMMANDS: Readonly<Record<string, string>> = {
  up: 'migrate',
  status: 'info',
  validate: 'validate',
  baseline: 'baseline',
  repair: 'repair',
};

/** A connection URL as Flyway's JDBC settings. */
export function flywaySettings(url: string, dialect: Dialect): Record<string, string> {
  if (dialect === 'sqlite') return { FLYWAY_URL: `jdbc:sqlite:${resolve(sqlitePath(url))}` };
  const parsed = new URL(url);
  const scheme = dialect === 'postgres' ? 'postgresql' : parsed.protocol === 'mariadb:' ? 'mariadb' : 'mysql';
  return {
    FLYWAY_URL: `jdbc:${scheme}://${parsed.host}${parsed.pathname}${parsed.search}`,
    ...(parsed.username ? { FLYWAY_USER: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { FLYWAY_PASSWORD: decodeURIComponent(parsed.password) } : {}),
  };
}

/** Run `flyway <command>` with the target's settings; its output passes through. Resolves to its exit code. */
export function runFlyway(command: string, target: MigrateTarget, dialect: Dialect, write: (line: string) => void): Promise<number> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...flywaySettings(target.url, dialect),
    FLYWAY_LOCATIONS: `filesystem:${target.dir}`,
    FLYWAY_TABLE: target.table,
    FLYWAY_BASELINE_VERSION: '0',
    ...(target.schemas.length ? { FLYWAY_SCHEMAS: target.schemas.join(',') } : {}),
  };
  return new Promise((done) => {
    const child = spawn(productEnv('FLYWAY') ?? 'flyway', [FLYWAY_COMMANDS[command]], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    const forward = (chunk: Buffer) => {
      pending += String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) write(`  flyway: ${line}`);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.once('error', (error) => {
      write(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Flyway is not installed where this can find it: put flyway on the PATH (or set ${envName('FLYWAY')} to its path), or drop --tool flyway to use ${product()}'s own runner.`
          : `Flyway could not be started: ${error.message}`,
      );
      done(127);
    });
    child.once('close', (code) => {
      if (pending) write(`  flyway: ${pending}`);
      done(code ?? 1);
    });
  });
}
