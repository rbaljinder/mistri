/**
 * Switch telemetry on, when the environment asks — and load nothing when it
 * does not. The exporter, its encoders and the driver wrappers are each a
 * dynamic import behind `otlpRequested`, so a start without OTEL_* set has
 * loaded trace.ts (a boolean and an AsyncLocalStorage) and no more.
 */
import { otlpRequested } from './otlpEnv.js';

interface Telemetry {
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  /** Register gauges read at each export (metrics.ts observeGauges); absent when nothing exports. */
  gauges?: (read: Parameters<typeof import('./metrics.js').observeGauges>[0]) => () => void;
}

const NONE: Telemetry = { flush: async () => {}, shutdown: async () => {} };

export async function startTelemetry(
  env: Readonly<Record<string, string | undefined>>,
  version: string,
  say: (line: string) => void = (line) => console.error(line),
  /** Which binary is exporting (`service.name`, and the prefix of what it says). */
  service: 'tablewalk' | 'mistri' = 'mistri',
): Promise<Telemetry> {
  if (!otlpRequested(env)) return NONE;
  const [{ startOtlp }, { instrumentDrivers }, { observeGauges }] = await Promise.all([
    import('./otlp.js'),
    import('./drivers.js'),
    import('./metrics.js'),
  ]);
  const exporter = startOtlp(env, version, service);
  instrumentDrivers();
  for (const warning of exporter.warnings) say(`${service}: ${warning}`);
  say(`${service}: OpenTelemetry on — ${exporter.signals.join(', ') || 'nothing'} exported over OTLP/HTTP`);
  return Object.assign(exporter, { gauges: observeGauges });
}
