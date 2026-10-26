/**
 * What a command keeps, decided by the door its request came through and
 * what the App and the command declare (`track`). See effectiveTrack.
 */

/**
 * Where a command request came from:
 * - `ui`: the browser running an action on a record (/api/commands/execute).
 *   The page guards against a double submit and an unconfirmed answer is
 *   checked on the record, so nothing is kept unless declared.
 * - `ui-idempotent`: the same with an Idempotency-Key header, which asks for
 *   a receipt; and a signed-in form's submission, which a reload sends again.
 * - `api`, `mcp`, `job`, `workflow`: callers that retry after a lost answer,
 *   where only a durable receipt makes the retry exactly-once. Always at least
 *   receipts.
 * A request that names no door — a public form, an import, a tenant's realm
 * — keeps what commands always kept: a receipt found before the handler
 * runs, and a full audit. It still tells its handler which door it is
 * (`entry`, businessCommandExecution.ts).
 */
export type CommandDoor = 'ui' | 'ui-idempotent' | 'api' | 'mcp' | 'job' | 'workflow';

/**
 * The door a handler is told it was reached through (`door` on its context):
 * the screen (an action, a form, an import, a public form), the App API (and
 * a webhook or inbound endpoint's mapped request), App MCP, a job (at its
 * time, or an inbound email) or a workflow's step. The server says it, never
 * the request.
 */
export type CommandHandlerDoor = 'ui' | 'api' | 'mcp' | 'job' | 'workflow';

/** The handler's door for a keeping door: a request with an Idempotency-Key is still the screen. */
export const handlerDoorOf = (door: CommandDoor): CommandHandlerDoor => (door === 'ui-idempotent' ? 'ui' : door);

const TRACKS = ['none', 'receipts', 'audit'] as const;
export type CommandTrack = (typeof TRACKS)[number];

/** What a command persists through this door: the declared track (the
 * command's, else the App's, else none), never below what the door needs. */
export function effectiveTrack(declared: CommandTrack | undefined, door: CommandDoor): CommandTrack {
  const floor: CommandTrack = door === 'ui' ? 'none' : 'receipts';
  return TRACKS[Math.max(TRACKS.indexOf(declared ?? 'none'), TRACKS.indexOf(floor))];
}
