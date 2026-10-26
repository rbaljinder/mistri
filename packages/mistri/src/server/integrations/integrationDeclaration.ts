/**
 * An App's integrations, as its jobs module declares them beside its inbound
 * endpoints and mail — the module where an App meets the outside world:
 *
 *   defineJobs({}, {
 *     principals: { payments: { roles: ['payments'] } },
 *     integrations: {
 *       use: [fakepay()],
 *       webhooks: { fakepay: { runAs: 'payments', events: { paid: 'markOrderPaid' } } },
 *       quietHours: { from: '21:00', to: '08:00', timezone: 'America/New_York' },
 *       editors: ['owner'],
 *     },
 *   })
 *
 * `use` lists the packages' integrations. `webhooks` maps an integration's
 * events to the App's commands, each run as the named principal, whose
 * roles are service roles (`service: true`). `quietHours` holds a channel
 * message that would arrive at night until the morning, in the recipient's
 * zone when the message names one. `editors` are the roles that may enter
 * the integrations' secrets on the settings screen. What a command calls (`integrations:
 * { fakepay: ['charge'] }`) and sends (`send('sms', …)`) is checked against
 * this list when the App starts and by `mistri check`.
 */
import { capturedIntegration, INTEGRATION_NAME, type CapturedIntegration, type Integration } from './integrationModule.js';

/** What `integrations` in a jobs module takes. */
export interface IntegrationsDeclaration {
  /** The integrations the App uses, each made by its package: `[fakepay()]`. */
  readonly use: readonly Integration[];
  /** Per integration: the principal its events run as, and the command each event runs. */
  readonly webhooks?: Readonly<Record<string, Readonly<{ runAs: string; events: Readonly<Record<string, string>> }>>>;
  /** No channel message is sent between `from` and `to` (24-hour `HH:MM`) in `timezone`, or in the recipient's own when the message names one. */
  readonly quietHours?: Readonly<{ from: string; to: string; timezone: string }>;
  /** The App roles that may enter secrets on the settings screen (in their own tenant, on a tenant App). None: nobody may. */
  readonly editors?: readonly string[];
}

/** The declaration as core holds it once captured. */
export interface CapturedIntegrations {
  readonly use: ReadonlyMap<string, CapturedIntegration>;
  readonly webhooks: ReadonlyMap<string, Readonly<{ runAs: string; events: ReadonlyMap<string, string> }>>;
  readonly quietHours?: Readonly<{ from: number; to: number; timezone: string }>;
  readonly editors: readonly string[];
}

const COMMAND_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PRINCIPAL = /^[a-z][a-z0-9-]{0,62}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function plain(value: unknown, where: string, fail: (message: string) => never): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${where} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail(`${where} must not inherit configuration.`);
  return value as Record<string, unknown>;
}

/** Whether a time zone is one the runtime knows, as the quiet hours read the clock in it. */
export function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture `integrations` against the module's principals. Every refusal
 * that `mistri check` should name by its own code carries it in brackets.
 */
export function captureIntegrations(
  value: unknown,
  principals: ReadonlyMap<string, readonly string[]>,
  fail: (message: string) => never,
): CapturedIntegrations {
  const declared = plain(value, 'Jobs integrations', fail);
  for (const key of Object.keys(declared))
    if (!['use', 'webhooks', 'quietHours', 'editors'].includes(key))
      fail(`Jobs integrations has no "${key}". It takes: use, webhooks, quietHours, editors.`);
  if (!Array.isArray(declared.use) || !declared.use.length)
    fail('Jobs integrations.use lists the integrations the App uses: use: [fakepay()].');
  const use = new Map<string, CapturedIntegration>();
  for (const entry of declared.use as unknown[]) {
    let integration: CapturedIntegration;
    try {
      integration = capturedIntegration(entry);
    } catch (error) {
      return fail(`Jobs integrations.use: ${(error as Error).message}`);
    }
    if (use.has(integration.name)) fail(`Jobs integrations.use lists "${integration.name}" twice.`);
    use.set(integration.name, integration);
  }
  const channels = new Map<string, string>();
  for (const integration of use.values()) {
    const channel = integration.channel?.name;
    if (!channel) continue;
    if (channels.has(channel))
      fail(
        `Jobs integrations.use: "${integration.name}" and "${channels.get(channel)}" both send on channel "${channel}"; an App sends each channel through one.`,
      );
    channels.set(channel, integration.name);
  }
  const webhooks = new Map<string, Readonly<{ runAs: string; events: ReadonlyMap<string, string> }>>();
  if (declared.webhooks !== undefined) {
    for (const [name, given] of Object.entries(plain(declared.webhooks, 'Jobs integrations.webhooks', fail))) {
      const at = `Jobs integrations.webhooks "${name}"`;
      const integration = INTEGRATION_NAME.test(name) ? use.get(name) : undefined;
      if (!integration)
        fail(`[integration-unknown] ${at} names an integration the App does not use. It uses: ${[...use.keys()].join(', ')}.`);
      if (!integration!.webhooks) fail(`[integration-event-unknown] ${at}: integration "${name}" sends no webhooks.`);
      const mapping = plain(given, at, fail);
      for (const key of Object.keys(mapping))
        if (key !== 'runAs' && key !== 'events') fail(`${at} has no "${key}". It takes: runAs, events.`);
      if (typeof mapping.runAs !== 'string' || !PRINCIPAL.test(mapping.runAs)) fail(`${at} runAs names a principal of the module.`);
      if (!principals.has(mapping.runAs as string))
        fail(`${at} runs as "${mapping.runAs as string}", which the module's principals do not declare.`);
      const events = new Map<string, string>();
      for (const [event, command] of Object.entries(plain(mapping.events, `${at} events`, fail))) {
        if (!integration!.webhooks!.events.has(event))
          fail(
            `[integration-event-unknown] ${at} maps event "${event}", which integration "${name}" does not declare. ` +
              `It declares: ${[...integration!.webhooks!.events.keys()].join(', ')}.`,
          );
        if (typeof command !== 'string' || !COMMAND_ID.test(command))
          fail(`${at} event "${event}" names the command it runs, as defineCommands registers it: paid: 'markOrderPaid'.`);
        events.set(event, command as string);
      }
      if (!events.size) fail(`${at} events maps at least one event to a command.`);
      webhooks.set(name, Object.freeze({ runAs: mapping.runAs as string, events }));
    }
  }
  let quietHours: CapturedIntegrations['quietHours'];
  if (declared.quietHours !== undefined) {
    const quiet = plain(declared.quietHours, 'Jobs integrations.quietHours', fail);
    const minutes = (clock: unknown) => {
      const match = typeof clock === 'string' ? CLOCK.exec(clock) : null;
      return match
        ? Number(match[1]) * 60 + Number(match[2])
        : fail("Jobs integrations.quietHours from and to are 24-hour times: from: '21:00', to: '08:00'.");
    };
    if (typeof quiet.timezone !== 'string' || !knownTimeZone(quiet.timezone))
      fail("Jobs integrations.quietHours timezone is an IANA zone: timezone: 'America/New_York'.");
    const from = minutes(quiet.from),
      to = minutes(quiet.to);
    if (from === to) fail('Jobs integrations.quietHours from and to differ: equal times would be quiet all day or never.');
    quietHours = Object.freeze({ from, to, timezone: quiet.timezone as string });
  }
  const editors = declared.editors ?? [];
  if (!Array.isArray(editors) || editors.some((role) => typeof role !== 'string' || !role) || new Set(editors).size !== editors.length)
    fail("Jobs integrations.editors lists the App roles that may enter secrets: editors: ['owner'].");
  return Object.freeze({ use, webhooks, ...(quietHours ? { quietHours } : {}), editors: Object.freeze([...(editors as string[])]) });
}

/** Each command a webhook event runs: the integration, the event and who runs it. */
export function integrationEventCommands(
  captured: CapturedIntegrations | undefined,
): Array<{ integration: string; event: string; command: string; runAs: string }> {
  if (!captured) return [];
  return [...captured.webhooks].flatMap(([integration, mapping]) =>
    [...mapping.events].map(([event, command]) => ({ integration, event, command, runAs: mapping.runAs })),
  );
}
