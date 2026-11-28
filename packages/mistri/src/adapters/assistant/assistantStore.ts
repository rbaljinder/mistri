/**
 * The assistant's conversations, the engine-neutral half of their store: a
 * conversation row per person's chat and an append-only list of its events,
 * and a day's token count per person, which the caps are read from; and,
 * for a tenant App, whether the platform has turned the assistant on for each
 * tenant (written by tenant administration, tenantAssistantSwitch.ts).
 *
 * Kept in reserved `__mistri_assistant_*` tables beside the App's records,
 * provisioned once by maintenance and attested when an App that declares an
 * assistant starts. Every statement names its owner — App, tenant, account —
 * so a conversation id from another person, App or tenant is not found rather
 * than refused: there is nothing to tell them about it.
 */
import { randomUUID } from 'node:crypto';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { ASSISTANT_FEATURE, TENANT_SWITCH_TABLES } from '../switch/tenantSwitch.js';

export const ASSISTANT_STORE_VERSION = 2;
export const ASSISTANT_PREFIX = '__mistri_assistant_';
export const ASSISTANT_TABLES = Object.freeze({
  meta: `${ASSISTANT_PREFIX}meta`,
  conversation: `${ASSISTANT_PREFIX}conversation`,
  event: `${ASSISTANT_PREFIX}event`,
  usage: `${ASSISTANT_PREFIX}usage`,
  memory: `${ASSISTANT_PREFIX}memory`,
  run: `${ASSISTANT_PREFIX}run`,
  automation: `${ASSISTANT_PREFIX}automation`,
});
export const ASSISTANT_INDEX = `${ASSISTANT_PREFIX}conversation_owner`;
export const ASSISTANT_MEMORY_INDEX = `${ASSISTANT_PREFIX}memory_owner`;
export const ASSISTANT_RUN_INDEX = `${ASSISTANT_PREFIX}run_owner`;

/** Bounds, the same on every engine. An event is the model's content or a tool's result, kept whole. */
export const ASSISTANT_LIMITS = Object.freeze({
  app: 128,
  tenant: 128,
  account: 1024,
  title: 200,
  body: 512 * 1024,
  /** The consent reference the platform owner wrote when turning it on, in bytes: words, not a document. */
  consent: 2000,
  /** One remembered fact, in bytes. */
  memoryContent: 1000,
  /** Optional agent id that scopes a memory, in bytes (`''` for shared across agents). */
  memoryAgent: 64,
  /** Prompt text that initiated a durable background run, in bytes. */
  runPrompt: 4000,
  /** Final summary or failure detail of a durable background run, in bytes. */
  runSummary: 2000,
  /** Origin tag of a durable background run (`manual`, `preset:<id>`, `schedule:<id>`, `trigger:<id>`). */
  runSource: 128,
  /** Schedule or trigger id, in bytes. */
  automationId: 64,
});

export class AssistantStoreUnavailable extends Refusal {
  constructor(message = 'The assistant store is unavailable or not this version.') {
    super(message);
    this.name = 'AssistantStoreUnavailable';
  }
}

/** Whose a conversation is. `tenant` is '' outside a tenant App. */
export interface AssistantOwner {
  readonly app: string;
  readonly tenant: string;
  readonly account: string;
}
export type ConversationState = 'idle' | 'awaiting';
interface StoredConversation {
  readonly id: string;
  readonly title: string;
  readonly state: ConversationState;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface StoredEvent {
  readonly seq: number;
  readonly kind: string;
  readonly body: unknown;
  readonly at: string;
}
interface NewEvent {
  readonly kind: string;
  readonly body: unknown;
}
/** A durable fact remembered for a signed-in person (`scope: 'person'`) or shared across an App/tenant (`scope: 'app'`). */
export interface StoredMemory {
  readonly id: string;
  readonly scope: 'person' | 'app';
  readonly agent: string;
  readonly content: string;
  readonly source: 'assistant' | 'person';
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface RememberInput {
  readonly id?: string;
  readonly scope: 'person' | 'app';
  readonly agent?: string;
  readonly content: string;
  readonly source: 'assistant' | 'person';
  readonly maxItems?: number;
}

export type RunStatus = 'queued' | 'running' | 'awaiting' | 'completed' | 'failed' | 'cancelled';

/** A durable background agent run linked to its own conversation event stream. */
export interface StoredRun {
  readonly id: string;
  readonly conversation: string;
  readonly agent: string;
  readonly source: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: RunStatus;
  readonly steps: number;
  readonly tokens: number;
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string;
}
interface CreateRunInput {
  readonly conversation: string;
  readonly agent?: string;
  readonly source?: string;
  readonly title: string;
  readonly prompt: string;
}
interface UpdateRunInput {
  readonly status?: RunStatus;
  readonly steps?: number;
  readonly tokens?: number;
  readonly summary?: string;
  readonly finishedAt?: string;
}
type AutomationKind = 'schedule' | 'trigger';
interface StoredAutomationState {
  readonly kind: AutomationKind;
  readonly automationId: string;
  readonly enabled: boolean;
  readonly lastSlot: string;
  readonly lastRunId: string;
  readonly lastRunAt: string;
  readonly updatedAt: string;
}
interface UpsertAutomationInput {
  readonly kind: AutomationKind;
  readonly automationId: string;
  readonly enabled?: boolean;
  readonly lastSlot?: string;
  readonly lastRunId?: string;
  readonly lastRunAt?: string;
}

export type Row = Record<string, unknown>;
export interface Db {
  all(sql: string, ...params: unknown[]): Promise<Row[]>;
  run(sql: string, ...params: unknown[]): Promise<number>;
}
/** One transaction over an attested store; the engine's file says what that means. */
export type Transaction = <T>(work: (db: Db) => Promise<T>) => Promise<T>;

export interface AssistantStore {
  list(owner: AssistantOwner, limit: number): Promise<StoredConversation[]>;
  create(owner: AssistantOwner, title: string, at: string): Promise<StoredConversation>;
  get(owner: AssistantOwner, id: string): Promise<StoredConversation | null>;
  events(owner: AssistantOwner, id: string): Promise<StoredEvent[]>;
  /** Append in order and set the state; false when the conversation is not the owner's. */
  append(owner: AssistantOwner, id: string, events: readonly NewEvent[], state: ConversationState, at: string): Promise<boolean>;
  /** Drop the events from `seq` on: a retry or an edit continues from the prefix the model already saw. */
  truncate(owner: AssistantOwner, id: string, seq: number, at: string): Promise<boolean>;
  remove(owner: AssistantOwner, id: string): Promise<boolean>;
  /** Name it again; false when the conversation is not the owner's. Its place in the list (its last change) stays. */
  rename(owner: AssistantOwner, id: string, title: string): Promise<boolean>;
  /** The owner's conversations whose words — theirs or the model's, never a tool's result — hold `words`, newest first, each with the words it was found in. */
  search(owner: AssistantOwner, words: string, limit: number): Promise<Array<{ conversation: StoredConversation; text: string }>>;
  /** Count tokens spent on a UTC day. */
  spend(owner: AssistantOwner, day: string, tokens: number): Promise<void>;
  /** A day's tokens: this person's, every person's in their tenant, and every person's in the App across tenants. */
  spent(owner: AssistantOwner, day: string): Promise<{ person: number; tenant: number; app: number }>;
  /** Durable memories visible to this owner (`person` scoped to this account + `app` shared across this app/tenant). */
  memories(
    owner: AssistantOwner,
    options?: { scopes?: readonly ('person' | 'app')[]; agent?: string; limit?: number },
  ): Promise<StoredMemory[]>;
  /** Save a new memory or update an existing owned memory by `id`. Enforces `maxItems` by evicting oldest in that scope if full. */
  remember(owner: AssistantOwner, input: RememberInput, at: string): Promise<{ memory: StoredMemory; updated: boolean }>;
  /** Remove a memory by id: person-scoped requires matching owner account; app-scoped requires `allowAppScope: true`. */
  forget(owner: AssistantOwner, id: string, options?: { allowAppScope?: boolean }): Promise<boolean>;
  /** Durable background runs owned by this person, newest first. */
  listRuns(owner: AssistantOwner, limit: number): Promise<StoredRun[]>;
  /** One durable background run owned by this person, or null. */
  getRun(owner: AssistantOwner, id: string): Promise<StoredRun | null>;
  /** Create a new queued background run linked to a durable conversation. */
  createRun(owner: AssistantOwner, input: CreateRunInput, at: string): Promise<StoredRun>;
  /** Update status, progress counters, summary, or completion timestamp of an owned run. */
  updateRun(owner: AssistantOwner, id: string, patch: UpdateRunInput, at: string): Promise<StoredRun | null>;
  /** Delete an owned background run record. */
  deleteRun(owner: AssistantOwner, id: string): Promise<boolean>;
  /** Count currently active (`queued` or `running`) runs for this owner. */
  countActiveRuns(owner: AssistantOwner): Promise<number>;
  /** Durable schedule & trigger state rows owned by this person. */
  listAutomations(owner: AssistantOwner): Promise<StoredAutomationState[]>;
  /** One durable schedule or trigger state row owned by this person, or null. */
  getAutomation(owner: AssistantOwner, kind: AutomationKind, automationId: string): Promise<StoredAutomationState | null>;
  /** Upsert enablement, last fired slot, and last run link for an owned schedule or trigger. */
  upsertAutomation(owner: AssistantOwner, input: UpsertAutomationInput, at: string): Promise<StoredAutomationState>;
  /** Whether the platform has turned the assistant on for this tenant: off until it says so. */
  tenantEnabled(app: string, tenant: string): Promise<boolean>;
  /** Every conversation of the App untouched since `before` (an ISO instant), with its events; how many went. */
  purge(app: string, before: string): Promise<number>;
  close(): Promise<void>;
}

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
function assertOwner(owner: AssistantOwner): void {
  for (const key of ['app', 'tenant', 'account'] as const) {
    const value = owner?.[key];
    if (typeof value !== 'string' || bytes(value) > ASSISTANT_LIMITS[key] || (key !== 'tenant' && !value))
      throw new Refusal(`The assistant store refuses an owner without a valid ${key}.`);
  }
}
const num = (value: unknown): number => (typeof value === 'string' ? Number(value) : (value as number));
const conversationOf = (row: Row): StoredConversation => ({
  id: String(row.id),
  title: String(row.title),
  state: row.state === 'awaiting' ? 'awaiting' : 'idle',
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});
/* What a stored event said in words: the person's text, or the model's text blocks; nothing else is searched. */
function wordsOf(kind: string, json: string): string {
  try {
    const body = JSON.parse(json) as { text?: unknown; content?: unknown };
    if (kind === 'person') return typeof body.text === 'string' ? body.text : '';
    if (kind === 'assistant' && Array.isArray(body.content))
      return body.content
        .filter((block: { type?: unknown; text?: unknown }) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: { text: string }) => block.text)
        .join(' ');
  } catch {
    /* A body the engine kept but cannot be read says nothing. */
  }
  return '';
}
/* LIKE's own marks taken literally: `!` is the escape, so `%`, `_` and `!` are words, not patterns. */
const literal = (text: string) => text.replace(/[!%_]/g, (mark) => `!${mark}`);

const title = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim() || 'Conversation';
  let out = flat.slice(0, ASSISTANT_LIMITS.title);
  while (bytes(out) > ASSISTANT_LIMITS.title) out = out.slice(0, -1);
  return out;
};

/** The store's rules over one engine's transaction; `t` names a reserved table as the engine qualifies it. */
export function createAssistantStore(transaction: Transaction, t: (name: string) => string, close: () => Promise<void>): AssistantStore {
  const { conversation, event, usage } = ASSISTANT_TABLES;
  const owned = async (db: Db, owner: AssistantOwner, id: string) =>
    typeof id === 'string' && id.length <= 64
      ? (
          await db.all(
            `SELECT id FROM ${t(conversation)} WHERE id = ? AND app = ? AND tenant = ? AND account = ?`,
            id,
            owner.app,
            owner.tenant,
            owner.account,
          )
        ).length === 1
      : false;
  return {
    async list(owner, limit) {
      assertOwner(owner);
      const rows = await transaction((db) =>
        db.all(
          `SELECT id, title, state, created_at, updated_at FROM ${t(conversation)}
          WHERE app = ? AND tenant = ? AND account = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
          owner.app,
          owner.tenant,
          owner.account,
          Math.max(1, Math.min(100, Math.trunc(limit))),
        ),
      );
      return rows.map(conversationOf);
    },
    async create(owner, text, at) {
      assertOwner(owner);
      const row = { id: randomUUID(), title: title(text), state: 'idle' as const, createdAt: at, updatedAt: at };
      await transaction((db) =>
        db.run(
          `INSERT INTO ${t(conversation)} (id, app, tenant, account, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`,
          row.id,
          owner.app,
          owner.tenant,
          owner.account,
          row.title,
          at,
          at,
        ),
      );
      return row;
    },
    async get(owner, id) {
      assertOwner(owner);
      if (typeof id !== 'string' || id.length > 64) return null;
      const rows = await transaction((db) =>
        db.all(
          `SELECT id, title, state, created_at, updated_at FROM ${t(conversation)} WHERE id = ? AND app = ? AND tenant = ? AND account = ?`,
          id,
          owner.app,
          owner.tenant,
          owner.account,
        ),
      );
      return rows.length ? conversationOf(rows[0]) : null;
    },
    async events(owner, id) {
      assertOwner(owner);
      return transaction(async (db) => {
        if (!(await owned(db, owner, id))) return [];
        const rows = await db.all(`SELECT seq, kind, body_json, at FROM ${t(event)} WHERE conversation = ? ORDER BY seq`, id);
        return rows.map((row) => ({
          seq: num(row.seq),
          kind: String(row.kind),
          body: JSON.parse(String(row.body_json)) as unknown,
          at: String(row.at),
        }));
      });
    },
    async append(owner, id, events, state, at) {
      assertOwner(owner);
      const bodies = events.map(({ kind, body }) => {
        const json = JSON.stringify(body);
        if (typeof kind !== 'string' || !/^[a-z]{1,16}$/.test(kind) || bytes(json) > ASSISTANT_LIMITS.body)
          throw new Refusal('The assistant store refuses an event past its bounds.');
        return { kind, json };
      });
      return transaction(async (db) => {
        if (!(await owned(db, owner, id))) return false;
        const last = await db.all(`SELECT max(seq) AS seq FROM ${t(event)} WHERE conversation = ?`, id);
        let seq = last[0]?.seq === null || last[0]?.seq === undefined ? 0 : num(last[0].seq);
        for (const { kind, json } of bodies) {
          await db.run(
            `INSERT INTO ${t(event)} (conversation, seq, kind, body_json, at) VALUES (?, ?, ?, ?, ?)`,
            id,
            ++seq,
            kind,
            json,
            at,
          );
        }
        await db.run(`UPDATE ${t(conversation)} SET state = ?, updated_at = ? WHERE id = ?`, state, at, id);
        return true;
      });
    },
    async truncate(owner, id, seq, at) {
      assertOwner(owner);
      return transaction(async (db) => {
        if (!(await owned(db, owner, id))) return false;
        await db.run(`DELETE FROM ${t(event)} WHERE conversation = ? AND seq >= ?`, id, Math.trunc(seq));
        await db.run(`UPDATE ${t(conversation)} SET state = 'idle', updated_at = ? WHERE id = ?`, at, id);
        return true;
      });
    },
    async remove(owner, id) {
      assertOwner(owner);
      return transaction(async (db) => {
        if (!(await owned(db, owner, id))) return false;
        await db.run(`DELETE FROM ${t(event)} WHERE conversation = ?`, id);
        await db.run(`DELETE FROM ${t(conversation)} WHERE id = ?`, id);
        return true;
      });
    },
    async rename(owner, id, text) {
      assertOwner(owner);
      return transaction(async (db) => {
        if (!(await owned(db, owner, id))) return false;
        await db.run(`UPDATE ${t(conversation)} SET title = ? WHERE id = ?`, title(text), id);
        return true;
      });
    },
    async search(owner, words, limit) {
      assertOwner(owner);
      const needle = words.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!needle || needle.length > 100) return [];
      const most = Math.max(1, Math.min(50, Math.trunc(limit)));
      /* One statement, owner-scoped: candidates by their stored JSON (the needle spelled as JSON spells it), then
         each confirmed on its words alone, so a match inside a tool call's input or a key name is not a match. */
      const rows = await transaction((db) =>
        db.all(
          `SELECT c.id, c.title, c.state, c.created_at, c.updated_at, e.kind, e.body_json
          FROM ${t(conversation)} c JOIN ${t(event)} e ON e.conversation = c.id
          WHERE c.app = ? AND c.tenant = ? AND c.account = ? AND e.kind IN ('person', 'assistant')
            AND lower(e.body_json) LIKE ? ESCAPE '!'
          ORDER BY c.updated_at DESC, c.id DESC, e.seq LIMIT 400`,
          owner.app,
          owner.tenant,
          owner.account,
          `%${literal(JSON.stringify(needle).slice(1, -1))}%`,
        ),
      );
      const found = new Map<string, { conversation: StoredConversation; text: string }>();
      for (const row of rows) {
        if (found.size >= most) break;
        const id = String(row.id);
        if (found.has(id)) continue;
        const text = wordsOf(String(row.kind), String(row.body_json));
        if (text.toLowerCase().includes(needle)) found.set(id, { conversation: conversationOf(row), text });
      }
      return [...found.values()];
    },
    async spend(owner, day, tokens) {
      assertOwner(owner);
      if (!Number.isSafeInteger(tokens) || tokens <= 0) return;
      // One statement, so two turns finishing together both count.
      await transaction((db) =>
        db.run(
          `INSERT INTO ${t(usage)} (app, tenant, account, day, tokens) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (app, tenant, account, day) DO UPDATE SET tokens = ${t(usage)}.tokens + excluded.tokens`,
          owner.app,
          owner.tenant,
          owner.account,
          day,
          tokens,
        ),
      );
    },
    async spent(owner, day) {
      assertOwner(owner);
      const rows = await transaction((db) =>
        db.all(`SELECT tenant, account, tokens FROM ${t(usage)} WHERE app = ? AND day = ?`, owner.app, day),
      );
      let person = 0;
      let tenant = 0;
      let app = 0;
      for (const row of rows) {
        const tokens = num(row.tokens);
        app += tokens;
        if (row.tenant !== owner.tenant) continue;
        tenant += tokens;
        if (row.account === owner.account) person += tokens;
      }
      return { person, tenant, app };
    },
    async memories(owner, options = {}) {
      assertOwner(owner);
      const scopes = options.scopes?.length ? options.scopes : (['person', 'app'] as const);
      const includePerson = scopes.includes('person');
      const includeApp = scopes.includes('app');
      if (!includePerson && !includeApp) return [];
      const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
      const agent = typeof options.agent === 'string' && options.agent ? options.agent : undefined;
      const clauses: string[] = [];
      const params: unknown[] = [owner.app, owner.tenant];
      if (includePerson) {
        clauses.push(`(scope = 'person' AND account = ?)`);
        params.push(owner.account);
      }
      if (includeApp) {
        clauses.push(`(scope = 'app' AND account = '')`);
      }
      const agentClause = agent ? ` AND (agent = '' OR agent = ?)` : '';
      if (agent) params.push(agent);
      params.push(limit);
      const rows = await transaction((db) =>
        db.all(
          `SELECT id, scope, agent, content, source, created_at, updated_at FROM ${t(ASSISTANT_TABLES.memory)}
          WHERE app = ? AND tenant = ? AND (${clauses.join(' OR ')})${agentClause}
          ORDER BY updated_at DESC, id DESC LIMIT ?`,
          ...params,
        ),
      );
      return rows.map((row): StoredMemory => ({
        id: String(row.id),
        scope: row.scope === 'app' ? 'app' : 'person',
        agent: String(row.agent),
        content: String(row.content),
        source: row.source === 'person' ? 'person' : 'assistant',
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }));
    },
    async remember(owner, input, at) {
      assertOwner(owner);
      const scope: 'person' | 'app' = input.scope === 'app' ? 'app' : 'person';
      const source: 'assistant' | 'person' = input.source === 'person' ? 'person' : 'assistant';
      const agent = typeof input.agent === 'string' ? input.agent.trim() : '';
      if (bytes(agent) > ASSISTANT_LIMITS.memoryAgent) throw new Refusal('The assistant store refuses an agent id past its bounds.');
      const content = typeof input.content === 'string' ? input.content.replace(/\s+/g, ' ').trim() : '';
      if (!content || bytes(content) > ASSISTANT_LIMITS.memoryContent)
        throw new Refusal(`A memory is non-empty text of at most ${ASSISTANT_LIMITS.memoryContent} bytes.`);
      const acct = scope === 'app' ? '' : owner.account;
      const maxItems = Math.max(1, Math.min(200, Math.trunc(input.maxItems ?? 50)));
      const mem = t(ASSISTANT_TABLES.memory);
      return transaction(async (db) => {
        if (input.id && typeof input.id === 'string' && input.id.length <= 64) {
          const existing = await db.all(
            `SELECT id, created_at FROM ${mem} WHERE id = ? AND app = ? AND tenant = ? AND scope = ? AND account = ?`,
            input.id,
            owner.app,
            owner.tenant,
            scope,
            acct,
          );
          if (existing.length === 1) {
            await db.run(`UPDATE ${mem} SET content = ?, source = ?, updated_at = ? WHERE id = ?`, content, source, at, input.id);
            return {
              updated: true,
              memory: {
                id: input.id,
                scope,
                agent,
                content,
                source,
                createdAt: String(existing[0].created_at),
                updatedAt: at,
              },
            };
          }
        }
        /* Avoid exact duplicates within the same owner/scope: refresh updated_at if identical text already exists. */
        const dup = await db.all(
          `SELECT id, agent, created_at FROM ${mem} WHERE app = ? AND tenant = ? AND scope = ? AND account = ? AND lower(content) = lower(?) LIMIT 1`,
          owner.app,
          owner.tenant,
          scope,
          acct,
          content,
        );
        if (dup.length === 1) {
          const id = String(dup[0].id);
          await db.run(`UPDATE ${mem} SET content = ?, source = ?, updated_at = ? WHERE id = ?`, content, source, at, id);
          return {
            updated: true,
            memory: {
              id,
              scope,
              agent: String(dup[0].agent),
              content,
              source,
              createdAt: String(dup[0].created_at),
              updatedAt: at,
            },
          };
        }
        /* Keep each scope bounded by maxItems (evict oldest when inserting beyond the cap). */
        const current = await db.all(
          `SELECT id FROM ${mem} WHERE app = ? AND tenant = ? AND scope = ? AND account = ? ORDER BY updated_at DESC, id DESC`,
          owner.app,
          owner.tenant,
          scope,
          acct,
        );
        if (current.length >= maxItems) {
          for (const drop of current.slice(maxItems - 1)) {
            await db.run(`DELETE FROM ${mem} WHERE id = ?`, String(drop.id));
          }
        }
        const id = randomUUID();
        await db.run(
          `INSERT INTO ${mem} (id, app, tenant, account, scope, agent, content, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          owner.app,
          owner.tenant,
          acct,
          scope,
          agent,
          content,
          source,
          at,
          at,
        );
        return {
          updated: false,
          memory: { id, scope, agent, content, source, createdAt: at, updatedAt: at },
        };
      });
    },
    async forget(owner, id, options = {}) {
      assertOwner(owner);
      if (typeof id !== 'string' || !id || id.length > 64) return false;
      const mem = t(ASSISTANT_TABLES.memory);
      return transaction(async (db) => {
        const rows = await db.all(
          `SELECT id, scope, account FROM ${mem} WHERE id = ? AND app = ? AND tenant = ?`,
          id,
          owner.app,
          owner.tenant,
        );
        if (rows.length !== 1) return false;
        const scope = rows[0].scope === 'app' ? 'app' : 'person';
        if (scope === 'person' && String(rows[0].account) !== owner.account) return false;
        if (scope === 'app' && !options.allowAppScope) return false;
        return (await db.run(`DELETE FROM ${mem} WHERE id = ?`, id)) > 0;
      });
    },
    async listRuns(owner, limit) {
      assertOwner(owner);
      const runs = t(ASSISTANT_TABLES.run);
      const rows = await transaction((db) =>
        db.all(
          `SELECT id, conversation, agent, source, title, prompt, status, steps, tokens, summary, created_at, updated_at, finished_at
          FROM ${runs} WHERE app = ? AND tenant = ? AND account = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
          owner.app,
          owner.tenant,
          owner.account,
          Math.max(1, Math.min(100, Math.trunc(limit))),
        ),
      );
      return rows.map((row): StoredRun => ({
        id: String(row.id),
        conversation: String(row.conversation),
        agent: String(row.agent),
        source: String(row.source),
        title: String(row.title),
        prompt: String(row.prompt),
        status: String(row.status) as RunStatus,
        steps: num(row.steps),
        tokens: num(row.tokens),
        summary: String(row.summary),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        finishedAt: String(row.finished_at),
      }));
    },
    async getRun(owner, id) {
      assertOwner(owner);
      if (typeof id !== 'string' || !id || id.length > 64) return null;
      const runs = t(ASSISTANT_TABLES.run);
      const rows = await transaction((db) =>
        db.all(
          `SELECT id, conversation, agent, source, title, prompt, status, steps, tokens, summary, created_at, updated_at, finished_at
          FROM ${runs} WHERE id = ? AND app = ? AND tenant = ? AND account = ?`,
          id,
          owner.app,
          owner.tenant,
          owner.account,
        ),
      );
      if (rows.length !== 1) return null;
      const row = rows[0]!;
      return {
        id: String(row.id),
        conversation: String(row.conversation),
        agent: String(row.agent),
        source: String(row.source),
        title: String(row.title),
        prompt: String(row.prompt),
        status: String(row.status) as RunStatus,
        steps: num(row.steps),
        tokens: num(row.tokens),
        summary: String(row.summary),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        finishedAt: String(row.finished_at),
      };
    },
    async createRun(owner, input, at) {
      assertOwner(owner);
      const runs = t(ASSISTANT_TABLES.run);
      const id = randomUUID();
      const agent = (input.agent ?? '').trim().slice(0, ASSISTANT_LIMITS.memoryAgent);
      const source = (input.source ?? 'manual').trim().slice(0, ASSISTANT_LIMITS.runSource) || 'manual';
      const cleanTitle = title(input.title);
      let prompt = input.prompt.trim();
      while (bytes(prompt) > ASSISTANT_LIMITS.runPrompt) prompt = prompt.slice(0, -1);
      const row: StoredRun = {
        id,
        conversation: input.conversation,
        agent,
        source,
        title: cleanTitle,
        prompt,
        status: 'queued',
        steps: 0,
        tokens: 0,
        summary: '',
        createdAt: at,
        updatedAt: at,
        finishedAt: '',
      };
      await transaction((db) =>
        db.run(
          `INSERT INTO ${runs} (id, app, tenant, account, conversation, agent, source, title, prompt, status, steps, tokens, summary, created_at, updated_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '', ?, ?, '')`,
          row.id,
          owner.app,
          owner.tenant,
          owner.account,
          row.conversation,
          row.agent,
          row.source,
          row.title,
          row.prompt,
          row.status,
          at,
          at,
        ),
      );
      return row;
    },
    async updateRun(owner, id, patch, at) {
      assertOwner(owner);
      if (typeof id !== 'string' || !id || id.length > 64) return null;
      const runs = t(ASSISTANT_TABLES.run);
      return transaction(async (db) => {
        const rows = await db.all(
          `SELECT id, conversation, agent, source, title, prompt, status, steps, tokens, summary, created_at, updated_at, finished_at
          FROM ${runs} WHERE id = ? AND app = ? AND tenant = ? AND account = ?`,
          id,
          owner.app,
          owner.tenant,
          owner.account,
        );
        if (rows.length !== 1) return null;
        const cur = rows[0]!;
        const status = patch.status ?? (String(cur.status) as RunStatus);
        const steps = patch.steps !== undefined ? Math.max(0, Math.trunc(patch.steps)) : num(cur.steps);
        const tokens = patch.tokens !== undefined ? Math.max(0, Math.trunc(patch.tokens)) : num(cur.tokens);
        let summary = patch.summary !== undefined ? patch.summary.trim() : String(cur.summary);
        while (bytes(summary) > ASSISTANT_LIMITS.runSummary) summary = summary.slice(0, -1);
        const finishedAt = patch.finishedAt !== undefined ? patch.finishedAt : String(cur.finished_at);
        await db.run(
          `UPDATE ${runs} SET status = ?, steps = ?, tokens = ?, summary = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND app = ? AND tenant = ? AND account = ?`,
          status,
          steps,
          tokens,
          summary,
          at,
          finishedAt,
          id,
          owner.app,
          owner.tenant,
          owner.account,
        );
        return {
          id,
          conversation: String(cur.conversation),
          agent: String(cur.agent),
          source: String(cur.source),
          title: String(cur.title),
          prompt: String(cur.prompt),
          status,
          steps,
          tokens,
          summary,
          createdAt: String(cur.created_at),
          updatedAt: at,
          finishedAt,
        };
      });
    },
    async deleteRun(owner, id) {
      assertOwner(owner);
      if (typeof id !== 'string' || !id || id.length > 64) return false;
      const runs = t(ASSISTANT_TABLES.run);
      return transaction(
        async (db) =>
          (await db.run(
            `DELETE FROM ${runs} WHERE id = ? AND app = ? AND tenant = ? AND account = ?`,
            id,
            owner.app,
            owner.tenant,
            owner.account,
          )) > 0,
      );
    },
    async countActiveRuns(owner) {
      assertOwner(owner);
      const runs = t(ASSISTANT_TABLES.run);
      const rows = await transaction((db) =>
        db.all(
          `SELECT COUNT(*) AS n FROM ${runs} WHERE app = ? AND tenant = ? AND account = ? AND status IN ('queued', 'running')`,
          owner.app,
          owner.tenant,
          owner.account,
        ),
      );
      return rows.length ? num(rows[0]!.n) : 0;
    },
    async listAutomations(owner) {
      assertOwner(owner);
      const automations = t(ASSISTANT_TABLES.automation);
      const rows = await transaction((db) =>
        db.all(
          `SELECT kind, automation_id, enabled, last_slot, last_run_id, last_run_at, updated_at
          FROM ${automations} WHERE app = ? AND tenant = ? AND account = ? ORDER BY kind ASC, automation_id ASC`,
          owner.app,
          owner.tenant,
          owner.account,
        ),
      );
      return rows.map((row): StoredAutomationState => ({
        kind: row.kind === 'trigger' ? 'trigger' : 'schedule',
        automationId: String(row.automation_id),
        enabled: num(row.enabled) === 1,
        lastSlot: String(row.last_slot),
        lastRunId: String(row.last_run_id),
        lastRunAt: String(row.last_run_at),
        updatedAt: String(row.updated_at),
      }));
    },
    async getAutomation(owner, kind, automationId) {
      assertOwner(owner);
      if (typeof automationId !== 'string' || !automationId || bytes(automationId) > ASSISTANT_LIMITS.automationId) return null;
      const automations = t(ASSISTANT_TABLES.automation);
      const rows = await transaction((db) =>
        db.all(
          `SELECT kind, automation_id, enabled, last_slot, last_run_id, last_run_at, updated_at
          FROM ${automations} WHERE app = ? AND tenant = ? AND account = ? AND kind = ? AND automation_id = ?`,
          owner.app,
          owner.tenant,
          owner.account,
          kind,
          automationId,
        ),
      );
      if (rows.length !== 1) return null;
      const row = rows[0]!;
      return {
        kind: row.kind === 'trigger' ? 'trigger' : 'schedule',
        automationId: String(row.automation_id),
        enabled: num(row.enabled) === 1,
        lastSlot: String(row.last_slot),
        lastRunId: String(row.last_run_id),
        lastRunAt: String(row.last_run_at),
        updatedAt: String(row.updated_at),
      };
    },
    async upsertAutomation(owner, input, at) {
      assertOwner(owner);
      const automationId = input.automationId.trim().slice(0, ASSISTANT_LIMITS.automationId);
      const automations = t(ASSISTANT_TABLES.automation);
      return transaction(async (db) => {
        const existingRows = await db.all(
          `SELECT enabled, last_slot, last_run_id, last_run_at
          FROM ${automations} WHERE app = ? AND tenant = ? AND account = ? AND kind = ? AND automation_id = ?`,
          owner.app,
          owner.tenant,
          owner.account,
          input.kind,
          automationId,
        );
        const existing = existingRows[0];
        const enabled = input.enabled !== undefined ? input.enabled : existing ? num(existing.enabled) === 1 : true;
        const lastSlot = input.lastSlot !== undefined ? input.lastSlot : existing ? String(existing.last_slot) : '';
        const lastRunId = input.lastRunId !== undefined ? input.lastRunId : existing ? String(existing.last_run_id) : '';
        const lastRunAt = input.lastRunAt !== undefined ? input.lastRunAt : existing ? String(existing.last_run_at) : '';
        if (existing) {
          await db.run(
            `UPDATE ${automations} SET enabled = ?, last_slot = ?, last_run_id = ?, last_run_at = ?, updated_at = ?
            WHERE app = ? AND tenant = ? AND account = ? AND kind = ? AND automation_id = ?`,
            enabled ? 1 : 0,
            lastSlot,
            lastRunId,
            lastRunAt,
            at,
            owner.app,
            owner.tenant,
            owner.account,
            input.kind,
            automationId,
          );
        } else {
          await db.run(
            `INSERT INTO ${automations} (app, tenant, account, kind, automation_id, enabled, last_slot, last_run_id, last_run_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            owner.app,
            owner.tenant,
            owner.account,
            input.kind,
            automationId,
            enabled ? 1 : 0,
            lastSlot,
            lastRunId,
            lastRunAt,
            at,
          );
        }
        return { kind: input.kind, automationId, enabled, lastSlot, lastRunId, lastRunAt, updatedAt: at };
      });
    },
    async tenantEnabled(app, tenant) {
      if (typeof app !== 'string' || typeof tenant !== 'string' || !app || !tenant) return false;
      const rows = await transaction((db) =>
        db.all(
          `SELECT enabled FROM ${t(TENANT_SWITCH_TABLES.tenant)} WHERE app = ? AND tenant = ? AND feature = ?`,
          app,
          tenant,
          ASSISTANT_FEATURE,
        ),
      );
      return rows.length === 1 && num(rows[0].enabled) === 1;
    },
    async purge(app, before) {
      if (typeof app !== 'string' || !app || typeof before !== 'string' || !Number.isFinite(Date.parse(before))) return 0;
      return transaction(async (db) => {
        await db.run(`DELETE FROM ${t(ASSISTANT_TABLES.run)} WHERE app = ? AND updated_at < ?`, app, before);
        await db.run(
          `DELETE FROM ${t(event)} WHERE conversation IN (SELECT id FROM ${t(conversation)} WHERE app = ? AND updated_at < ?)`,
          app,
          before,
        );
        return db.run(`DELETE FROM ${t(conversation)} WHERE app = ? AND updated_at < ?`, app, before);
      });
    },
    close,
  };
}
