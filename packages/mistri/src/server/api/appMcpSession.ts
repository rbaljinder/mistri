/** Private App MCP session: newline-delimited JSON-RPC over stdio-shaped
 * streams, with the framing rules of the database server's `mcp/protocol.ts`
 * but none of its tools — no SQL, table or connection selection reaches here.
 * Served by `mistri app-mcp` (stdio) and `…/$mcp` (appMcpHttp.ts); trusted
 * composition supplies the credential, the App, its logical schema and owner engines.
 * Every discovery and every call goes through an owner, which observes the
 * credential natively each time; the session keeps no roles or scope, and
 * neither a session nor a request id is ever authentication. */
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { AppDef } from '../../shared/appModel.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { checkApiCommandCatalog } from './apiCommandCatalog.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { previewApiMcpReadTools } from './apiMcpReadTools.js';
import { createApiMcpReadArguments } from './apiMcpReadArguments.js';
import { projectApiMcpCommandTools, type ApiMcpCommandBinding } from './apiMcpCommandTools.js';
import { createApiReadKeyCodec } from './apiReadKey.js';
import { ApiReadFailure } from './apiReadFailure.js';
import { ApiCommandRequestError } from './apiCommandHeaders.js';
import type { ApiCommandRoute } from './apiCommandRoute.js';
import { readApiApp } from './appApiValidation.js';
import { ApiCommandUnauthenticated, type createSqliteApiCommandOwner } from './sqliteApiCommandOwner.js';
import type { createSqliteApiReadOwner } from './sqliteApiReadOwner.js';
import type { createPostgresApiReadOwner } from './postgresApiReadOwner.js';
import type { createPostgresApiCommandOwner } from './postgresApiCommandOwner.js';
import type { createTenantApiOwner } from './tenantApiReadOwner.js';

const VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'];
type Id = string | number;
type Answer = Readonly<{ status: number; body: string }>;
type Listing = Readonly<{ tools: true }>;
type Request = Listing | Readonly<{ operationId: string; key: string } | { operationId: string; query: string }>;
type Deliver = (credential: string, request: Request, signal: AbortSignal, write: (answer: Answer) => void) => Promise<void>;
/** A command call as the transport would hand it to an owner's own `map`. */
type CommandCall = Readonly<{
  kind: ApiMcpCommandBinding['kind'];
  route: ApiCommandRoute;
  headers: Readonly<{ expectedVersion?: number; idempotencyKey?: string }>;
  body: unknown;
}>;
type CommandDeliver = (
  credential: string,
  request: Listing | CommandCall,
  signal: AbortSignal,
  write: (answer: Answer) => void,
) => Promise<void>;
type Json = Record<string, unknown>;

/** SQLite: buffered handle, consumed (natively re-observed) and written on
 * one stack; a cancelled or unwritten handle is discarded. */
export function sqliteAppMcpReads(reader: Awaited<ReturnType<typeof createSqliteApiReadOwner>>): Deliver {
  return async (credential, request, signal, write) => {
    const handle =
      'tools' in request
        ? await reader.readTools(credential, signal)
        : 'key' in request
          ? await reader.readItem(credential, request.operationId, request.key, signal)
          : await reader.readList(credential, request.operationId, request.query, signal);
    try {
      if (signal.aborted) return;
      write(reader.consumeResult(handle));
    } finally {
      reader.discardResult(handle);
    }
  };
}

/** PostgreSQL: the answer is written inside the owner's native handoff. */
export function postgresAppMcpReads(reader: Awaited<ReturnType<typeof createPostgresApiReadOwner>>): Deliver {
  return async (credential, request, signal, write) => {
    const send = (answer: Answer) => write(answer);
    await ('tools' in request
      ? reader.readTools(credential, send, signal)
      : 'key' in request
        ? reader.readItem(credential, request.operationId, request.key, send, signal)
        : reader.readList(credential, request.operationId, request.query, send, signal));
  };
}

/** SQLite command owner (api-v1): its own mapper builds the envelope, as for
 * HTTP; the answer is consumed and written on one stack. */
export function sqliteAppMcpCommands(owner: Awaited<ReturnType<typeof createSqliteApiCommandOwner>>): CommandDeliver {
  return async (credential, request, signal, write) => {
    const handle =
      'tools' in request
        ? await owner.readTools(credential, signal)
        : request.kind === 'prepare'
          ? await owner.prepare(credential, owner.map(request.route, request.headers, request.body), signal)
          : request.kind === 'recover'
            ? await owner.recover(credential, owner.map(request.route, request.headers, request.body), signal)
            : await owner.execute(credential, owner.map(request.route, request.headers, request.body), signal, 'mcp');
    try {
      if (signal.aborted) return;
      write(owner.consumeResult(handle));
    } finally {
      owner.discardResult(handle);
    }
  };
}

/** PostgreSQL command owner (api-v1): written inside the native handoff. */
export function postgresAppMcpCommands(owner: Awaited<ReturnType<typeof createPostgresApiCommandOwner>>): CommandDeliver {
  return async (credential, request, signal, write) => {
    const send = (answer: Answer) => write(answer);
    if ('tools' in request) {
      await owner.readTools(credential, send, signal);
      return;
    }
    const envelope = owner.map(request.route, request.headers, request.body);
    await (request.kind === 'prepare'
      ? owner.prepare(credential, envelope, send, signal)
      : request.kind === 'recover'
        ? owner.recover(credential, envelope, send, signal)
        : owner.execute(credential, envelope, send, signal, 'mcp'));
  };
}

/** A tenant App's one owner, for reads and commands alike: it hands its
 * answer over through `send`, after its own final token check, on either
 * engine (SQLite on its stack, PostgreSQL inside the native handoff). */
export function tenantAppMcpReads(owner: Awaited<ReturnType<typeof createTenantApiOwner>>): Deliver {
  return async (credential, request, _signal, write) => {
    const send = (answer: Answer) => write(answer);
    await ('tools' in request
      ? owner.readTools(credential, send)
      : 'key' in request
        ? owner.readItem(credential, request.operationId, request.key, send)
        : owner.readList(credential, request.operationId, request.query, send));
  };
}

export function tenantAppMcpCommands(owner: Awaited<ReturnType<typeof createTenantApiOwner>>): CommandDeliver {
  return async (credential, request, signal, write) => {
    const send = (answer: Answer) => write(answer);
    if ('tools' in request) {
      await owner.readTools(credential, send);
      return;
    }
    const envelope = owner.map(request.route, request.headers, request.body);
    await (request.kind === 'prepare'
      ? owner.prepare(credential, envelope, send, signal)
      : request.kind === 'recover'
        ? owner.recover(credential, envelope, send, signal)
        : owner.execute(credential, envelope, send, signal, 'mcp'));
  };
}

export function createAppMcpSession(options: {
  input: Readable;
  output: { write(chunk: string): unknown };
  credential: string;
  version: string;
  app: AppDef;
  schema: DatabaseSchema;
  integers: 'decimal-string' | 'number';
  deliver: Deliver;
  /** A command-exposing App: its registry and evidence for routing, and the
   * command owner, which also answers discovery for reads and commands alike. */
  commands?: { registry: BusinessCommandRegistry; evidence: Parameters<typeof checkApiCommandCatalog>[4]; deliver: CommandDeliver };
  /** A tenant App: its catalogs from trusted composition (its tenant API
   * owner's routing), which the ordinary checks refuse. Routing only. */
  tenant?: Readonly<{ reads: ReturnType<typeof checkApiReadCatalog>; commands?: ReturnType<typeof checkApiCommandCatalog> }>;
  /** Told when an owner refuses the credential itself, so an HTTP transport
   * can answer 401 rather than a tool result. */
  unauthenticated?: () => void;
  /** Over HTTP, the handshake is the client's first request and the one an
   * MCP client expects a 401 on: `initialize` and `ping` first ask the owner
   * whether the token observes, and answer nothing when it does not. */
  verifyHandshake?: boolean;
}) {
  const { input, output, credential, app, schema, integers, deliver, commands, tenant } = options;
  const refusedToken = (error: unknown) => {
    const refused = (error instanceof ApiReadFailure && error.code === 'unauthenticated') || error instanceof ApiCommandUnauthenticated;
    if (refused) options.unauthenticated?.();
    return refused;
  };
  const refusedAnswer = (answer: Answer) => {
    if (answer.status === 401) options.unauthenticated?.();
  };
  if (!app.api || typeof credential !== 'string' || typeof deliver !== 'function') throw new Error('The App MCP session is unavailable.');
  const api = app.api,
    readApp = readApiApp(app);
  // Routing only: every tool name this catalog could list, to what it runs.
  // The owner still authorizes each call, so a hidden name is simply refused.
  const catalog = tenant?.reads ?? checkApiReadCatalog(readApp.api!, readApp, schema);
  const reads = new Map(
    previewApiMcpReadTools(
      readApp,
      schema,
      { integers },
      { operations: catalog.operations.map((operation) => operation.id), roles: [...api.roles] },
      'preview',
      tenant?.reads,
    ).bindings.map((binding) => [binding.name, binding.operationId]),
  );
  const runs = new Map(
    commands
      ? projectApiMcpCommandTools(
          app,
          schema,
          commands.registry,
          commands.evidence,
          { integers },
          { operations: api.commands.map((exposure) => `command:${exposure.command.id}`), roles: [...api.roles] },
          tenant?.commands,
        ).bindings.map((binding) => [binding.name, binding])
      : [],
  );
  const decoders = new Map<string, ReturnType<typeof createApiMcpReadArguments>>();
  const decoder = (operationId: string) => {
    let codec = decoders.get(operationId);
    if (!codec) {
      codec = createApiMcpReadArguments(readApp, schema, operationId, { integers }, tenant?.reads);
      decoders.set(operationId, codec);
    }
    return codec;
  };
  const keyCodecs = new Map<string, ReturnType<typeof createApiReadKeyCodec>>();
  const keyCodec = (resource: string) => {
    let codec = keyCodecs.get(resource);
    if (!codec) {
      const table = schema.tables.find((value) => value.id === resource);
      if (!table) throw new Error('The App MCP session is unavailable.');
      const key = primaryKey(table);
      codec = createApiReadKeyCodec({ resource, primaryKey: key, fields: key }, schema, { integers });
      keyCodecs.set(resource, codec);
    }
    return codec;
  };

  // stdout is the protocol: one JSON message per line, nothing else.
  const line = (id: Id | null, member: 'result' | 'error', json: string) =>
    output.write(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"${member}":${json}}\n`);
  const reply = (id: Id, value: unknown) => line(id, 'result', JSON.stringify(value));
  const fail = (id: Id | null, code: number, message: string) => line(id, 'error', JSON.stringify({ code, message }));
  const refused = (id: Id, text: string) => reply(id, { content: [{ type: 'text', text }], isError: true });
  const mismatch = (id: Id) => refused(id, 'The arguments do not match this tool.');
  // The owner's serialized body, wrapped as text without parsing it again.
  const answered = (id: Id, answer: Answer) => {
    const ok = answer.status === 200;
    line(
      id,
      'result',
      `{"content":[{"type":"text","text":${JSON.stringify(answer.body)}}],` +
        `${ok ? `"structuredContent":${answer.body},` : ''}"isError":${!ok}}`,
    );
  };

  // Requests run in arrival order, one at a time, as in the database server.
  let chain: Promise<unknown> = Promise.resolve();
  let running: { id: Id; controller: AbortController } | undefined;
  const waiting = new Set<Id>(),
    withdrawn = new Set<Id>();
  const cancel = (id: unknown) => {
    if (running && running.id === id) running.controller.abort();
    else if ((typeof id === 'string' || typeof id === 'number') && waiting.has(id)) withdrawn.add(id);
  };

  const readCall = async (id: Id, operationId: string, args: unknown, signal: AbortSignal) => {
    let request: Request;
    try {
      request = decoder(operationId).decode(args ?? {}, new Date());
    } catch {
      return mismatch(id);
    }
    let written = false;
    try {
      await deliver(credential, request, signal, (answer) => {
        // A cancelled call answers nothing; the owner discards its result.
        if (signal.aborted) throw new Error('cancelled');
        written = true;
        refusedAnswer(answer);
        answered(id, answer);
      });
    } catch (error) {
      if (written || signal.aborted) return;
      refusedToken(error);
      return refused(id, JSON.stringify({ error: { code: error instanceof ApiReadFailure ? error.code : 'temporarily_unavailable' } }));
    }
    if (!written && !signal.aborted) refused(id, JSON.stringify({ error: { code: 'temporarily_unavailable' } }));
  };

  /* A command tool's arguments, checked for shape here and nowhere trusted:
     the owner's own mapper and executor remain the authority for the key,
     the revision, the input and the idempotency key. */
  const commandCall = async (id: Id, binding: ApiMcpCommandBinding, args: unknown, signal: AbortSignal) => {
    const value = args && typeof args === 'object' && !Array.isArray(args) ? (args as Json) : undefined;
    const wanted =
      binding.kind === 'prepare'
        ? ['key']
        : binding.kind === 'one'
          ? ['key', 'version', 'idempotencyKey', 'input']
          : binding.kind === 'many'
            ? ['targets', 'idempotencyKey', 'input']
            : ['idempotencyKey'];
    if (
      !value ||
      Object.keys(value).length !== wanted.length ||
      wanted.some((name) => !Object.hasOwn(value, name)) ||
      (binding.kind !== 'prepare' && typeof value.idempotencyKey !== 'string')
    )
      return mismatch(id);
    const base = { appId: app.id, version: api.version, command: binding.command, commandVersion: binding.version };
    let call: CommandCall;
    if (binding.kind === 'prepare') {
      let rawKey: string;
      try {
        rawKey = keyCodec(binding.resource).encode(value.key);
      } catch {
        return mismatch(id);
      }
      call = {
        kind: 'prepare',
        route: Object.freeze({ kind: 'prepare', method: 'GET', ...base, resource: binding.resource, rawKey }),
        headers: {},
        body: undefined,
      };
    } else if (binding.kind === 'one') {
      if (typeof value.idempotencyKey !== 'string') return mismatch(id);
      if (typeof value.version !== 'number') return mismatch(id);
      let rawKey: string;
      try {
        rawKey = keyCodec(binding.resource).encode(value.key);
      } catch {
        return mismatch(id);
      }
      call = {
        kind: 'one',
        route: Object.freeze({ kind: 'one', method: 'POST', ...base, resource: binding.resource, rawKey }),
        headers: { expectedVersion: value.version, idempotencyKey: value.idempotencyKey },
        body: value.input,
      };
    } else if (binding.kind === 'many') {
      if (typeof value.idempotencyKey !== 'string') return mismatch(id);
      call = {
        kind: 'many',
        route: Object.freeze({ kind: 'many', method: 'POST', ...base, resource: binding.resource }),
        headers: { idempotencyKey: value.idempotencyKey },
        body: { targets: value.targets, input: value.input },
      };
    } else {
      if (typeof value.idempotencyKey !== 'string') return mismatch(id);
      call = {
        kind: 'recover',
        route: Object.freeze({ kind: 'recover', method: 'GET', ...base, idempotencyKey: value.idempotencyKey }),
        headers: {},
        body: undefined,
      };
    }
    let written = false;
    try {
      await commands!.deliver(credential, call, signal, (answer) => {
        if (signal.aborted) throw new Error('cancelled');
        written = true;
        refusedAnswer(answer);
        answered(id, answer);
      });
    } catch (error) {
      if (written || signal.aborted) return;
      // Refused before the owner had the request: nothing ran, so no outcome is claimed.
      if (error instanceof ApiCommandRequestError) return refused(id, JSON.stringify({ error: { code: error.code } }));
      if (refusedToken(error)) return refused(id, JSON.stringify({ error: { code: 'unauthenticated' } }));
      // The owner may have had it: its outcome cannot be denied.
      return refused(id, JSON.stringify({ error: { code: 'temporarily_unavailable', outcome: 'unknown' } }));
    }
    if (!written && !signal.aborted) refused(id, JSON.stringify({ error: { code: 'temporarily_unavailable', outcome: 'unknown' } }));
  };

  const call = async (id: Id, params: Json, signal: AbortSignal) => {
    const name = typeof params.name === 'string' ? params.name : undefined;
    const operationId = name ? reads.get(name) : undefined;
    if (operationId) return readCall(id, operationId, params.arguments, signal);
    const binding = name ? runs.get(name) : undefined;
    if (binding) return commandCall(id, binding, params.arguments, signal);
    return refused(id, 'No such tool.');
  };

  const dispatch = async (message: Json) => {
    const id = message.id,
      method = message.method;
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? (message.params as Json) : {};
    // Notifications get no reply, including the one that ends the handshake.
    if (id === undefined || id === null) return;
    if (typeof id !== 'string' && typeof id !== 'number') return fail(null, -32600, 'The request id is not valid.');
    try {
      if (options.verifyHandshake && (method === 'initialize' || method === 'ping')) {
        let observed = false;
        await (commands ? commands.deliver : deliver)(credential, { tools: true }, new AbortController().signal, (answer) => {
          refusedAnswer(answer);
          observed = answer.status === 200;
        }).catch((error) => refusedToken(error));
        if (!observed) return fail(id, -32603, 'The App API is unavailable to this credential.');
      }
      if (method === 'initialize') {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return reply(id, {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[VERSIONS.length - 1],
          capabilities: { tools: {} },
          serverInfo: { name: 'mistri-app', version: options.version },
          instructions: `${app.name} through its App API. Each tool reads${commands ? ' or runs' : ''} what this token may, checked again on every call.`,
        });
      }
      if (method === 'ping') return reply(id, {});
      if (method === 'tools/list') {
        let written = false;
        // A command-exposing App lists through its command owner, whose one
        // fresh observation holds the token's read and command operations.
        await (commands ? commands.deliver : deliver)(credential, { tools: true }, new AbortController().signal, (answer) => {
          refusedAnswer(answer);
          // Only a listing is a result; a refusal is reported below.
          if (answer.status !== 200) return;
          written = true;
          line(id, 'result', answer.body);
        }).catch((error) => refusedToken(error));
        if (!written) fail(id, -32603, 'The tools are unavailable to this credential.');
        return;
      }
      if (method === 'tools/call') {
        waiting.delete(id);
        const controller = new AbortController();
        if (withdrawn.delete(id)) controller.abort();
        running = { id, controller };
        try {
          await call(id, params, controller.signal);
        } finally {
          running = undefined;
        }
        return;
      }
      return fail(id, -32601, 'No such method.');
    } catch {
      return fail(id, -32603, 'The request could not be completed.');
    }
  };

  const reader = createInterface({ input });
  reader.on('line', (text) => {
    if (!text.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      fail(null, -32700, 'That line is not JSON.');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      fail(null, -32600, 'That is not a JSON-RPC message.');
      return;
    }
    const value = message as Json;
    // A cancel is read out of turn: the call it names is running or waiting.
    if (value.method === 'notifications/cancelled') {
      cancel((value.params as Json | undefined)?.requestId);
      return;
    }
    if (value.method === 'tools/call' && (typeof value.id === 'string' || typeof value.id === 'number')) waiting.add(value.id);
    chain = chain.catch(() => {}).then(() => dispatch(value));
  });
  // Input closing ends the questions, not the answers: drain, then finish.
  const done = new Promise<void>((resolve) =>
    reader.on('close', () => {
      void chain.catch(() => {}).then(() => resolve());
    }),
  );
  return Object.freeze({ done });
}
