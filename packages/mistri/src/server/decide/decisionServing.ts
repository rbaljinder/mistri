/**
 * The fields a decision answers, as the App payload serves them (design §1:
 * "the server serves each decided field's annotation with the App payload").
 * `app.ts` never names a decision: they are declared in the jobs module, and
 * the server that hosts the module says, beside the App, where a suggestion
 * may stand — so a record's first paint reserves its place and nothing moves
 * when one arrives.
 *
 * Kept per server (its connection registry) and App id, as the hosted jobs
 * module is: two servers in one process — a suite, a test — never read each
 * other's.
 */
import type { DecisionStore } from '../../adapters/decide/decisionStore.js';
import type { CapturedDecision } from './decisionModule.js';

/** One decided field: the decision that answers it and the command its answer lands through. */
interface DecidedField {
  readonly decision: string;
  readonly command: string;
}
type DecidedFields = Readonly<Record<string, Readonly<Record<string, DecidedField>>>>;

const served = new WeakMap<object, Map<string, DecidedFields>>();
/* What a record's suggestions are read from: the declarations (their question and inputs, for "Why this?") and the
   store the host decides into. */
const hosted = new WeakMap<object, Map<string, ServedDecisions>>();

export interface ServedDecisions {
  readonly decisions: ReadonlyMap<string, CapturedDecision>;
  readonly store: DecisionStore;
}

/** Record what a server's App decides; an App without decisions is forgotten. */
export function serveDecisions(server: object, appId: string, decisions: Iterable<CapturedDecision>, store?: DecisionStore): void {
  const fields: Record<string, Record<string, DecidedField>> = {};
  const byName = new Map<string, CapturedDecision>();
  for (const decision of decisions) {
    (fields[decision.target] ??= {})[decision.answer.field] = { decision: decision.name, command: decision.answer.command.id };
    byName.set(decision.name, decision);
  }
  const apps = served.get(server) ?? new Map<string, DecidedFields>();
  if (Object.keys(fields).length) apps.set(appId, fields);
  else apps.delete(appId);
  served.set(server, apps);
  const stores = hosted.get(server) ?? new Map<string, ServedDecisions>();
  if (byName.size && store) stores.set(appId, { decisions: byName, store });
  else stores.delete(appId);
  hosted.set(server, stores);
}

/** The declarations and store a server's App decides with; undefined where it decides nothing. */
export function decisionsServedBy(server: object, appId: string): ServedDecisions | undefined {
  return hosted.get(server)?.get(appId);
}

/**
 * The decided fields of the tables this reader's catalog holds, of the decisions whose answer command they are granted
 * (the people who could accept one); undefined when there are none.
 */
export function servedDecisions(
  server: object,
  appId: string,
  tables: ReadonlySet<string>,
  granted: ReadonlySet<string>,
): DecidedFields | undefined {
  const fields = served.get(server)?.get(appId);
  if (!fields) return undefined;
  const visible = Object.entries(fields).flatMap(([table, decided]) => {
    if (!tables.has(table)) return [];
    const offered = Object.entries(decided).filter(([, field]) => granted.has(field.command));
    return offered.length ? [[table, Object.fromEntries(offered)] as const] : [];
  });
  return visible.length ? Object.fromEntries(visible) : undefined;
}
