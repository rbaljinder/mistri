/**
 * Whether the environment asks for an OpenTelemetry export — answered
 * without loading the exporter, so a start that asks for none loads none.
 */
const SIGNALS = ['TRACES', 'LOGS', 'METRICS'] as const;

export function otlpRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return false;
  return (
    Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) ||
    SIGNALS.some(
      (signal) =>
        Boolean(env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]?.trim()) ||
        env[`OTEL_${signal}_EXPORTER`]?.split(',').some((name) => name.trim().toLowerCase() === 'otlp'),
    )
  );
}
