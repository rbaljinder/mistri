/**
 * An App's integrations at run time: one per App the server hosts, opened
 * over the integrations store beside its records, registered by App id so a
 * command's lookup finds it wherever the command was bound (the browser, the
 * API, MCP, a job), as the analytics recorder is found.
 *
 * Secrets: read per call, opened with the deployment's sealing key, one
 * tenant's alone ('' on an App without tenants). Nothing caches a secret
 * past the call that needed it, so a secret saved on one instance is the
 * next call's on every other.
 *
 * Calls: each is keyed by the request it serves — App, tenant, command,
 * actor, the request's idempotency key, the integration, the action and
 * its place among the lookup's calls of that action — and that key is
 * what the provider receives as its idempotency key. A key already
 * recorded is answered from the record and never sent again, so a retried
 * or replayed command charges once. A call that fails for a reason that may
 * pass (anything but the package's own refuse()) is tried again within the
 * request, three times in all with backoff, each try under its own deadline;
 * one that still fails refuses the command `temporarily_unavailable` and
 * records nothing, so the next attempt asks the provider again with the same
 * key. A package's refuse(reason) is recorded and answered as the command's
 * refusal, with its reason, every time.
 */
import { createHash } from 'node:crypto';
import type { IntegrationStore } from '../../adapters/integrations/integrationStore.js';
import { BusinessCommandExecutionError, isBusinessCommandExecutionError } from '../commands/commandErrors.js';
import type { CapturedIntegrations } from './integrationDeclaration.js';
import type { IntegrationCalls } from './integrationModule.js';
import { openSecret, sealSecret } from './integrationSecrets.js';

/* Three tries, 250 ms then 500 ms apart, each given 12 s: the effects' per-request bound, inside a request someone waits on. */
const CALL_LIMITS = Object.freeze({ attempts: 3, backoffMs: 250, timeoutMs: 12_000 });

export interface IntegrationRuntime {
  readonly appId: string;
  readonly declared: CapturedIntegrations;
  readonly store: IntegrationStore;
  readonly now: () => number;
  /** One tenant's opened secrets for an integration, or undefined while any it declares is missing. */
  secrets(tenant: string, integration: string): Promise<Readonly<Record<string, string>> | undefined>;
}

/** The runtime over an opened store. The store is the caller's to close. */
export function createIntegrationRuntime(
  options: Readonly<{ appId: string; declared: CapturedIntegrations; store: IntegrationStore; now?: () => number }>,
): IntegrationRuntime {
  const { appId, declared, store } = options;
  const now = options.now ?? Date.now;
  return Object.freeze({
    appId,
    declared,
    store,
    now,
    async secrets(tenant: string, integration: string) {
      const wanted = declared.use.get(integration)?.secrets;
      if (!wanted) return undefined;
      const rows = await store.secrets(appId, tenant, integration);
      const opened: Record<string, string> = {};
      for (const row of rows) {
        if (!wanted.includes(row.name)) continue;
        const value = openSecret({ app: appId, tenant, integration, name: row.name }, row.sealed);
        if (value !== undefined) opened[row.name] = value;
      }
      return wanted.every((name) => Object.hasOwn(opened, name)) ? Object.freeze(opened) : undefined;
    },
  });
}

const runtimes = new Map<string, IntegrationRuntime>();

/** Make an App's runtime the one its commands call through; the returned function withdraws it. */
export function registerIntegrationRuntime(runtime: IntegrationRuntime): () => void {
  runtimes.set(runtime.appId, runtime);
  return () => {
    if (runtimes.get(runtime.appId) === runtime) runtimes.delete(runtime.appId);
  };
}

/** The runtime registered for an App, as its settings routes reach it. */
export function integrationRuntimeOf(appId: string): IntegrationRuntime | undefined {
  return runtimes.get(appId);
}

/** The key a call is recorded and sent under: the same for every try of the same request's same call. */
function integrationCallKey(
  parts: Readonly<{
    appId: string;
    tenant: string;
    commandId: string;
    actorId: string;
    idempotencyKey: string;
    integration: string;
    action: string;
    ordinal: number;
  }>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'mistri.integration-call.v1',
        parts.appId,
        parts.tenant,
        parts.commandId,
        parts.actorId,
        parts.idempotencyKey,
        parts.integration,
        parts.action,
        parts.ordinal,
      ]),
    )
    .digest('hex');
}

const notSetUp = (integration: string) =>
  new BusinessCommandExecutionError(
    'ineligible_state',
    'not_applied',
    undefined,
    undefined,
    `${integration} is not set up yet: an administrator enters its secrets in the App's settings.`,
  );
const unavailable = () => new BusinessCommandExecutionError('temporarily_unavailable');
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * The `integrations` a command's lookup is handed: each action it declares,
 * as a function of its input. Outside a registered runtime every call
 * refuses `temporarily_unavailable`, as a lookup source that cannot be read
 * does.
 */
export function integrationCalls(
  context: Readonly<{
    appId: string;
    tenant: string;
    commandId: string;
    actorId: string;
    idempotencyKey: string;
    signal: AbortSignal;
    declared: Readonly<Record<string, readonly string[]>> | undefined;
  }>,
): IntegrationCalls {
  const ordinals = new Map<string, number>();
  const result: Record<string, Record<string, (input: unknown) => Promise<Readonly<Record<string, unknown>>>>> = {};
  for (const [integration, actions] of Object.entries(context.declared ?? {})) {
    const calls: Record<string, (input: unknown) => Promise<Readonly<Record<string, unknown>>>> = {};
    for (const action of actions) {
      calls[action] = async (input: unknown) => {
        const ordinal = (ordinals.get(`${integration}\n${action}`) ?? 0) + 1;
        ordinals.set(`${integration}\n${action}`, ordinal);
        const runtime = runtimes.get(context.appId);
        if (!runtime) throw unavailable();
        return call(runtime, context, integration, action, input, ordinal);
      };
    }
    result[integration] = Object.freeze(calls);
  }
  return Object.freeze(result);
}

async function call(
  runtime: IntegrationRuntime,
  context: Parameters<typeof integrationCalls>[0],
  integration: string,
  action: string,
  input: unknown,
  ordinal: number,
): Promise<Readonly<Record<string, unknown>>> {
  const definition = runtime.declared.use.get(integration);
  const declared = definition?.actions.get(action);
  // The check refused this before the App started; a runtime without it cannot call it.
  if (!definition || !declared) throw unavailable();
  let parsed: unknown;
  try {
    parsed = declared.input.parse(input);
  } catch {
    throw new TypeError(`The lookup called ${integration}.${action} with input its shape refuses.`);
  }
  const key = integrationCallKey({ ...context, integration, action, ordinal });
  const output = (value: unknown) => declared.output.parse(value) as Readonly<Record<string, unknown>>;
  const recorded = await runtime.store.call(runtime.appId, key);
  if (recorded?.state === 'done') return output(JSON.parse(recorded.resultJson ?? '{}'));
  if (recorded?.state === 'refused')
    throw new BusinessCommandExecutionError('ineligible_state', 'not_applied', undefined, undefined, recorded.reason ?? undefined);
  const secrets = await runtime.secrets(context.tenant, integration);
  if (!secrets) throw notSetUp(integration);
  const client = definition.client(secrets);
  const row = {
    app: runtime.appId,
    key,
    tenant: context.tenant,
    integration,
    action,
    command: context.commandId,
  };
  for (let attempt = 1; ; attempt++) {
    if (context.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
    const deadline = AbortSignal.any([context.signal, AbortSignal.timeout(CALL_LIMITS.timeoutMs)]);
    try {
      const answered = await Promise.race([
        Promise.resolve(declared.run(client, parsed, Object.freeze({ idempotencyKey: key, signal: deadline }))),
        new Promise<never>((_, reject) =>
          deadline.addEventListener('abort', () => reject(new Error('The call ran out of time.')), { once: true }),
        ),
      ]);
      const result = output(answered);
      await runtime.store.recordCall({
        ...row,
        state: 'done',
        resultJson: JSON.stringify(result),
        reason: null,
        attempts: attempt,
        at: runtime.now(),
      });
      return result;
    } catch (error) {
      if (isBusinessCommandExecutionError(error)) {
        const reason = error.reason ?? null;
        await runtime.store.recordCall({ ...row, state: 'refused', resultJson: null, reason, attempts: attempt, at: runtime.now() });
        throw new BusinessCommandExecutionError('ineligible_state', 'not_applied', undefined, undefined, reason ?? undefined);
      }
      if (attempt >= CALL_LIMITS.attempts || context.signal.aborted) throw unavailable();
      await pause(CALL_LIMITS.backoffMs * 2 ** (attempt - 1), context.signal);
    }
  }
}

/* ---------- the settings screen ---------- */

/** What the settings screen shows for one tenant: each integration and its secrets, set or not — never a value. */
export interface IntegrationSettings {
  readonly integrations: readonly Readonly<{
    name: string;
    secrets: readonly Readonly<{ name: string; set: boolean; savedAt: number | null }>[];
    webhook: string | null;
    channel: string | null;
  }>[];
}

export async function readIntegrationSettings(
  runtime: IntegrationRuntime,
  tenant: string,
  webhookPath: (integration: string) => string,
): Promise<IntegrationSettings> {
  const rows = await runtime.store.secrets(runtime.appId, tenant);
  return Object.freeze({
    integrations: [...runtime.declared.use.values()].map((integration) => ({
      name: integration.name,
      secrets: integration.secrets.map((name) => {
        const row = rows.find((candidate) => candidate.integration === integration.name && candidate.name === name);
        return { name, set: !!row, savedAt: row?.savedAt ?? null };
      }),
      webhook: integration.webhooks ? webhookPath(integration.name) : null,
      channel: integration.channel?.name ?? null,
    })),
  });
}

export class IntegrationSettingsRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationSettingsRefusal';
  }
}

/** Save what the screen sent: `{ integration, secrets: { name: value | null } }`; a null removes a secret. */
export async function saveIntegrationSettings(runtime: IntegrationRuntime, tenant: string, by: string, body: unknown): Promise<void> {
  const refuse = (message: string): never => {
    throw new IntegrationSettingsRefusal(message);
  };
  const value = body as { integration?: unknown; secrets?: unknown } | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Send { integration, secrets }.');
  const integration = typeof value!.integration === 'string' ? runtime.declared.use.get(value!.integration) : undefined;
  if (!integration) return refuse('That is not an integration this App uses.');
  const secrets = value!.secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return refuse('Send the secrets by name.');
  const entries = Object.entries(secrets as Record<string, unknown>);
  if (!entries.length) refuse('Send at least one secret.');
  for (const [name, given] of entries) {
    if (!integration.secrets.includes(name)) refuse(`${integration.name} has no secret "${name}".`);
    if (given !== null && (typeof given !== 'string' || !given.trim() || given.length > 4096))
      refuse(`${name} is from 1 to 4,096 characters, or null to remove it.`);
  }
  const at = runtime.now();
  for (const [name, given] of entries) {
    const place = { app: runtime.appId, tenant, integration: integration.name, name };
    await runtime.store.saveSecret({
      ...place,
      sealed: given === null ? null : sealSecret(place, (given as string).trim()),
      savedBy: by,
      at,
    });
  }
}
