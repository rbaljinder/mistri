/**
 * What an App's use of integrations is held to, at startup and by
 * `mistri check` (both read the same sentences; the bracketed code is the
 * one check-codes.md lists):
 *
 * - a command calls only integrations the jobs module lists, and only the
 *   actions each declares (`integration-unknown`, `integration-action-unknown`);
 * - a command sends, and a `notify` rule sends, only on a channel a
 *   listed integration provides (`integration-channel-unknown`);
 * - a webhook event runs a registered command that names no record and is
 *   neither public nor the platform's, whose input the event's payload
 *   fills field for field (`integration-event-input`);
 * - the principal it runs as holds service roles alone (`service: true`) and
 *   is granted the command (`integration-service-role`).
 */
import { appCommandGrants, logicalResource, type AppDef } from '../../shared/app.js';
import { CHANNEL_DESTINATION_PREFIX } from '../commands/commandEffects.js';
import { getCommandEffects, getCommandEvents, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { describeShape, type ShapeDescriptor } from '../commands/commandShapes.js';
import { integrationEventCommands, type CapturedIntegrations } from './integrationDeclaration.js';
import { EMAIL_CHANNEL } from '../../adapters/inbox/inbox.js';

/** Problems a registry has against the declaration (undefined when the App lists none), in the registry's order. */
export function integrationCommandProblems(declared: CapturedIntegrations | undefined, registry: BusinessCommandRegistry): string[] {
  const problems: string[] = [];
  const use = declared?.use ?? new Map();
  const channels = new Set([...use.values()].flatMap((integration) => (integration.channel ? [integration.channel.name] : [])));
  for (const [id, command] of Object.entries(registry)) {
    for (const [name, actions] of Object.entries(command.integrations ?? {})) {
      const integration = use.get(name);
      if (!integration) {
        problems.push(
          `[integration-unknown] Command "${id}" calls integration "${name}", which the jobs module does not list in integrations.use` +
            (use.size ? `. It lists: ${[...use.keys()].join(', ')}.` : '; list it there: integrations: { use: [' + name + '()] }.'),
        );
        continue;
      }
      for (const action of actions)
        if (!integration.actions.has(action))
          problems.push(
            `[integration-action-unknown] Command "${id}" calls ${name}.${action}, which integration "${name}" does not declare. ` +
              `It declares: ${[...integration.actions.keys()].join(', ') || 'no actions'}.`,
          );
    }
    for (const effect of getCommandEffects(command) ?? []) {
      if (!effect.destination.startsWith(CHANNEL_DESTINATION_PREFIX)) continue;
      const channel = effect.destination.slice(CHANNEL_DESTINATION_PREFIX.length);
      if (!channels.has(channel))
        problems.push(
          `[integration-channel-unknown] Command "${id}" effect "${effect.name}" sends on channel "${channel}", which no integration the App lists provides` +
            (channels.size ? `. They provide: ${[...channels].join(', ')}.` : '.'),
        );
    }
  }
  for (const { integration, event, command: id } of integrationEventCommands(declared)) {
    const at = `integrations.webhooks "${integration}" event "${event}"`;
    const command = Object.hasOwn(registry, id) ? registry[id] : undefined;
    if (!command) {
      problems.push(`${at} runs command "${id}", which the commands module does not register.`);
      continue;
    }
    if (command.public) problems.push(`${at} runs command "${id}", which is public: only its public form runs it.`);
    if (command.realm === 'platform')
      problems.push(`${at} runs platform command "${id}"; a webhook arrives for one tenant, so it runs a tenant command.`);
    if ((command.targets ?? 'one') !== 'none')
      problems.push(
        `${at} runs command "${id}", which names a record; an event's command runs with targets: 'none' and finds its rows itself.`,
      );
    if (getCommandEvents(command) || typeof command.lookup === 'function')
      problems.push(`${at} runs command "${id}", which records events or looks up: a webhook's service command does neither.`);
    const payload = use.get(integration)?.webhooks?.events.get(event)?.payload;
    const mismatch = payload ? inputMismatch(describeShape(payload), command.fields) : undefined;
    if (mismatch)
      problems.push(`[integration-event-input] ${at} runs command "${id}", whose input the event's payload does not fill: ${mismatch}.`);
  }
  return problems;
}

/** A `notify` rule's `send` names a channel a listed integration provides, or the platform's email: its message is queued
    in the integrations store. */
export function integrationNotifyProblems(declared: CapturedIntegrations | undefined, app: AppDef): string[] {
  const channels = new Set(
    [...(declared?.use.values() ?? [])].flatMap((integration) => (integration.channel ? [integration.channel.name] : [])),
  );
  return Object.entries(app.resources ?? {}).flatMap(([name, resource]) =>
    (resource.notify ?? []).flatMap((rule, i) =>
      rule.send && rule.send.channel !== EMAIL_CHANNEL && !channels.has(rule.send.channel)
        ? [
            `[integration-channel-unknown] resources "${name}", notify ${i + 1} sends on channel "${rule.send.channel}", which no integration the App lists provides` +
              (channels.size ? `. They provide: ${[...channels].join(', ')}.` : '.'),
          ]
        : [],
    ),
  );
}

/**
 * An App that emails an address a record holds (`notify.send` email), held to
 * what sending it needs and what keeps it from being a relay: problems the
 * server does not start with, and advice. `connectionOf` says where each
 * resource lives (its connection and engine) when that is known.
 */
export function contactEmailFindings(
  app: AppDef,
  options: Readonly<{
    /** The config's email service, as far as it is set up. */
    email: { readonly links: boolean } | undefined;
    commands?: BusinessCommandRegistry;
    connectionOf?: (resource: string) => Readonly<{ id: string; dialect: string }> | undefined;
  }>,
): { problems: string[]; warnings: string[] } {
  const rules = Object.entries(app.resources ?? {}).flatMap(([resource, declared]) =>
    (declared.notify ?? []).flatMap((rule, i) =>
      rule.send?.channel === EMAIL_CHANNEL ? [{ resource, rule, at: `resources "${resource}", notify ${i + 1}` }] : [],
    ),
  );
  if (!rules.length) return { problems: [], warnings: [] };
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!options.email)
    problems.push(
      `[notify-send-transport] ${rules[0].at} emails an address the record holds, and this server has no email service. ` +
        'Add one to the config file: { "name": "mail", "kind": "email", "url": "smtps://…" or "log:", "from": "…", "links": { "secret": "${MAIL_LINK_SECRET}" } }.',
    );
  else if (!options.email.links)
    problems.push(
      `[notify-send-links-secret] ${rules[0].at} emails an address the record holds, and the email service sets no "links": { "secret" }, ` +
        'which signs the link that stops the mail. Set one: a long random value, from the environment.',
    );
  for (const { rule, at } of rules)
    if (rule.send!.timezone)
      problems.push(
        `[notify-send-timezone] ${at} gives email a "send.timezone"; mail has no quiet hours, since it waits in an inbox. Remove it.`,
      );
  /* A tenant App's mail is queued beside each tenant's records, in its one source, and its consent and caps are that
     tenant's (integrationChannels.ts); there is no second connection to share a store with. */
  if (options.connectionOf && app.auth?.rows !== 'tenant') {
    const where = new Map<string, { id: string; dialect: string }>();
    for (const { resource } of rules) {
      const found = options.connectionOf(resource);
      if (found) where.set(found.id, found);
    }
    if (where.size > 1)
      problems.push(
        `[notify-send-source] The resources that email an address they hold are on ${where.size} connections (${[...where.keys()].join(', ')}); ` +
          'their mail is queued in one integrations store, beside them, so they share one.',
      );
    for (const found of where.values())
      if (found.dialect !== 'sqlite' && found.dialect !== 'postgres')
        problems.push(
          `[notify-send-source] Connection "${found.id}" is ${found.dialect}; mail to an address a record holds is queued in the integrations store, which SQLite and PostgreSQL keep.`,
        );
  }
  /* A visitor's write mails only an address they proved with a code: where nothing proves one, every such mail is suppressed. */
  const proves = Object.values(app.views).some((view) =>
    Boolean((view as { link?: { email?: { verified?: string } } }).link?.email?.verified),
  );
  const publicWriters = new Map<string, string>();
  for (const [id, command] of Object.entries(options.commands ?? {}))
    if (command.public) for (const local of command.write) publicWriters.set(logicalResource(app, command.source, local), id);
  for (const { resource, at } of rules) {
    const writer = publicWriters.get(resource);
    if (writer && !proves)
      warnings.push(
        `[notify-send-unproven] ${at} emails an address on "${resource}", which public command "${writer}" writes; a visitor's write mails only an address ` +
          "they proved with a code in the form (a saved form's link.email.verified), so these are suppressed as unproven.",
      );
  }
  for (const { rule, at } of rules)
    if (!rule.send!.consent)
      warnings.push(
        `[notify-send-consent] ${at} names no "send.consent", so it mails only addresses that opted in, and none can before a first email: ` +
          'name the column that records the person agreed to these emails.',
      );
  return { problems, warnings };
}

/** Problems with who runs each event's command, against the loaded App's roles and grants. */
export function integrationRoleProblems(
  declared: CapturedIntegrations | undefined,
  principals: ReadonlyMap<string, readonly string[]>,
  app: AppDef,
): string[] {
  const problems: string[] = [];
  const roles = app.auth?.roles ?? {};
  for (const role of declared?.editors ?? [])
    if (!Object.hasOwn(roles, role) || roles[role].service === true)
      problems.push(`integrations.editors names "${role}", which is not a person's role in App "${app.id}": a service enters no secrets.`);
  for (const { integration, event, command, runAs } of integrationEventCommands(declared)) {
    const held = principals.get(runAs) ?? [];
    const person = held.filter((role) => !Object.hasOwn(roles, role) || roles[role].service !== true);
    if (person.length)
      problems.push(
        `[integration-service-role] principal "${runAs}" runs integrations.webhooks "${integration}" event "${event}", so every role it holds is a service role ` +
          `("service": true); ${person.map((role) => `"${role}"`).join(', ')} ${person.length === 1 ? 'is' : 'are'} not.`,
      );
    else if (!appCommandGrants(app, [...held]).has(command))
      problems.push(
        `[integration-service-role] principal "${runAs}" (roles ${held.join(', ')}) is not granted command "${command}" in App "${app.id}".`,
      );
  }
  return problems;
}

type Field = Readonly<{ name: string; required?: boolean; type: string }>;
/* The payload's fields against the command's: every one it sends is an input, and every input the command requires is sent. */
function inputMismatch(payload: ShapeDescriptor, fields: readonly Field[]): string | undefined {
  if (payload.kind !== 'object') return 'the payload is not an object of fields';
  const sent = payload.fields;
  const names = new Set(fields.map((field) => field.name));
  const extra = Object.keys(sent).filter((name) => !names.has(name));
  if (extra.length) return `the command takes no ${extra.map((name) => `"${name}"`).join(', ')}`;
  const missing = fields.filter(
    (field) => field.required === true && (!Object.hasOwn(sent, field.name) || sent[field.name].kind === 'optional'),
  );
  if (missing.length)
    return `the payload may not carry ${missing.map((field) => `"${field.name}"`).join(', ')}, which the command requires`;
  return undefined;
}
