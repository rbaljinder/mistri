/**
 * A refusal of `mistri api-token` that names the failed precondition and nothing else: never the token, a connection
 * string or the underlying driver message, which may carry them. It is the one error the command prints the text of
 * (apiTokenCommand.ts); every other failure stays the generic line, since a commit may have succeeded before it.
 */
export class MaintenanceRefusal extends Error {}
