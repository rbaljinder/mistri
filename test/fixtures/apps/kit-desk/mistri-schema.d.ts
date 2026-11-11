/* The shape `tablewalk --export types` would print for this fixture, kept
   beside seed.mjs, which is the schema: change one and change the other. */
import type { TypedAppConfig } from '@mistriwork/mistri/app';

/** Every table, and every column it had when this file was written. */
export type Tables = {
  owner: "id" | "name";
  task: "id" | "title" | "owner_id" | "due" | "status";
};

/** The app config with this schema’s own names: `satisfies App` on the default export. */
export type App = TypedAppConfig<Tables>;
