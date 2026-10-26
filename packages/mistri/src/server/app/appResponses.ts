/** App payloads carry rendering and mutation state, not compiler output. */
const readFields = [
  'table',
  'view',
  'text',
  'breakdown',
  'section',
  'columns',
  'rows',
  'total',
  'exactTotal',
  'cappedTotal',
  'limit',
  'offset',
  'order',
  'more',
  'bounds',
  'keyset',
  'ms',
  'errors',
  // A breakdown's groups by the name of the record each is (breakdown.ts, withGroupNames).
  'names',
] as const;

const writeFields = ['affected', 'applied', 'key', 'row', 'undoId', 'impact', 'deleted', 'errors', 'outcome'] as const;

const columnFields = [
  'path',
  'name',
  'table',
  'column',
  'type',
  'nullable',
  'primaryKey',
  'hops',
  'aggregate',
  'kind',
  'fn',
  'bucket',
] as const;

function pick(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]));
}

export function appDataResponse(
  body: Record<string, unknown>,
  appConfigured: boolean,
  kind: 'read' | 'write' = 'read',
): Record<string, unknown> {
  if (!appConfigured) return body;
  const response = pick(body, kind === 'read' ? readFields : writeFields);
  if (kind === 'read' && Array.isArray(body.resolved)) {
    response.resolved = body.resolved.map((column) => pick(column, columnFields));
  }
  if (kind === 'read' && Array.isArray(body.joins)) response.joinCount = body.joins.length;
  return response;
}

/** Explicit diagnostic tools remain available on the standalone DB browser. */
export function appDiagnosticEndpoint(path: string): boolean {
  return ['/api/sql', '/api/queries', '/api/view/compile', '/api/ddl', '/api/agent/tools', '/api/agent/call'].includes(path);
}
