/** The App API's generic writes (`expose(fields, { create, update, delete })`)
 * run as commands the platform defines, never the App's commands module. This
 * is their mark, and the one rule that grants them: a role runs a generic
 * write exactly where its signed-in editor could make the same change — the
 * resource writable to it, creatable for a create, deleted from by the App for
 * a delete. The handler then holds each write to that role's own field
 * ceilings, validation, transitions and stamps (apiGenericWrites.ts). */
import { appDeletable, resolveAppAccess, type AppDef } from '../../shared/app.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

type GenericWriteVerb = 'create' | 'update' | 'delete';
type GenericWrite = Readonly<{ verb: GenericWriteVerb; resource: string }>;

const marks = new WeakMap<object, GenericWrite>();

/** Trusted platform code only: mark a command this module's caller just defined. */
export function markGenericWrite(command: object, write: GenericWrite): void {
  if (marks.has(command)) throw new Error('A generic write is marked once.');
  marks.set(command, Object.freeze({ verb: write.verb, resource: write.resource }));
}

export const genericWriteOf = (command: unknown): GenericWrite | undefined =>
  command && typeof command === 'object' ? marks.get(command) : undefined;

/** Whether these roles' editor could make this change: the UI's own grant. */
export function genericWriteEntitled(app: AppDef, schema: DatabaseSchema, roles: readonly string[], write: GenericWrite): boolean {
  const access = resolveAppAccess(app, schema, [...roles]);
  if (!access.writable.has(write.resource)) return false;
  if (write.verb === 'create') return !access.creatable || access.creatable.has(write.resource);
  if (write.verb === 'delete') return appDeletable(app, schema).has(write.resource);
  return true;
}
