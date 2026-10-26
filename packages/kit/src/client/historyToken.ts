export type HistoryToken = number | string;

/** Match tenantRecordHistory's tenantIdentifier(value, 128), not UUID syntax.
 * Validation recognizes a token's shape; only the server can authorize it. */
export function historyToken(value: unknown, tenant: boolean): HistoryToken | undefined {
  if (!tenant) return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value === value.trim() && !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}

/** One caller-owned connection/context. Never reuse it across owner changes. */
export type HistoryQuarantine = Readonly<{ tenant: false; ceiling: number } | { tenant: true; blocked: boolean }>;

export function createHistoryQuarantine(tenant: boolean): HistoryQuarantine {
  return tenant ? Object.freeze({ tenant: true, blocked: false }) : Object.freeze({ tenant: false, ceiling: 0 });
}

/** No lexical or numeric ordering exists for opaque tenant tokens. A lost Undo
 * therefore blocks the entire context, including subsequently previewed tokens.
 * An invalid ordinary token cannot establish a safe ceiling: fail closed. */
export function quarantineHistory(state: HistoryQuarantine, value: unknown): HistoryQuarantine {
  if (state.tenant === true) return Object.freeze({ tenant: true, blocked: true });
  const token = historyToken(value, false);
  return Object.freeze({ tenant: false, ceiling: Math.max(state.ceiling, typeof token === 'number' ? token : Number.MAX_SAFE_INTEGER) });
}

export function historyTokenAvailable(state: HistoryQuarantine, value: unknown): boolean {
  const token = historyToken(value, state.tenant);
  if (token === undefined) return false;
  return state.tenant === true ? !state.blocked : typeof token === 'number' && token > state.ceiling;
}
