/**
 * A refused command's fixed words, by code: what the server says when the
 * platform refuses, or a handler refuses by code alone. Shared so a form can
 * tell the platform's fixed sentence — written for an integrator reading the
 * API — from a handler's own reason, written for the person, and say the
 * former in a visitor's words instead (FormSurface.tsx, `formRefusal`).
 */
export const COMMAND_REFUSAL_MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  stale_account: 'The signed-in account changed. Reload before continuing.',
  invalid_input: 'The command input is invalid.',
  command_version_mismatch: 'This command version is unavailable. Keep the original request for reconciliation.',
  not_found: 'The record was not found.',
  ineligible_state: 'This record is not eligible for this command.',
  consumes_refused: 'There is not enough left of what this would use.',
  reviewer_unavailable: 'The selected reviewer is unavailable.',
  forbidden: 'This command is not available to this account.',
  idempotency_conflict: 'This request key was already used with different input.',
  duplicate_record: 'A record with this value already exists.',
  stale_record: 'The record has changed. Reload it before trying again.',
  cancelled: 'The command was cancelled.',
  temporarily_unavailable: 'The command could not be completed. Retry with the same request key.',
  row_locked: 'The record is locked by another transaction. Nothing was changed; retry in a moment.',
  invalid_result: 'The command did not produce a valid result.',
} as const;

export type CommandRefusalCode = keyof typeof COMMAND_REFUSAL_MESSAGES;
