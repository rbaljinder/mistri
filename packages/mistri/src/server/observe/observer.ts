/**
 * The dev observer: what the running App did, kept for its author.
 *
 * In the manner of Laravel Telescope or Aspire's dashboard, and built on the
 * same spans OpenTelemetry exports (adapters/telemetry/trace.ts): this is one
 * more sink, the one allowed to see `detail` — the SQL with its parameters,
 * the bodies, a command's input and output, a refusal's recorded cause —
 * because it is loopback-only, dev-only and memory-only. It is loaded by a
 * `--dev` start and by nothing else (cli/serve.ts); a production start never
 * imports this file, and its address answers 404 (mount.ts).
 *
 * Logs are first class. Every console line — mistri's own and the App's
 * (a `console.log` in a command, a job, a policy) — is kept structured with
 * the span it was written in, so a trace shows the lines written inside each
 * of its spans and the all-logs view jumps back to the request. The terminal
 * keeps printing exactly what it printed.
 */
import { format } from 'node:util';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addSink, currentSpan, log, type LogLevel } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { instrumentDrivers } from '@mistriwork/engine/adapters/telemetry/drivers.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost } from '../app/apps.js';
import { Masker, type MaskRules } from './mask.js';
import { ObserverStore } from './store.js';
import { mountObserver, RESERVED } from './mount.js';
import { observerHttp } from './http.js';
import { observerDirectory } from './discovery.js';
import { embedIssuersOf, identityProvidersOf, scimDirectoriesOf } from '../serviceConnections.js';

export interface ObserverContext {
  registry: Registry;
  apps: () => readonly AppHost[];
}

export interface Observer {
  store: ObserverStore;
  context: ObserverContext;
  /** Say where it is, once the port is known; writes the discovery file `mistri observe` reads. */
  listening(url: string): void;
  stop(): void;
}

let active: Observer | undefined;

const CREDENTIAL_ENV = /SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|_KEY$/i;

/** What to mask, read from what this process was given: the connections' hidden rules and every secret it holds. */
function maskRules(context: ObserverContext): MaskRules {
  const hidden: Array<{ table: string; columns: readonly string[] }> = [];
  const secrets = new Set<string>();
  for (const config of context.registry.configs()) {
    for (const [table, columns] of Object.entries(config.hidden ?? {})) hidden.push({ table, columns });
    try {
      const url = new URL(config.url);
      if (url.password) {
        secrets.add(url.password);
        secrets.add(decodeURIComponent(url.password));
      }
    } catch {
      /* a file path */
    }
    collectSecrets(config.http, secrets);
  }
  for (const host of context.apps()) {
    for (const [table, resource] of Object.entries(host.app.app.resources ?? {})) {
      if (resource.hidden?.length) hidden.push({ table, columns: resource.hidden });
    }
    /* An input a command declares sensitive is masked wherever its name is a key — a form's body, a step's check, a
       command's input — so the observer never holds an SSN typed on the author's own machine either. */
    const sensitive = sensitiveInputNames(host.app.app);
    if (sensitive.length) hidden.push({ table: '*', columns: sensitive });
  }
  for (const [name, value] of Object.entries(process.env)) if (value && CREDENTIAL_ENV.test(name)) secrets.add(value);
  // An identity provider's client secret, whatever its variable is called.
  for (const provider of [
    ...identityProvidersOf(context.registry).map((idp) => (idp.kind === 'oidc' ? idp.clientSecret : undefined)),
    // A host's assertion secret (embed/issuerConfig.ts) too.
    ...embedIssuersOf(context.registry).map((host) => host.secret),
    // A SCIM directory's bearer tokens (auth/scimConfig.ts).
    ...scimDirectoriesOf(context.registry).flatMap((directory) => directory.tokens),
  ]) {
    const name = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(provider ?? '')?.[1];
    const value = name ? process.env[name] : undefined;
    if (value) secrets.add(value);
  }
  return { hidden, secrets };
}

function collectSecrets(value: unknown, into: Set<string>, key = '', depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (/secret|token|password|key|auth|credential/i.test(key) && !value.startsWith('${')) into.add(value);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [inner, item] of Object.entries(value)) collectSecrets(item, into, inner, depth + 1);
}

const LEVELS: Record<'log' | 'info' | 'warn' | 'error' | 'debug', LogLevel> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

/** Keep every console line — and every write straight to stderr — as a structured one too, correlated with the span it was written in. */
function captureConsole(): () => void {
  const originals = new Map<string, (...args: unknown[]) => void>();
  let inside = false;
  /* A console method writes its line to stderr (or stdout) itself: that
     write is the line already kept, not a second one. */
  let writing = false;
  /* A line that continues the one before it (`  because: …` under a refusal)
     is said by whoever said that one, when it follows at once. */
  let last = { source: 'console', at: 0 };
  for (const method of Object.keys(LEVELS) as Array<keyof typeof LEVELS>) {
    const original = console[method].bind(console);
    originals.set(method, console[method]);
    console[method] = (...args: unknown[]) => {
      writing = true;
      try {
        original(...args);
      } finally {
        writing = false;
      }
      // A sink that logs must not log itself.
      if (inside) return;
      inside = true;
      try {
        const message = format(...args);
        const now = Date.now();
        const source =
          /^\s/.test(message) && now - last.at < 50
            ? last.source
            : message.startsWith('mistri:')
              ? 'mistri'
              : /^(App (error|warning)|Policy|Server startup error|API startup error)/.test(message)
                ? 'app-load'
                : message.startsWith('[vite]')
                  ? 'vite'
                  : currentSpan()
                    ? 'app'
                    : 'console';
        last = { source, at: now };
        log(LEVELS[method], source, message, { local: true });
      } finally {
        inside = false;
      }
    };
  }
  /* What a library, a driver or an App writes to stderr directly — a
     warning, a stack — never passes through console, and was lost to the
     observer while the terminal showed it. */
  const stderr = process.stderr.write;
  process.stderr.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
    const written = (stderr as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
    if (!writing && !inside) {
      inside = true;
      try {
        const text = (
          typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk)
        ).trimEnd();
        if (text) log('warn', 'stderr', text, { local: true });
      } catch {
        /* a line kept is a courtesy */
      } finally {
        inside = false;
      }
    }
    return written;
  } as typeof process.stderr.write;
  return () => {
    for (const [method, original] of originals) (console as unknown as Record<string, unknown>)[method] = original;
    process.stderr.write = stderr;
  };
}

/* Every input name the App's served command fields declare sensitive, found wherever a form or an action carries them. */
function sensitiveInputNames(app: unknown): string[] {
  const names = new Set<string>();
  const seen = new Set<object>();
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 24 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const field = value as { name?: unknown; type?: unknown; sensitive?: unknown };
    if (typeof field.name === 'string' && field.type === 'text' && field.sensitive && typeof field.sensitive === 'object')
      names.add(field.name);
    for (const inner of Object.values(value)) walk(inner, depth + 1);
  };
  walk(app, 0);
  return [...names];
}

export function startObserver(context: ObserverContext, options: { slowMs?: number } = {}): Observer {
  if (active) return active;
  const masker = new Masker(maskRules(context));
  const store = new ObserverStore(masker, options);
  instrumentDrivers();
  // The rules move with the App: a save can hide a column. Re-read them now and then, never per span.
  const refresh = setInterval(() => {
    try {
      masker.update(maskRules(context));
    } catch {
      /* keep the last rules */
    }
  }, 2000);
  refresh.unref();
  const removeSink = addSink({
    local: true,
    onEnd(span) {
      store.addSpan(span);
    },
    onLog(record) {
      store.addLog(record);
    },
  });
  const releaseConsole = captureConsole();
  let discovery: string | undefined;
  const forget = () => {
    if (discovery) {
      try {
        rmSync(discovery, { force: true });
      } catch {
        /* gone */
      }
    }
  };
  process.once('exit', forget);
  const observer: Observer = {
    store,
    context,
    listening(url) {
      const address = `${url.replace(/\/+$/, '')}${RESERVED}/`;
      console.log(`mistri: dev observer at ${address}`);
      try {
        const dir = observerDirectory();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        discovery = join(dir, `${process.pid}.json`);
        writeFileSync(discovery, JSON.stringify({ pid: process.pid, url: address, base: url, started: new Date().toISOString() }), {
          mode: 0o600,
        });
      } catch {
        discovery = undefined;
      }
    },
    stop() {
      clearInterval(refresh);
      removeSink();
      releaseConsole();
      mountObserver(undefined);
      forget();
      process.off('exit', forget);
      active = undefined;
    },
  };
  mountObserver(observerHttp(observer));
  active = observer;
  return observer;
}
