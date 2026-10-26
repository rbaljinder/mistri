/**
 * A signed-out visitor's read of a table outside `auth.public` (field report
 * CX9). The visitor's catalog holds only what `auth.public` names, so such a
 * read was answered as a question about a table that does not exist — 200,
 * "No table called …" — which hid the private table rightly and told the
 * visitor nothing they could do. It is a sign-in: 401 with the sign-in card,
 * the one answer for a private table and for a name that is no table at all,
 * so nothing says which exist.
 */
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

/* The first word of a query, a breakdown or a view's text: the table it starts from. */
const leading = (text: unknown): string | undefined => {
  if (typeof text !== 'string') return undefined;
  const word = text.trim().split(/\s+/)[0];
  return word || undefined;
};

/* The routes whose `q` or `text` is a question that starts from a table; elsewhere they are something else (a
   reference picker's search words), and only a named `table` is judged. A batch (`/api/counts`, `/api/breakdowns`)
   is not refused whole: a public list's tab badges ask beside a member's, and each item answers for itself. */
const QUESTIONS = new Set(['/api/run', '/api/query', '/api/count', '/api/view/run', '/api/breakdown']);

/* What a request names: a table, or a question that starts from one. */
function named(body: Record<string, unknown>, questions: boolean): (string | undefined)[] {
  const view = body.view && typeof body.view === 'object' ? (body.view as Record<string, unknown>) : undefined;
  return [
    typeof body.table === 'string' ? body.table : undefined,
    ...(questions ? [leading(body.q), leading(body.text), typeof view?.base === 'string' ? view.base : undefined] : []),
  ];
}

/** The tables a read request names, in any of the shapes the read routes take. */
function tablesAsked(path: string, body: Record<string, unknown>): string[] {
  return [...new Set(named(body, QUESTIONS.has(path)).filter((name): name is string => typeof name === 'string' && name.length > 0))];
}

/** Whether a request names a table the visitor's catalog does not hold. */
export function asksOutside(schema: DatabaseSchema, path: string, body: Record<string, unknown>): boolean {
  return tablesAsked(path, body).some((name) => !tableNamed(schema, name));
}
