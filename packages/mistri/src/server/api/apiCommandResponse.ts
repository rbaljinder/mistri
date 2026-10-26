/** Private App API command wire shapes: problem details for refusals and the
 * design's receipt envelopes for results. Pure projections of the executor's
 * own answers — never a second classification, and never a shape a caller
 * supplies. */
import { BusinessCommandExecutionError, type RefusalCode } from '../commands/commandErrors.js';
import { ROW_LOCKED_RETRY_AFTER_SECONDS } from '@mistriwork/engine/adapters/writeLanes.js';

/* The statuses a bearer caller can hear after the owner has the request: the
   design's problem-details table. Codes a token never meets (a signed-in tab,
   a socket that hung up) are absent and stay thrown as unknown. */
export const REFUSAL_STATUS: Readonly<Partial<Record<RefusalCode, 403 | 404 | 409 | 410 | 422 | 500 | 503>>> = Object.freeze({
  forbidden: 403,
  not_found: 404,
  command_version_mismatch: 410,
  invalid_input: 422,
  consumes_refused: 422,
  stale_record: 409,
  duplicate_record: 409,
  ineligible_state: 409,
  idempotency_conflict: 409,
  invalid_result: 500,
  temporarily_unavailable: 503,
  row_locked: 503,
});

/** A refusal's headers: a lock wait that ran out says when to come back. */
export function refusalHeaders(code: RefusalCode): Readonly<Record<string, string>> | undefined {
  return code === 'row_locked' ? Object.freeze({ 'retry-after': String(ROW_LOCKED_RETRY_AFTER_SECONDS) }) : undefined;
}

/** Re-issued here, so the title is always the platform's fixed message and
 * `field`/`key` pass the class's own shape checks, whatever was thrown. */
export function commandProblem(
  code: RefusalCode,
  outcome: 'not_applied' | 'unknown',
  field?: string,
  key?: Readonly<Record<string, string | number>>,
) {
  const issued = new BusinessCommandExecutionError(code, outcome, field, key);
  return {
    type: `urn:mistri:problem:${code}`,
    title: issued.message,
    status: REFUSAL_STATUS[code]!,
    code,
    outcome,
    ...(issued.field ? { field: issued.field } : {}),
    ...(issued.key ? { key: issued.key } : {}),
  };
}

const TRANSPORT = Object.freeze({
  invalid_request: [400, 'The API request is invalid.'],
  idempotency_key_required: [400, 'This command needs an Idempotency-Key header.'],
  unauthenticated: [401, 'A valid API credential is required.'],
  forbidden: [403, 'The API request could not be completed.'],
  not_found: [404, 'The API request could not be completed.'],
  method_not_allowed: [405, 'The API request could not be completed.'],
  precondition_required: [428, "This command needs an If-Match header with the record's version."],
  rate_limited: [429, 'Too many API requests. Retry later.'],
  temporarily_unavailable: [503, 'The API request could not be completed. Retry with the same request key.'],
} as const);

/** Every status a command route can answer with a problem body, for the API document. */
export function apiCommandProblemStatuses(): number[] {
  const statuses = [...Object.values(REFUSAL_STATUS), ...Object.values(TRANSPORT).map(([status]) => status)] as number[];
  return [...new Set(statuses)].sort((left, right) => left - right);
}

/** Answered before the owner has the request, so it carries no outcome: a
 * refusal here says nothing about an earlier request under the same key. */
export function apiTransportProblem(code: keyof typeof TRANSPORT) {
  const [status, title] = TRANSPORT[code];
  return Object.freeze({ status, value: Object.freeze({ type: `urn:mistri:problem:${code}`, title, status, code }) });
}

const refuse = (): never => {
  throw new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
};
const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

/** `{receipt:{id,status,replayed}, result}` for execution (with
 * Idempotent-Replayed on a replay); the normalized
 * `{receipt:{id,status,recovered:true}, targets, result}` for recovery; an
 * absent receipt is 404 with outcome unknown. Anything else refuses. */
export function projectApiCommandAnswer(
  mode: 'execute' | 'recover',
  raw: unknown,
  targetKey?: (key: unknown) => unknown,
): Readonly<{ status: 200 | 404; headers: Readonly<Record<string, string>>; value: unknown }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse();
  const data = raw as Record<string, unknown>;
  if (mode === 'recover' && data.status === 'not_found') {
    if (data.outcome !== 'unknown') return refuse();
    return Object.freeze({ status: 404, headers: NO_HEADERS, value: commandProblem('not_found', 'unknown') });
  }
  if (data.status !== 'applied' || typeof data.receiptId !== 'string' || !data.receiptId || !Object.hasOwn(data, 'result')) return refuse();
  if (mode === 'recover') {
    if (data.recovered !== true || !Array.isArray(data.targets) || !data.targets.length) return refuse();
    return Object.freeze({
      status: 200,
      headers: NO_HEADERS,
      value: {
        receipt: { id: data.receiptId, status: 'applied', recovered: true },
        targets: targetKey ? data.targets.map((key) => targetKey(key)) : data.targets,
        result: data.result,
      },
    });
  }
  if (typeof data.replayed !== 'boolean') return refuse();
  return Object.freeze({
    status: 200,
    headers: data.replayed ? Object.freeze({ 'idempotent-replayed': 'true' }) : NO_HEADERS,
    value: { receipt: { id: data.receiptId, status: 'applied', replayed: data.replayed }, result: data.result },
  });
}
