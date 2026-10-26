/**
 * The business-command routes, in one place: the server dispatches on them
 * (server/commands/businessCommandHttp.ts) and `@mistriwork/mistri/testing` sends to
 * them, so a test's request reaches the route a browser's does.
 */
export const COMMAND_ROUTES = {
  prepare: '/api/commands/prepare',
  execute: '/api/commands/execute',
  status: '/api/commands/status',
  availability: '/api/commands/availability',
  /** A signed-in form's step checked: the answers so far judged, nothing run (server/commands/commandCheck.ts). */
  check: '/api/commands/check',
} as const;

export const COMMAND_ROUTE_PATHS: readonly string[] = Object.values(COMMAND_ROUTES);
