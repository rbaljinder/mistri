/**
 * Mail to an address a record holds (`notify.send: { channel: 'email' }`),
 * on a server without tenants: the integrations store beside the rules'
 * records, where each write queued its message in its own transaction, the
 * loop that decides and sends them (integrations/integrationChannels.ts),
 * and the unsubscribe route (unsubscribe.ts), answered before any gate.
 *
 * Opened by `mistri serve` whether or not the App has commands, jobs or
 * integrations: the rule alone is what turns it on, as `email: true` turns
 * on the outbox. The store is provisioned once (`mistri migrate stores up
 * --app`), never here; a server whose store is missing or behind does not
 * start.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openIntegrationStore, type IntegrationStore } from '../../adapters/integrations/integrationStore.js';
import { EMAIL_CHANNEL } from '../../adapters/inbox/inbox.js';
import type { AppDef } from '../../shared/app.js';
import type { AppHost } from '../app/apps.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { storeTargetOf, type StoreTarget } from '../commands/appCommandEvents.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { emailChannelSender } from '../integrations/integrationChannels.js';
import type { EmailTransport } from './email.js';
import { createUnsubscribeRoute, issueUnsubscribeToken, UNSUBSCRIBE_PATH } from './unsubscribe.js';

/* Queued mail is looked at every ten seconds: a person may be waiting on it, and a write never waits for it. */
const LOOP_MS = 10_000;

/** Whether an App emails an address a record holds. */
export function appEmailsContacts(app: AppDef): boolean {
  return Object.values(app.resources ?? {}).some((resource) => resource.notify?.some((rule) => rule.send?.channel === EMAIL_CHANNEL));
}

/** Where an App's resources live: each one's connection, and its engine as far as the store cares. */
export async function contactMailPlaces(
  registry: Registry,
  host: AppHost,
  /** A connection's URL as it opens: a suite App's references resolve in its own environment. */
  locate: (id: string) => string | undefined = (id) => registry.configOf(id)?.url,
): Promise<{
  connectionOf(resource: string): { id: string; dialect: string } | undefined;
  target: StoreTarget | undefined;
}> {
  const { app } = host.app;
  const entry = appEntrypoint(host, registry);
  if (!entry) return { connectionOf: () => undefined, target: undefined };
  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, entry, (owner) => releases.push(registry.lease(owner)));
    const connectionOf = (resource: string) => {
      const id = resources.connectionFor(resource);
      const url = locate(id);
      const target = storeTargetOf(url);
      return {
        id,
        dialect: target ? ('sqlite' in target ? 'sqlite' : 'postgres') : /^mysql:/i.test(url ?? '') ? 'MySQL' : 'not a database',
      };
    };
    const first = Object.entries(app.resources ?? {}).find(([, resource]) =>
      resource.notify?.some((rule) => rule.send?.channel === EMAIL_CHANNEL),
    )?.[0];
    return {
      connectionOf,
      target: first ? storeTargetOf(locate(resources.connectionFor(first))) : undefined,
    };
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export interface ContactMail {
  /** The unsubscribe route: true when the request was its. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Decide and send what is due once: what a test drives instead of the loop. */
  tick(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

export async function openContactMail(
  options: Readonly<{
    apps: ReadonlyArray<Readonly<{ id: string; name: string; target: StoreTarget }>>;
    transport: EmailTransport;
    /** The email service's `links.secret`. */
    secret: string;
    /** The unsubscribe route's absolute address, as a mail client reaches it. */
    address: string;
    now?: () => number;
    trusted?: Parameters<typeof createUnsubscribeRoute>[0]['trusted'];
  }>,
): Promise<ContactMail> {
  const opened = new Map<
    string,
    {
      name: string;
      store: IntegrationStore;
      sender: ReturnType<typeof emailChannelSender>;
    }
  >();
  try {
    for (const app of options.apps) {
      const store = await openIntegrationStore(app.target);
      opened.set(app.id, {
        name: app.name,
        store,
        sender: emailChannelSender({
          appId: app.id,
          store,
          transport: options.transport,
          unsubscribe: (claim) => `${options.address}?token=${issueUnsubscribeToken(options.secret, claim)}`,
          ...(options.now ? { now: options.now } : {}),
        }),
      });
    }
  } catch (error) {
    await Promise.allSettled([...opened.values()].map((app) => app.store.close()));
    throw error;
  }
  const route = createUnsubscribeRoute({
    secret: options.secret,
    apps: (id) => opened.get(id),
    ...(options.now ? { now: options.now } : {}),
    ...(options.trusted ? { trusted: options.trusted } : {}),
  });
  const tick = async () => {
    let worked = false;
    for (const app of opened.values()) if (await app.sender.sendDue()) worked = true;
    return worked;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let running: Promise<unknown> | undefined;
  const loop = () => {
    if (stopping) return;
    running = tick()
      .catch(() => console.error('mistri: queued email could not be sent; it is tried again shortly.'))
      .finally(() => {
        running = undefined;
        if (!stopping) timer = setTimeout(loop, LOOP_MS);
      });
  };
  return Object.freeze({
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) =>
      url.pathname === UNSUBSCRIBE_PATH ? route.handle(req, res, url) : Promise.resolve(false),
    tick,
    start() {
      if (!timer && !running && !stopping) timer = setTimeout(loop, LOOP_MS);
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      await running;
      await Promise.allSettled([...opened.values()].map((app) => app.store.close()));
    },
  });
}
