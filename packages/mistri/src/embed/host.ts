/**
 * The host a headless front end's hooks read through (`<Provider headless surface="…">`): the same `UiHost` the
 * served page's kit implements (client/components/sdk/host.tsx), over the one surface the boot answered and nothing
 * of the shell's. Every request goes to the Provider's endpoint, carries the session the Provider began and names the
 * surface in `X-Mistri-Surface`, so the server holds it to the surface's reads, loader and commands
 * (server/http/surfaceGate.ts) and judges each by the reader's grants, row policy and field ceilings as ever.
 *
 * It takes only the routes a surface may: `/api/view/run`, `/api/breakdown`, the page loader, `/api/file` and the
 * command routes. It draws nothing — no form, no toast, no dialog — so a command runs with the input it is handed and
 * the server's refusal comes back as the outcome; a link and a move go through the Provider's navigator. No kit module
 * is imported, at run time or for its types' sake, so the headless chunk stays the size of what it does.
 */
import type {
  UiAddress,
  UiCommandHandle,
  UiCommandOptions,
  UiCommandOutcome,
  UiCommandReview,
  UiHost,
  UiOption,
  UiReferenceInput,
  UiResourceChoices,
  UiRow,
} from '../client/components/sdk/context.js';
import { rowsByPath } from '../client/components/sdk/rows.js';
import { andQuery, quoteValue, splitClauseTail } from '@mistriwork/engine/shared/query.js';
import { tableNamed, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';
import { COMMAND_ROUTES } from '../shared/commandRoutes.js';
import { SURFACE_HEADER } from '../shared/appSurfaces.js';
import type { EmbedSurface, EmbedSurfaceCommand, EmbedSurfaceRead } from '../shared/embedProtocol.js';
import type { Navigator } from './navigator.js';
import { crossOrigin } from './session.js';

interface EmbedHostOptions {
  surface: EmbedSurface;
  /** The Provider's endpoint, without a trailing slash. */
  endpoint: string;
  /** The bearer a cross-origin request carries, read on every request; undefined for the cookie. */
  authorization(): string | undefined;
  /** Where `openRecord`, `openView` and `openForm` move to, by the address `href` says. */
  navigator: Navigator;
  /** The front end's own prefix for the App's addresses (`/crm`), or '' at its root. */
  basePath?: string;
}

/** A refusal or a failure as a hook reads it: `status` 401 or 403 is a refusal (`optional: true`), anything else an error. */
class HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const said = (body: unknown, fallback: string): string => {
  const reply = body as { error?: unknown; message?: unknown } | null;
  return typeof reply?.error === 'string' ? reply.error : typeof reply?.message === 'string' ? reply.message : fallback;
};

/** A key's values as the command routes take them: text or a safe whole number, nothing else. */
function sentKey(key: Readonly<Record<string, unknown>>): Record<string, string | number> | undefined {
  const sent: Record<string, string | number> = {};
  for (const [column, value] of Object.entries(key)) {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return undefined;
    sent[column] = value;
  }
  return Object.keys(sent).length ? sent : undefined;
}

const sameKey = (value: unknown, expected: Readonly<Record<string, string | number>>): boolean =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(expected).length &&
  Object.entries(expected).every(([column, id]) => String((value as Record<string, unknown>)[column]) === String(id));

const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function embedHost({ surface, endpoint, authorization, navigator, basePath = '' }: EmbedHostOptions): UiHost {
  const app = surface.app;
  const base = basePath.replace(/\/+$/, '');

  const headers = (json: boolean): Record<string, string> => {
    const bearer = authorization();
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      [SURFACE_HEADER]: surface.key,
      ...(bearer ? { authorization: bearer } : {}),
    };
  };
  /** One request of the surface's: its body and status, never thrown for a reply the server made. The App is named in
      the URL every time, so the server's surface gate knows which App's surfaces to judge before it reads the body. */
  async function ask(path: string, body: Record<string, unknown>, scoped: 'body' | 'url'): Promise<{ status: number; body: unknown }> {
    const url = `${endpoint}${path}?${new URLSearchParams({ app })}`;
    const reply = await fetch(url, {
      method: 'POST',
      credentials: crossOrigin(endpoint) ? 'omit' : 'same-origin',
      headers: headers(true),
      body: JSON.stringify(scoped === 'body' ? { ...body, app } : body),
    });
    const text = await reply.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: reply.status, body: parsed };
  }
  /** A read: its answer, or an error carrying the status a hook tells a refusal by. */
  async function read(path: string, body: Record<string, unknown>, fallback: string): Promise<Record<string, unknown>> {
    const got = await ask(path, body, 'body');
    if (got.status >= 400) throw new HostError(said(got.body, fallback), got.status, got.body as Record<string, unknown>);
    return (got.body ?? {}) as Record<string, unknown>;
  }

  /** A resource the surface reads, by its name or id; a resource it does not is refused as the server would refuse it. */
  function resource(name: string): { read: EmbedSurfaceRead; table: TableMeta } {
    const table = tableNamed(surface.schema, name);
    const found = table && surface.reads.find((each) => each.id === table.id);
    if (!table || !found) throw new HostError(`The surface "${surface.key}" does not read "${name}" for you.`, 403);
    return { read: found, table };
  }

  async function viewRows(
    name: string,
    show: readonly string[],
    asked: { query?: string; where?: unknown; offset?: number; limit: number },
  ): Promise<UiRow[]> {
    const { table } = resource(name);
    const paths = show.length ? [...show] : table.columns.map((column) => column.name);
    const got = await read(
      '/api/view/run',
      {
        count: 'none',
        ...(asked.query ? { query: asked.query } : {}),
        ...(asked.where === undefined ? {} : { where: asked.where }),
        ...(asked.offset ? { offset: asked.offset } : {}),
        view: { id: `ui:${table.id}`, name: table.name, base: table.id, columns: paths.map((path) => ({ path })), limit: asked.limit },
      },
      `"${name}" could not be read.`,
    );
    return rowsByPath(paths, got, `"${name}" could not be read.`, { schema: surface.schema, base: table.id });
  }

  const keyQuery = (key: Readonly<Record<string, unknown>>, columns: readonly string[]) =>
    columns.map((column) => `${column} = ${quoteValue(String(key[column]))}`).join(' and ');

  const addressOfRecord = (resourceName: string, key: Readonly<Record<string, unknown>>): string => {
    const { read: found } = resource(resourceName);
    const values = found.key.map((column) => encodeURIComponent(String(key[column])));
    return `${base}/${encodeURIComponent(found.name)}/${values.join(',')}`;
  };
  const withParams = (path: string, params?: Readonly<Record<string, string | undefined>>) => {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params ?? {})) if (value !== undefined && value !== '') search.set(name, value);
    const query = search.toString();
    return query ? `${path}?${query}` : path;
  };

  /** A handle that runs nothing: a command the surface does not run, or this reader is not granted. */
  const refusing = (label: string, why: string, target?: string): UiCommandHandle => {
    const refused = async (): Promise<UiCommandOutcome> => ({ status: 'refused', message: why });
    return {
      label,
      granted: false,
      ...(target ? { resource: target } : {}),
      available: async () => false,
      run: refused,
      open: refused,
      prepare: async () => ({ status: 'refused', message: why }),
    };
  };

  function commandHandle(command: EmbedSurfaceCommand): UiCommandHandle {
    const route = (name: keyof typeof COMMAND_ROUTES, body: Record<string, unknown>) => ask(COMMAND_ROUTES[name], body, 'url');
    const target = command.target ? surface.reads.find((each) => each.id === command.target) : undefined;
    const keyed = (key: Readonly<Record<string, unknown>>) =>
      sentKey(command.key ? Object.fromEntries(command.key.map((column) => [column, key[column]])) : key);
    const refusal = (body: unknown, fallback: string): Extract<UiCommandOutcome, { status: 'refused' }> => {
      const reply = body as { code?: unknown; field?: unknown } | null;
      const message = said(body, fallback);
      return {
        status: 'refused',
        message,
        ...(reply?.code === 'stale_record' ? { code: 'stale' as const } : {}),
        ...(typeof reply?.field === 'string' ? { fields: { [reply.field]: message } } : {}),
      };
    };
    async function prepared(
      key: Record<string, string | number>,
    ): Promise<
      { refused: Extract<UiCommandOutcome, { status: 'refused' }> } | { expectedVersion: number; initial: Record<string, unknown> }
    > {
      const got = await route('prepare', { command: command.id, commandVersion: command.version, key });
      const body = got.body as { expectedVersion?: unknown; initial?: unknown } | null;
      if (got.status >= 400 || !revision(body?.expectedVersion))
        return { refused: refusal(got.body, 'This record could not be prepared.') };
      const initial = body.initial && typeof body.initial === 'object' ? (body.initial as Record<string, unknown>) : {};
      return { expectedVersion: body.expectedVersion, initial };
    }
    /** Sent to execute, or its receipt asked of status under the same envelope: it can never run twice. */
    async function send(endpoint: 'execute' | 'status', envelope: Record<string, unknown>): Promise<UiCommandOutcome> {
      const unknown = (message: string): UiCommandOutcome => ({ status: 'unknown', message, check: () => send('status', envelope) });
      let got: { status: number; body: unknown };
      try {
        got = await route(endpoint, envelope);
      } catch {
        return unknown('The server could not be reached; it is not known whether this ran.');
      }
      const data = got.body as Record<string, unknown> | null;
      if (
        got.status < 400 &&
        (data?.outcome === undefined || data.outcome === 'applied') &&
        data?.status === 'applied' &&
        data.command === command.id &&
        data.commandVersion === command.version &&
        typeof data.receiptId === 'string' &&
        sameKey(data.key, envelope.key as Record<string, string | number>)
      ) {
        const message = (data.result as { message?: unknown } | null | undefined)?.message;
        return {
          status: 'applied',
          ...(typeof message === 'string' && message.trim() ? { message: message.trim() } : {}),
          ...(data.result === undefined ? {} : { output: data.result }),
        };
      }
      const rejected =
        (endpoint === 'execute' && data?.outcome === 'not_applied' && typeof data.message === 'string') ||
        (got.status >= 400 && got.status < 500 && (data?.code === 'surface' || typeof data?.error === 'string'));
      return rejected ? refusal(data, 'This was refused.') : unknown(said(data, 'The result is not yet known.'));
    }
    async function run(
      key: Readonly<Record<string, unknown>>,
      input: Readonly<Record<string, unknown>> = {},
      options: UiCommandOptions = {},
    ): Promise<UiCommandOutcome> {
      const sent = keyed(key);
      if (!sent) return { status: 'refused', message: 'Name the record to run this on by its key.' };
      let expectedVersion: number;
      if (options.review) {
        expectedVersion = Number(options.review.token);
        if (!revision(expectedVersion)) return { status: 'refused', message: 'This review is not one this command made.', code: 'stale' };
      } else {
        const ready = await prepared(sent);
        if ('refused' in ready) return ready.refused;
        expectedVersion = ready.expectedVersion;
      }
      return send('execute', {
        command: command.id,
        commandVersion: command.version,
        key: sent,
        expectedVersion,
        idempotencyKey: crypto.randomUUID(),
        input: JSON.parse(JSON.stringify(input)) as unknown,
      });
    }
    return {
      label: command.label,
      granted: true,
      ...(target ? { resource: target.name } : {}),
      async available(key) {
        const sent = keyed(key);
        if (!sent) return false;
        const got = await route('availability', { checks: [{ command: command.id, commandVersion: command.version, keys: [sent] }] });
        const checks = (got.body as { checks?: Array<{ command?: unknown; available?: unknown }> } | null)?.checks;
        const check = got.status < 400 ? checks?.find((each) => each.command === command.id) : undefined;
        return Array.isArray(check?.available) && check.available[0] === true;
      },
      run,
      /* There is no form to open: the front end draws its own, and what it hands in is sent. */
      open: run,
      async prepare(key) {
        const sent = keyed(key ?? {});
        if (!sent) return { status: 'refused', message: 'Name the record to review this on by its key.' };
        const ready = await prepared(sent);
        if ('refused' in ready) return ready.refused;
        return { token: String(ready.expectedVersion), values: ready.initial, fresh: true } satisfies UiCommandReview;
      },
      choices(name) {
        const field = command.input.find((each) => each.name === name);
        if (!field || (field.type !== 'choice' && field.type !== 'choices') || !field.options.length) return undefined;
        return field.options.map((option) => ({ value: option.value, label: option.label }));
      },
      input: (name) => command.input.find((each) => each.name === name),
      async check(input, names) {
        const got = await route('check', { command: command.id, commandVersion: command.version, fields: [...names], input });
        const problems = (got.body as { problems?: unknown } | null)?.problems;
        return got.status < 400 && problems && typeof problems === 'object' ? (problems as Record<string, string>) : undefined;
      },
    };
  }

  const commands = new Map<string, UiCommandHandle>();
  const choiceSource = (field: UiReferenceInput | UiResourceChoices) =>
    'resource' in field
      ? (() => {
          const { read: found } = resource(field.resource);
          return { resource: field.resource, by: found.key[0], label: found.title, where: field.where, filter: '' };
        })()
      : {
          resource: field.from,
          by: field.by,
          label: field.labelColumn,
          where: undefined,
          filter: splitClauseTail(field.query ?? '').head,
        };
  const optionOf = (row: UiRow, by: string, label: string): UiOption | null => {
    const value = row[by];
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
    return { key: value, label: String(row[label] ?? value) };
  };

  const host: UiHost = {
    flags: Object.freeze({
      ready: false,
      get: () => {
        throw new Error('A headless surface reads no flags.');
      },
      snapshot: () => ({
        ready: false,
        get: () => {
          throw new Error('A headless surface reads no flags.');
        },
      }),
      subscribe: () => () => {},
      load: async () => {},
    }),
    analytics: { emit: () => {} },
    scope: [app, surface.key],
    async rows(name, { where, query, show, sort, limit, offset, keys }) {
      const size = limit ?? 20;
      const asked = show?.length && keys ? [...new Set([...show, ...resource(name).read.key])] : (show ?? []);
      const rows = await viewRows(name, asked, {
        query: [query ?? '', sort ? `sort ${sort}` : ''].filter(Boolean).join(' '),
        where,
        offset,
        limit: size + 1,
      });
      return { rows: rows.slice(0, size), more: rows.length > size };
    },
    async record(name, key, show) {
      const [row] = await viewRows(name, show ?? [], { query: keyQuery(key, resource(name).read.key), limit: 1 });
      return row;
    },
    async load() {
      if (!surface.loader) throw new HostError(`The surface "${surface.key}" has no loader.`, 403);
      const got = await read(PAGE_LOAD_PATH, { page: surface.key, params: {} }, "The surface's loader could not run.");
      if (typeof got.error === 'string') throw new Error(got.error);
      return got.data;
    },
    async breakdown(name, { by, measure, query, limit }) {
      const { table } = resource(name);
      const got = await read(
        '/api/breakdown',
        {
          text: [table.id, query ?? '', `${measure ?? 'count'} by ${by}`].filter(Boolean).join(' '),
          ...(limit === undefined ? {} : { limit }),
        },
        `"${name}" could not be broken down.`,
      );
      return Array.isArray(got.rows) ? (got.rows as UiRow[]) : [];
    },
    openRecord(name, key) {
      navigator.push(addressOfRecord(name, key), null);
    },
    openView(view, options = {}) {
      navigator.push(
        withParams(`${base}/${encodeURIComponent(view)}`, { tab: options.tab, search: options.search, ...options.filters }),
        null,
      );
    },
    follow: (href) => navigator.push(href, null),
    openForm(view, prefill = {}) {
      navigator.push(
        withParams(
          `${base}/${encodeURIComponent(view)}`,
          Object.fromEntries(Object.entries(prefill).map(([name, value]) => [name, String(value)])),
        ),
        null,
      );
    },
    /* A declared form keeps its draft through a route a surface does not take: the front end draws its own form. */
    form: (view) => ({
      state: async () => ({ label: view, granted: false, steps: [], draft: null, pending: false }),
      open: async () => ({ status: 'closed' }),
      startOver: async () => false,
    }),
    publicLink: () => undefined,
    fillComposer: () => false,
    fileAddress(name, key, options = {}) {
      const { table } = resource(name);
      const query = new URLSearchParams({ app, table: table.id, key: JSON.stringify(key), inline: '1' });
      if (options.thumbnail) query.set('variant', 'thumb');
      return `${endpoint}/api/file?${query}`;
    },
    command(ref) {
      let handle = commands.get(ref);
      if (!handle) {
        const command = surface.commands.find((each) => each.id === ref);
        handle = !command
          ? refusing(ref, `The surface "${surface.key}" does not run "${ref}".`)
          : !command.granted
            ? refusing(command.label, `You are not granted "${command.label}".`, command.target)
            : !command.target
              ? refusing(command.label, `"${command.label}" names no record; a headless surface runs a command on a record.`)
              : commandHandle(command);
        commands.set(ref, handle);
      }
      return handle;
    },
    action: (ref) => refusing(ref, 'A headless surface runs commands, not fixed actions.'),
    async choices(field, text, { offset, limit }) {
      const source = choiceSource(field);
      const search = text ? `${source.label} contains ${quoteValue(text)}` : '';
      const rows = await viewRows(source.resource, [source.by, source.label], {
        query: [andQuery(source.filter, search), `sort ${source.label}`].filter(Boolean).join(' '),
        where: source.where,
        offset,
        limit: limit + 1,
      });
      const options = rows.slice(0, limit).flatMap((row) => optionOf(row, source.by, source.label) ?? []);
      return { options, more: rows.length > limit };
    },
    async choiceName(field, key) {
      const source = choiceSource(field);
      const [row] = await viewRows(source.resource, [source.by, source.label], {
        query: andQuery(source.filter, `${source.by} = ${quoteValue(String(key))}`),
        where: source.where,
        limit: 1,
      });
      return row ? optionOf(row, source.by, source.label) : null;
    },
    href(to: UiAddress) {
      switch (to.kind) {
        case 'signIn':
          return `${base}/sign-in`;
        case 'view':
          return withParams(`${base}/${encodeURIComponent(to.view)}`, to.params);
        case 'record': {
          const values = Object.values(to.key).map((value) => encodeURIComponent(String(value)));
          if (!values.length) return undefined;
          const at = `${base}/${encodeURIComponent(to.view)}/${values.join(',')}`;
          return to.tab ? `${at}/${encodeURIComponent(to.tab)}` : at;
        }
        case 'page':
          return withParams(`${base}/${to.path.split('/').map(encodeURIComponent).join('/')}`, to.params);
      }
    },
    /* The boot answered only a signed-in reader: the Provider draws its fallback otherwise. */
    viewer: () => ({ signedIn: true }),
    subscribeViewer: () => () => {},
    column(name, column) {
      const table = tableNamed(surface.schema, name);
      const meta = table?.columns.find((each) => each.name === column);
      return meta ? { meta, label: column } : undefined;
    },
    look: () => ({ look: 'workshop', preset: 'workshop', mode: 'light', density: 'comfortable' }),
    deployment: () => ({ name: surface.label, mark: null, theme: null, locale: null, basePath: base }),
    token: () => '',
    subscribeLook: () => () => {},
    app: true,
    announce: () => {},
    rowTitle(name, row) {
      const found = surface.reads.find((each) => each.id === tableNamed(surface.schema, name)?.id);
      const value = found ? row[found.title] : undefined;
      return value === undefined || value === null ? undefined : String(value);
    },
    message: (key) => key,
  };
  return host;
}
