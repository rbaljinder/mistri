/**
 * "Role X cannot read column Y here, because…": the App's grants resolved
 * for one role against its catalog, and said as the rule that decided.
 *
 * The same resolution every request uses (shared/appAccess.ts
 * resolveAppAccess), so the answer is the server's, not a second reading of
 * the declaration. The "because" quotes where the rule was written: the
 * resource's `access` ceiling, the role's grant, a `fields` narrowing, a
 * `hidden` cut, a command list.
 */
import { resolveAppAccess } from '../../shared/appAccess.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import type { ObserverContext } from './observer.js';

interface AccessQuestion {
  app?: string;
  role?: string;
  table?: string;
  column?: string;
  command?: string;
}

export async function explainAccess(context: ObserverContext, question: AccessQuestion): Promise<Record<string, unknown>> {
  const hosts = context.apps();
  const host = question.app ? hosts.find((each) => each.app.app.id === question.app) : hosts.length === 1 ? hosts[0] : undefined;
  if (!host) return { error: hosts.length ? `Name the App: ${hosts.map((each) => each.app.app.id).join(', ')}.` : 'No App is served.' };
  const app = host.app.app;
  const roles = Object.keys(app.auth?.roles ?? {});
  if (!question.role) return { app: app.id, roles, hint: 'Ask about a role, with a table, a column or a command.' };
  const grant = app.auth?.roles?.[question.role];
  if (!grant && question.role !== 'public')
    return {
      app: app.id,
      role: question.role,
      allowed: false,
      because: `The App declares no role "${question.role}". Its roles: ${roles.join(', ') || 'none'}.`,
    };
  const connection = appEntrypoint(host, context.registry);
  if (!connection) return { error: 'The App has no single connection to read its catalog from.' };
  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(context.registry, app, connection, (owner) =>
      releases.push(context.registry.lease(owner)),
    );
    const access = resolveAppAccess(
      app,
      resources.schema,
      question.role === 'public' ? [] : [question.role],
      question.role === 'public' ? 'public' : undefined,
    );
    const declared = { role: question.role, grant: grant ?? app.auth?.public ?? null };
    if (question.command) {
      const allowed = grant?.commands?.includes(question.command) === true;
      return {
        app: app.id,
        role: question.role,
        command: question.command,
        allowed,
        because: allowed
          ? `auth.roles.${question.role}.commands lists "${question.command}".`
          : grant?.commands
            ? `auth.roles.${question.role}.commands is [${grant.commands.map((id) => `"${id}"`).join(', ')}], without "${question.command}".`
            : `auth.roles.${question.role} has no "commands": a role runs only the commands it lists.`,
        declared,
      };
    }
    const table = question.table
      ? resources.schema.tables.find((each) => each.id === question.table || each.name === question.table)
      : undefined;
    if (question.table && !table)
      return {
        app: app.id,
        role: question.role,
        table: question.table,
        allowed: false,
        because: `"${question.table}" is not a table of the App's catalog.`,
      };
    if (!table) {
      return { app: app.id, role: question.role, readable: [...access.readable].sort(), writable: [...access.writable].sort(), declared };
    }
    const resource = app.resources?.[table.id] ?? app.resources?.[table.name];
    const ceiling = resource
      ? `resources.${table.id}.access is "${resource.access ?? 'read'}"`
      : `the App declares no resource "${table.id}"`;
    const readable = access.readable.has(table.id);
    const writable = access.writable.has(table.id);
    const roleRule = (kind: 'read' | 'write') => {
      const value = grant?.[kind];
      return value === true
        ? `auth.roles.${question.role}.${kind} is true (the App's ceiling)`
        : Array.isArray(value)
          ? `auth.roles.${question.role}.${kind} is [${value.map((name) => `"${name}"`).join(', ')}]`
          : `auth.roles.${question.role} grants no ${kind}`;
    };
    if (!question.column) {
      return {
        app: app.id,
        role: question.role,
        table: table.id,
        read: readable,
        write: writable,
        because: `${ceiling}; ${roleRule('read')}; ${roleRule('write')}.`,
        declared,
      };
    }
    const column = table.columns.find((each) => each.name === question.column);
    if (!column)
      return {
        app: app.id,
        role: question.role,
        table: table.id,
        column: question.column,
        allowed: false,
        because: `${table.id} has no column "${question.column}".`,
      };
    const fields = access.fields?.get(table.id);
    const readsColumn = readable && (!fields || fields.read.has(column.name));
    const writesColumn = writable && (!fields || fields.write.has(column.name));
    const hidden = resource?.hidden?.includes(column.name) === true;
    const narrowed = grant?.fields?.[table.id];
    const because = !readable
      ? `${ceiling}; ${roleRule('read')}, so no column of ${table.id} is read.`
      : hidden
        ? `resources.${table.id}.hidden names "${column.name}": no role reads a hidden column.`
        : narrowed && !readsColumn
          ? `auth.roles.${question.role}.fields.${table.id}.read is [${(narrowed.read ?? []).map((name) => `"${name}"`).join(', ')}], without "${column.name}".`
          : !writesColumn && writable && narrowed
            ? `auth.roles.${question.role}.fields.${table.id}.write does not list "${column.name}".`
            : `${ceiling}; ${roleRule('read')}; ${roleRule('write')}.`;
    return {
      app: app.id,
      role: question.role,
      table: table.id,
      column: column.name,
      read: readsColumn,
      write: writesColumn,
      hidden,
      because,
      declared,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const release of releases.reverse()) release();
  }
}
