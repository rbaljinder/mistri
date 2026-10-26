/**
 * What a signed-in test client asks of an App, in the requests the browser
 * sends: an edit, a command, a record's verb, a page opened. Each request is
 * typed by the server's own contract — the resource routes by
 * shared/resourceHttp.ts, a command's envelope by the parser that reads it
 * (commands/commandPayload.ts), the command routes by shared/commandRoutes.ts
 * — so a shape that drifts is a compile error here, not a 400 in someone's
 * suite. The App selector rides where the browser puts it
 * (client/requestIdentity.ts): in the query on a command, in the body
 * elsewhere; test/app-test-kit.test.ts holds the two to agreement.
 *
 * Nothing here throws on a refusal. An answer the server refuses comes back
 * as a value — `{ ok: false, status, code, message }` — so a test asserts a
 * 403 the way it asserts a success, and a permissions matrix reads as data.
 */
import { randomBytes } from 'node:crypto';
import type { ResourceHttpRequest, ResourceHttpSuccess, HttpRecordKey, HttpValues } from '@mistriwork/engine/shared/resourceHttp.js';
import type { CommandRequest } from '../commands/commandPayload.js';
import type { BusinessCommandResult } from '../commands/businessCommandExecution.js';
import { COMMAND_ROUTES } from '../../shared/commandRoutes.js';
import { appAddressBook, recordSegments, type AddressBook } from '../../shared/appAddress.js';
import { navViewKeys, viewOrder, type AppNavNode } from '../../shared/appModel.js';
import { FIRST_PAINT_ELEMENT, type FirstPaintData } from '@mistriwork/engine/shared/firstPaint.js';
import { BULK_LIMIT, type AppCommandField } from '../../shared/command.js';

/** A refusal, as a value: the HTTP status and the server's code and words. `status` 0 means nothing was sent. */
export interface TestRefusal {
  ok: false;
  status: number;
  /** `forbidden` on a refused write or command, `ineligible_state` for a command's own refusal…;
      `no_record` when no record was in the state a verb leaves from. */
  code?: string;
  message: string;
  /** The field a refusal names, where it names one. */
  field?: string;
  body: unknown;
}
export interface TestSuccess<T> {
  ok: true;
  status: number;
  value: T;
}
export type TestResult<T> = TestSuccess<T> | TestRefusal;

export type TestRecordKey = HttpRecordKey;
export type TestUpdateResult = TestResult<ResourceHttpSuccess<'/api/update', 'app'>>;
export type TestCommandResult = TestResult<BusinessCommandResult>;
export type TestRow = Record<string, unknown>;
/** A page opened as the browser opens it: the shell, and the reads its first room was answered with. */
export interface TestPage {
  address: string;
  /** Each read the page carries, by the request the client would have sent (shared/firstPaint.ts). */
  reads: FirstPaintData['reads'];
}

/** A record's action as the App serves it to this session (`resources[table].actions`). */
interface ServedAction {
  id: string;
  label?: string;
  when?: string;
  set?: HttpValues;
  reason?: string;
  command?: { id: string; version: number; target?: string; input?: AppCommandField[] };
}
interface ServedApp {
  id: string;
  views: Record<string, Record<string, unknown>>;
  nav: AppNavNode[];
  home?: string;
  resources?: Record<string, { actions?: ServedAction[] } & Record<string, unknown>>;
  pages?: { id: string; base: string; path?: string }[];
  inbox?: boolean;
  assistant?: { page?: boolean };
}
interface ServedSchema {
  tables: Array<{
    id: string;
    name: string;
    columns: Array<{ name: string; primaryKey: boolean; references?: { table: string; column: string } }>;
  }>;
}

type Send = (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> }) => Promise<Response>;

/** The server's answer as a result: JSON success, or a refusal carrying what the server said. */
async function readResult<T>(response: Response): Promise<TestResult<T>> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* Not JSON: kept as text, and a 2xx of text is still a refusal of the JSON asked for. */
  }
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const errors = Array.isArray(record?.errors) && record.errors.length ? (record.errors as Array<Record<string, unknown>>) : undefined;
  if (response.ok && record && !errors) return { ok: true, status: response.status, value: body as T };
  const first = errors?.[0];
  const code = record?.code ?? first?.code;
  const field = record?.field ?? (Array.isArray(first?.fields) ? (first.fields[0] as { field?: unknown })?.field : undefined);
  return {
    ok: false,
    status: response.status,
    ...(typeof code === 'string' ? { code } : {}),
    message: String(
      record?.message ??
        record?.error ??
        first?.message ??
        (typeof body === 'string' && body ? body.slice(0, 500) : `HTTP ${response.status}`),
    ),
    ...(typeof field === 'string' ? { field } : {}),
    body,
  };
}

/** The single-target execute envelope, exactly as the server's parser reads it (commandPayload.ts parseCommandRequest). */
export function commandEnvelope(input: {
  command: string;
  commandVersion: number;
  key: TestRecordKey;
  expectedVersion: number;
  input: unknown;
  idempotencyKey?: string;
}): CommandRequest {
  return {
    command: input.command,
    commandVersion: input.commandVersion,
    key: input.key,
    expectedVersion: input.expectedVersion,
    /* A retrying caller's key: 16–128 of [A-Za-z0-9_-]. One per call, so a test's second run is a second command. */
    idempotencyKey: input.idempotencyKey ?? randomBytes(18).toString('base64url'),
    input: input.input,
  };
}

/** The update body (shared/resourceHttp.ts): the App's selector in the body, as requestIdentity.ts puts it. */
export function updateBody(
  app: string,
  table: string,
  key: TestRecordKey,
  values: HttpValues,
  expected?: HttpValues,
): ResourceHttpRequest<'/api/update', 'app'> {
  return { app, table, key, values, ...(expected ? { expected } : {}) };
}

/** A command route with the App's selector in its query: a command's body is a strict envelope (requestIdentity.ts). */
export function commandPath(route: keyof typeof COMMAND_ROUTES, app: string): string {
  return `${COMMAND_ROUTES[route]}?app=${encodeURIComponent(app)}`;
}

/**
 * An answer to each required question a command asks, when the test gives none: the first choice, a number within
 * its bounds, today, a sentence that fits (an address where it asks for an email, a link or a phone number). A
 * reference is the first record of the table it names. What a test means to say it passes as `input`; this only lets
 * a journey run a command whose form asks something. A required question it cannot answer — a pattern, a row-defined
 * field, lines or rows it must have, a reference to a table with no record — is said by name in `unanswered`, and the
 * step is skipped as such rather than sent and refused `invalid_input`.
 */
export async function sampleInput(
  fields: readonly AppCommandField[],
  first: (table: string) => Promise<TestRow | undefined>,
): Promise<{ input: Record<string, unknown>; unanswered?: string }> {
  const input: Record<string, unknown> = {};
  const today = new Date().toISOString().slice(0, 10);
  for (const field of fields) {
    if (field.type === 'lines') {
      if ((field.min ?? 0) > 0) return { input, unanswered: field.name };
      continue;
    }
    if (field.type === 'group') {
      if (field.repeat) {
        if ((field.repeat.min ?? 0) > 0) return { input, unanswered: field.name };
        continue;
      }
      const inner = await sampleInput(field.fields, first);
      if (inner.unanswered) return { input, unanswered: `${field.name}.${inner.unanswered}` };
      input[field.name] = inner.input;
      continue;
    }
    if (!field.required || field.default !== undefined) continue;
    switch (field.type) {
      case 'text':
      case 'textarea':
      case 'richText': {
        if ('pattern' in field && field.pattern !== undefined) return { input, unanswered: field.name };
        // A mask is answered by its places: a digit for each 0, a letter for each a.
        if ('mask' in field && field.mask !== undefined) {
          input[field.name] = [...field.mask].flatMap((c) => (c === '0' ? ['1'] : c === 'a' || c === '*' ? ['A'] : [])).join('');
          break;
        }
        const format = 'format' in field ? field.format : undefined;
        const text =
          format === 'email'
            ? 'checked@example.test'
            : format === 'url'
              ? 'https://example.test/'
              : format === 'phone'
                ? '(555) 555-0100'
                : 'Checked by the test suite.'.padEnd(field.minLength ?? 0, '.');
        input[field.name] = field.maxLength ? text.slice(0, field.maxLength) : text;
        break;
      }
      case 'number':
      case 'money':
        input[field.name] = Math.max(field.min ?? 1, Math.min(field.max ?? 1, 1));
        break;
      case 'month':
        input[field.name] = field.min && field.min > today.slice(0, 7) ? field.min : today.slice(0, 7);
        break;
      case 'choices':
        if (!field.options.length) return { input, unanswered: field.name };
        input[field.name] = field.options.slice(0, Math.max(1, field.min ?? 1)).map((option) => option.value);
        break;
      case 'boolean':
        input[field.name] = true;
        break;
      case 'date':
        input[field.name] = field.min && field.min > today ? field.min : today;
        break;
      case 'datetime':
        input[field.name] = new Date().toISOString();
        break;
      case 'choice':
        if (field.source) {
          const row = await first(field.source.from);
          if (!row) return { input, unanswered: field.name };
          input[field.name] = row[field.source.by];
          break;
        }
        if (!field.options.length) return { input, unanswered: field.name };
        input[field.name] = field.options[0].value;
        break;
      case 'reference': {
        const row = await first(field.from);
        if (!row) return { input, unanswered: field.name };
        input[field.name] = row[field.by];
        break;
      }
      default:
        return { input, unanswered: field.name };
    }
  }
  return { input };
}

const pending = (code: string, message: string): TestRefusal => ({ ok: false, status: 0, code, message, body: undefined });

/** The App requests one session makes; `send` is the client's cookie-carrying request. */
export function appRequests(send: Send, options: { app?: string; base?: string } = {}) {
  let appId: Promise<string> | undefined;
  let served: Promise<{ app: ServedApp; schema: ServedSchema; book: AddressBook }> | undefined;
  const base = (options.base ?? '').replace(/\/$/, '');

  /* The App this server serves, as the client learns it at boot: /api/whoami names it to a signed-in session, and
     /api/runtime to anyone where no sign-in stands in front of it (an App without auth). */
  const app = () =>
    (appId ??= options.app
      ? Promise.resolve(options.app)
      : (async () => {
          const who = (await (await send('/api/whoami', {})).json().catch(() => ({}))) as { appId?: unknown };
          if (typeof who.appId === 'string') return who.appId;
          const runtime = await send('/api/runtime', {});
          const { active } = (runtime.ok ? await runtime.json().catch(() => ({})) : {}) as { active?: unknown };
          if (typeof active !== 'string') throw new Error('This server names no single App: create the client with { app } to name one.');
          return active;
        })());

  /* The App as this session is served it, its schema, and the address book the client builds from both
     (client/publicAddress.ts): read once per session. Signing in or out starts over. */
  const describe = () =>
    (served ??= (async () => {
      const id = await app();
      const [appReply, schemaReply] = await Promise.all([
        send(`/api/app?app=${encodeURIComponent(id)}`, {}),
        send(`/api/schema?app=${encodeURIComponent(id)}`, {}),
      ]);
      if (!appReply.ok) throw new Error(`GET /api/app answered ${appReply.status}: ${(await appReply.text()).slice(0, 300)}`);
      if (!schemaReply.ok) throw new Error(`GET /api/schema answered ${schemaReply.status}: ${(await schemaReply.text()).slice(0, 300)}`);
      const payload = ((await appReply.json()) as { app: ServedApp }).app;
      const schema = (await schemaReply.json()) as ServedSchema;
      const book = appAddressBook({
        views: payload.views as never,
        order: viewOrder(payload),
        resources: (payload.resources ?? {}) as never,
        pages: payload.pages ?? [],
        tables: schema.tables,
        inbox: payload.inbox === true,
        assistant: payload.assistant?.page === true,
        projected: true,
      });
      return { app: payload, schema, book };
    })().catch((error) => {
      served = undefined;
      throw error;
    }));

  async function keyOf(table: string, row: TestRow): Promise<TestRecordKey> {
    const { schema } = await describe();
    const found = schema.tables.find((candidate) => candidate.id === table || candidate.name === table);
    const columns = found?.columns.filter((column) => column.primaryKey).map((column) => column.name) ?? [];
    if (!columns.length) throw new Error(`"${table}" has no primary key in the App's schema, so its records have no key to name.`);
    return Object.fromEntries(columns.map((column) => [column, row[column] as string | number]));
  }

  /** Rows of one of the App's tables, through the query language (`where`, as a list tab says it). */
  async function rows(table: string, options: { where?: string; limit?: number } = {}): Promise<TestResult<TestRow[]>> {
    const id = await app();
    const q = options.where?.trim() ? `${table} ${options.where.trim()}` : table;
    const result = await readResult<ResourceHttpSuccess<'/api/run', 'app'>>(
      await send('/api/run', {
        method: 'POST',
        json: { app: id, q, limit: options.limit ?? 20, offset: 0, count: 'none' } satisfies ResourceHttpRequest<'/api/run', 'app'>,
      }),
    );
    return result.ok ? { ok: true, status: result.status, value: result.value.rows } : result;
  }

  async function update(table: string, key: TestRecordKey, values: HttpValues, expected?: HttpValues): Promise<TestUpdateResult> {
    return readResult(await send('/api/update', { method: 'POST', json: updateBody(await app(), table, key, values, expected) }));
  }

  /** The version of a command this session is served, from its record actions; else the first. */
  async function versionOf(command: string): Promise<number> {
    const { app: payload } = await describe();
    for (const resource of Object.values(payload.resources ?? {}))
      for (const action of resource.actions ?? []) if (action.command?.id === command) return action.command.version;
    return 1;
  }

  /** Prepare, then execute, as the browser's form does (client/commandSend.ts). */
  async function command(
    name: string,
    key: TestRecordKey,
    input: Record<string, unknown> = {},
    options: { version?: number } = {},
  ): Promise<TestCommandResult> {
    const id = await app();
    const commandVersion = options.version ?? (await versionOf(name));
    const prepared = await readResult<{ expectedVersion: number }>(
      await send(commandPath('prepare', id), {
        method: 'POST',
        json: { command: name, commandVersion, key } satisfies Pick<CommandRequest, 'command' | 'commandVersion' | 'key'>,
      }),
    );
    if (!prepared.ok) return prepared;
    return readResult(
      await send(commandPath('execute', id), {
        method: 'POST',
        json: commandEnvelope({ command: name, commandVersion, key, expectedVersion: prepared.value.expectedVersion, input }),
      }),
    );
  }

  /** Whether this session may run a command on a record: the prepare the form makes first, which changes nothing. */
  async function prepare(
    name: string,
    key: TestRecordKey,
    options: { version?: number } = {},
  ): Promise<TestResult<{ expectedVersion: number }>> {
    const id = await app();
    const commandVersion = options.version ?? (await versionOf(name));
    return readResult(await send(commandPath('prepare', id), { method: 'POST', json: { command: name, commandVersion, key } }));
  }

  /**
   * Which of these records a command is offered on, as the record's button asks (/api/commands/availability): its
   * own `when`, judged by the server in its transaction. Undefined where the server does not say.
   */
  async function offered(name: string, version: number, keys: TestRecordKey[]): Promise<boolean[] | undefined> {
    if (!keys.length) return [];
    const answer = await readResult<{ checks?: Array<{ available?: unknown }> }>(
      await send(commandPath('availability', await app()), {
        method: 'POST',
        json: { checks: [{ command: name, commandVersion: version, keys }] },
      }),
    );
    const available = answer.ok ? answer.value.checks?.[0]?.available : undefined;
    return Array.isArray(available) && available.length === keys.length && available.every((each) => typeof each === 'boolean')
      ? available
      : undefined;
  }

  /**
   * One of a record's actions — a machine verb, a fixed action or a command — as its button runs it, on the first
   * record whose state it leaves from where it is applied: the records its `when` selects are tried in turn, and a
   * command is tried only on the records it is offered on (its own `when`: a repair handed over once it is paid),
   * however many it is not offered on come first. A handler's refusal of one record (a balance too low, a field it
   * reads) moves on to the next. The last refusal comes back when none applied, and `no_record` when no record was
   * in the state.
   */
  async function act(
    table: string,
    action: string,
    options: { reason?: string; input?: Record<string, unknown>; where?: string; tries?: number } = {},
  ): Promise<TestResult<{ key: TestRecordKey; result: unknown }>> {
    const { app: payload } = await describe();
    const served = payload.resources?.[table]?.actions?.find((candidate) => candidate.id === action);
    if (!served) return pending('no_action', `"${table}" serves no action "${action}" to this session.`);
    const where = [served.when, options.where]
      .filter(Boolean)
      .map((part) => `(${part})`)
      .join(' and ');
    const tries = options.tries ?? 10;
    /* A command's own `when` is the server's to judge: a page of records is asked which it is offered on (AG1). */
    const candidates = await rows(table, { where, limit: served.command ? Math.min(BULK_LIMIT, tries * 10) : tries });
    if (!candidates.ok) return candidates;
    if (!candidates.value.length) return pending('no_record', `No ${table} record${where ? ` where ${where}` : ''} to run "${action}" on.`);
    let tried = await Promise.all(candidates.value.map(async (row) => ({ row, key: await keyOf(table, row) })));
    if (served.command) {
      const available = await offered(
        served.command.id,
        served.command.version,
        tried.map(({ key }) => key),
      );
      if (available) {
        tried = tried.filter((_, at) => available[at]);
        if (!tried.length)
          return pending(
            'no_record',
            `No ${table} record${where ? ` where ${where}` : ''} is offered "${action}": its command's when admits none.`,
          );
      }
    }
    let last: TestRefusal | undefined;
    for (const { key } of tried.slice(0, tries)) {
      let input = options.input ?? {};
      if (!options.input && served.command) {
        const sampled = await sampleInput(served.command.input ?? [], async (from) => {
          const found = await rows(from, { limit: 1 });
          return found.ok ? found.value[0] : undefined;
        });
        if (sampled.unanswered)
          return pending(
            'no_input',
            `"${action}" asks "${sampled.unanswered}", which the kit cannot answer for you: pass it as act(${JSON.stringify(table)}, ${JSON.stringify(action)}, { input: { ... } }).`,
          );
        input = sampled.input;
      }
      const result = served.command
        ? await command(served.command.id, key, input, { version: served.command.version })
        : await update(table, key, {
            ...(served.set ?? {}),
            ...(served.reason ? { [served.reason]: options.reason ?? 'Checked by the test suite.' } : {}),
          });
      if (result.ok) return { ok: true, status: result.status, value: { key, result: result.value } };
      last = result;
      /* Refused for who is asking: another record would be refused the same. A refusal naming a field is the
         handler's of this record as often as of the request (refuse('…', 'parts_in')), so the next is tried. */
      if (result.status === 401 || result.status === 403) return result;
    }
    return last!;
  }

  /** The address of a view, or of a record under the view that shows its table (shared/appAddress.ts). */
  async function address(target: string | { table: string; key: TestRecordKey }): Promise<string> {
    const { book } = await describe();
    if (typeof target === 'string') {
      const segment = book.views.get(target);
      if (segment === undefined) throw new Error(`"${target}" is not a view this session is served.`);
      return `${base}/${segment}`;
    }
    const segments = recordSegments(book, target.table, { key: target.key });
    if (!segments) throw new Error(`"${target.table}" has no record address in this App.`);
    return `${base}/${segments.join('/')}`;
  }

  /** Opens an address as the browser does: the page, with its first room's reads answered by the server through
      the routes a fetch reaches, under this session (server/http/firstPaint.ts). A read refused is left out. */
  async function open(target: string | { table: string; key: TestRecordKey }): Promise<TestResult<TestPage>> {
    const path = target === '/' || (typeof target === 'string' && target.startsWith('/')) ? target : await address(target);
    /* A navigation's Accept: under the dev server a path is otherwise also a client module's (/documents). */
    const response = await send(path, { headers: { accept: 'text/html' } });
    const html = await response.text();
    if (!response.ok) return { ok: false, status: response.status, message: html.slice(0, 500), body: html };
    const block = new RegExp(`<script type="application/json" id="${FIRST_PAINT_ELEMENT}">([\\s\\S]*?)</script>`).exec(html);
    const data = block ? (JSON.parse(block[1]) as FirstPaintData) : { reads: {}, items: {} };
    return { ok: true, status: response.status, value: { address: path, reads: data.reads } };
  }

  return {
    /** The id of the App this client speaks to. */
    appId: app,
    rows,
    update,
    command,
    prepare,
    act,
    address,
    open,
    /** A record's key, by the table's primary key in the App's schema. */
    key: keyOf,
    /** A table's stored columns in the App's schema, and the column its machine moves, if it has one. */
    async columns(table: string): Promise<{ schema: string[]; machine?: string }> {
      const { app: payload, schema } = await describe();
      const found = schema.tables.find((candidate) => candidate.id === table || candidate.name === table);
      const machine = (payload.resources?.[found?.id ?? table] as { machine?: { column?: unknown } } | undefined)?.machine?.column;
      return { schema: found?.columns.map((column) => column.name) ?? [], ...(typeof machine === 'string' ? { machine } : {}) };
    },
    /** The App's views in its menu, and its home, as this session is served them. */
    async views(): Promise<{ home?: string; nav: string[] }> {
      const { app: payload, book } = await describe();
      return { ...(payload.home ? { home: payload.home } : {}), nav: navViewKeys(payload.nav).filter((key) => book.views.has(key)) };
    },
    /** Forget what was read of the App: the session changed. */
    reset() {
      served = undefined;
    },
  };
}
