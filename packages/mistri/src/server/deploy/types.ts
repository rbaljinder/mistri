/**
 * What `mistri deploy` does to the world, as one interface.
 *
 * Every effect of a deploy (wrangler, the network, a hook command, the clock, git, the database, a build) goes
 * through a DeployRunner. The flow in plan.ts and run.ts never touches the machine itself, so the whole of it is
 * tested with a fake runner that calls nothing (test/deploy-flow.test.ts); effects.ts is the one real one.
 */

export interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

/** A redirect is an answer, not followed: its `location` header (lower-cased names) is for the caller to judge. */
export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** One row of the deploy record (ledger.ts): a deploy, or a rollback of one. */
export interface DeployRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  operator: string;
  gitSha: string | null;
  buildId: string;
  workerVersion: string | null;
  /** The migration files this deploy applied. */
  migrations: string[];
  /** Whether one of them was marked `-- mistri: contract`: forward only, so nothing before it can be rolled back to. */
  contract: boolean;
  result: 'running' | 'ok' | 'failed';
  rollbackOf: string | null;
  note: string | null;
}

export interface DeployLedger {
  /** Creates the table if it is absent. Only a command that writes calls it: a read (`status`) must not create anything. */
  ensure(): Promise<void>;
  start(row: DeployRow): Promise<void>;
  finish(
    id: string,
    patch: Partial<Pick<DeployRow, 'finishedAt' | 'result' | 'buildId' | 'workerVersion' | 'migrations' | 'contract' | 'note'>>,
  ): Promise<void>;
  /** Newest first; none at all when the table does not exist yet. */
  recent(limit: number): Promise<DeployRow[]>;
  close(): Promise<void>;
}

export interface PendingMigration {
  script: string;
  sql: string;
}

/** What `check --deploy` found, and its connection math (one `db: N processes x M connections = T (limit L)` per database). */
export interface CheckResult {
  problems: CheckFinding[];
  connections: string[];
}

export interface CheckFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  fix?: string;
}

interface BuiltApp {
  /** What `/readyz` will report as `build` once this image runs. */
  buildId: string;
  out: string;
}

export interface DeployRunner {
  say(line: string): void;
  confirm(question: string): Promise<boolean>;
  /**
   * `npx wrangler <args>` in `cwd`. `inherit` streams its output and captures none; `stream` passes it through line by
   * line (a long image build is minutes of silence otherwise) and still captures stdout, which the caller parses.
   */
  wrangler(args: string[], options: { cwd: string; inherit?: boolean; stream?: boolean }): Promise<Exec>;
  /** One HTTP request, redirects NOT followed (a 3xx is returned with its `location`); a network failure is `{ error }`, never a throw. */
  http(url: string, init?: { method?: string; headers?: Record<string, string> }): Promise<HttpAnswer | { error: string }>;
  /** A hook command (`--backup-check`, `--smoke`) through the shell, with `env` added; its exit code. */
  hook(command: string, env: Record<string, string>): Promise<number>;
  sleep(ms: number): Promise<void>;
  now(): number;
  newId(): string;
  env(name: string): string | undefined;
  /** The HEAD commit and whether the working tree has changes. */
  git(): Promise<{ sha: string | null; dirty: boolean }>;
  operator(): string;
  /** `mistri check --deploy` over the App: its problems and its connection math. */
  check(): Promise<CheckResult>;
  /** Writes the build (`mistri build`) and the Dockerfile the image is made from, when absent. */
  build(): Promise<BuiltApp>;
  migrations: {
    /**
     * The versioned migrations not yet applied to the target, and the problems the history has (a recorded file missing
     * from the directory, a changed checksum): what is pending cannot be trusted while there are any. Throws when the
     * target cannot be read.
     */
    pending(): Promise<{ files: PendingMigration[]; problems: string[] }>;
    /** Applies them and the App's stores; the files applied. Throws, naming the file, when one fails. */
    up(): Promise<string[]>;
  };
  /** The deploy record, in the migration target's database. */
  ledger(): Promise<DeployLedger>;
}

/** `deploy/cloudflare/mistri-deploy.json`: the build request and the names a deploy needs, written by `init`. */
export interface DeployConfig {
  app: string;
  appEntry?: string;
  out?: string;
  config?: string;
  commands?: string;
  jobs?: string;
  policy?: string;
  /** Secret names the Worker must hold (`wrangler secret list`); compared by name, never by value. */
  secrets: string[];
  /** Secret names the Worker hands on when it holds them (the platform's keys for features an App may not use). */
  optionalSecrets?: string[];
  backupCheck?: string;
  smoke?: string;
}

export interface DeployFlags {
  dir: string;
  dryRun: boolean;
  yes: boolean;
  allowContract: boolean;
  allowDirty: boolean;
  migrateUrl?: string;
  /** The migrations directory, over the configuration's `migrations.dir`. */
  migrationsDir?: string;
  /** What the database allows this role, for the plan's connection math. */
  connectionLimit?: number;
  /** Print every warning, not the first few. */
  verbose: boolean;
  /** `deploy verify`: restart the container until it reports the fingerprint, as a deploy does. */
  roll: boolean;
  backupCheck?: string;
  smoke?: string;
  rollTimeoutMs: number;
  restartTokenEnv: string;
}

export const DEFAULT_ROLL_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_RESTART_TOKEN_ENV = 'MISTRI_RESTART_TOKEN';
/** The request header the Worker's container class reads a restart token from (packages/cloudflare). */
export const RESTART_HEADER = 'x-mistri-restart';
