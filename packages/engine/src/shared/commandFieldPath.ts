/*
 * The one spelling of a refusal's field path. It sits below the command
 * runtime because the canonical JSON walk (adapters/commands/canonicalJson.ts),
 * which the stores share, names a refused member by it too.
 */

/** A refusal's field path: `name`, `group.name` or `rows[1].name`, as deep as groups nest. */
export const COMMAND_FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,127}(?:\[\d{1,3}\])?(?:\.[A-Za-z_][A-Za-z0-9_]{0,127}(?:\[\d{1,3}\])?){0,2}$/;
