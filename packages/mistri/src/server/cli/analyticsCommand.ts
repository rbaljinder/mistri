/** Explicit operator commands for the behavior-analytics store. Serving only opens it. */
import type { AnalyticsConfiguration } from '../analytics/config.js';
import type { AnalyticsFunnel } from '../../shared/appAnalytics.js';

const usage = `mistri analytics provision (--suite <suite.json> | --config <file> --app-id <id>)
mistri analytics funnel <id> --from <date> --to <date> [--tenant <id>] [--json]
                           (--suite <suite.json> | --config <file> --app-id <id> --app <dir>)`;

interface Parsed {
  command: 'provision' | 'funnel';
  funnel?: string;
  suite?: string;
  config?: string;
  appId?: string;
  appDir?: string;
  from?: string;
  to?: string;
  tenant?: string;
  json: boolean;
}

function parse(args: readonly string[]): Parsed {
  const [command, ...rest] = args;
  if (command !== 'provision' && command !== 'funnel') throw new Error(`Expected ${usage}`);
  const out: Parsed = { command, json: false };
  const takes: Record<string, keyof Parsed> = {
    '--suite': 'suite',
    '--config': 'config',
    '--app-id': 'appId',
    '--app': 'appDir',
    '--from': 'from',
    '--to': 'to',
    '--tenant': 'tenant',
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') out.json = true;
    else if (takes[arg]) {
      const value = rest[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} needs a value.`);
      (out as unknown as Record<string, unknown>)[takes[arg]] = value;
    } else if (command === 'funnel' && !out.funnel && !arg.startsWith('-')) out.funnel = arg;
    else throw new Error(`Unexpected ${arg}. Expected ${usage}`);
  }
  if (!out.suite === !out.config) throw new Error('Name exactly one of --suite or --config.');
  if (out.config && !out.appId) throw new Error('--config needs --app-id: the App the store belongs to.');
  if (command === 'funnel' && (!out.funnel || !out.from || !out.to)) throw new Error(`Expected ${usage}`);
  if (command === 'funnel' && out.config && !out.appDir) throw new Error('--config needs --app <dir> to read the funnel from.');
  return out;
}

const when = (text: string, label: string): number => {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`${label} is a date (2026-10-01) or a UTC time (2026-10-01T09:00:00Z).`);
  return ms;
};

export async function runAnalyticsCommand(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      `${usage}\nProvision the append-only analytics store (with the server stopped), or count a funnel the App declares over [from, to), in UTC. An older store is brought forward by mistri migrate stores up.`,
    );
    return;
  }
  const given = parse(args);
  let analytics: AnalyticsConfiguration | undefined, appId: string, appDir: string | undefined;
  if (given.suite) {
    const { readSuiteConfiguration } = await import('./suiteConfig.js');
    const suite = await readSuiteConfiguration(given.suite, environment);
    analytics = suite.analytics;
    const app = suite.apps.find((each) => each.id === (analytics?.app ?? suite.apps[0].id));
    if (!app) throw new Error('The suite names no such App.');
    appId = app.id;
    appDir = app.directory;
  } else {
    const { loadConfig } = await import('@mistriwork/engine/server/connections.js');
    const { CONFIG_SECTIONS } = await import('../serviceConnections.js');
    analytics = (await loadConfig(given.config, CONFIG_SECTIONS))?.analytics;
    appId = analytics?.app ?? given.appId!;
    appDir = given.appDir;
  }
  if (!analytics) throw new Error('The configuration has no "analytics": { "store": … }.');
  if (given.appId && appId !== given.appId) throw new Error(`--app-id ${given.appId} is not the App the analytics block names (${appId}).`);
  const binding = { appId, deploymentId: analytics.deploymentId };
  if (given.command === 'provision') {
    const { provisionAnalyticsStore } = await import('../analytics/store.js');
    await provisionAnalyticsStore({ url: analytics.store, binding });
    console.log('Analytics store provisioned.');
    return;
  }
  const { loadApp } = await import('../app/apps.js');
  const declared = (await loadApp(appDir!)).app.analytics?.funnels;
  const funnel: AnalyticsFunnel | undefined = declared && Object.hasOwn(declared, given.funnel!) ? declared[given.funnel!] : undefined;
  if (!funnel)
    throw new Error(`The App declares no funnel "${given.funnel}". It declares: ${Object.keys(declared ?? {}).join(', ') || 'none'}.`);
  const { inspectFunnel } = await import('../maintenance.js');
  const result = await inspectFunnel({ url: analytics.store, binding }, funnel, {
    from: when(given.from!, '--from'),
    to: when(given.to!, '--to'),
    ...(given.tenant ? { tenantId: given.tenant } : {}),
  });
  if (given.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(
    `${given.funnel}: ${result.unit}s, ${result.conversionWindowHours}h window, ${new Date(result.fromMs).toISOString()} to ${new Date(result.toMs).toISOString()}${result.tenantId ? `, tenant ${result.tenantId}` : ''}`,
  );
  for (const step of result.steps)
    console.log(
      `  ${step.step}. ${step.label.padEnd(32)} ${String(step.units).padStart(8)}  ${pct(step.fromPrevious).padStart(7)} of previous  ${pct(step.fromStart).padStart(7)} of first`,
    );
}
