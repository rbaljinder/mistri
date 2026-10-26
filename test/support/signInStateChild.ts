/**
 * One instance of a deployment, in its own process, for
 * sign-in-state-processes.test.ts: an App with a saved form whose status check
 * steps up by email, its business database and mail log in the directory
 * given, and the cache at the URL given — configured as serve configures a
 * deployment that names a cache (cli/apps.ts). Prints its port, then serves
 * until killed.
 */
import { once } from 'node:events';
import { join } from 'node:path';
import type { AppHost } from '../../packages/mistri/src/server/app/apps.js';
import { configureSignInState } from '../../packages/mistri/src/server/auth/signInState.js';
import { Registry } from '../../packages/engine/src/server/connections.js';
import { createApp } from './createApp.js';
import { configurePublicFormLimits } from '../../packages/engine/src/server/http/rateLimit.js';
import { parseTrustedProxies } from '../../packages/engine/src/server/http/trust.js';
import { defineCommand, defineCommands } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape, text } from '../../packages/mistri/src/server/commands/commandShapes.js';
import { publicReference, publicReferencePattern } from '../../packages/mistri/src/server/forms/publicReference.js';
import { emailConnectionOf } from '../../packages/mistri/src/server/email/email.js';
import { serviceConnectionOf } from '../../packages/engine/src/server/configSections.js';
import { CONFIG_SECTIONS } from '../../packages/mistri/src/server/serviceConnections.js';
import { parseTestApp } from './commandCatalog.js';

const [directory, cacheURL] = process.argv.slice(2);
const aboutInput = { last_name: { label: 'Last name', type: 'text', max: 60 }, email: { label: 'Email', type: 'text', max: 200 } } as const;
const submitInput = { consent: { label: 'These details are true', type: 'boolean' } } as const;
const reference = (id: string, input: object) => ({ id, version: 1, input });
const commands = defineCommands({
  startApplication: defineCommand({
    targets: 'none',
    source: 'main',
    target: 'application',
    read: ['application'],
    write: ['application'],
    public: true,
    input: aboutInput,
    output: shape({ message: literal('Saved.') }),
    async handle({ db, draft }, input) {
      if (!draft) return refuse('forbidden');
      if (draft.root) await db.application.update(await db.application.get(draft.root), input);
      else await db.application.insert({ ...input, ...draft.start });
      return { message: 'Saved.' as const };
    },
  }),
  submitApplication: defineCommand({
    targets: 'none',
    source: 'main',
    target: 'application',
    read: ['application'],
    write: ['application'],
    public: true,
    input: submitInput,
    output: shape({ reference: text({ pattern: publicReferencePattern('APP') }), message: literal('Received.') }),
    async handle({ db, draft }) {
      const receipt = publicReference('APP');
      await db.application.update(await db.application.get(draft!.root!), { status: 'submitted', reference: receipt });
      return { reference: receipt, message: 'Received.' as const };
    },
  }),
});

const registry = new Registry();
registry.add({ id: 'private-db', name: 'Private', url: join(directory, 'apply.db'), writable: true, source: 'config' });
registry.addService(
  emailConnectionOf({ name: 'mail', kind: 'email', url: 'log:mail.log', from: 'Lending <no-reply@example.test>' }, 'test', directory),
);
registry.addService(serviceConnectionOf(CONFIG_SECTIONS, { name: 'cache', kind: 'cache', url: cacheURL, insecure: true }, 'test'));
configurePublicFormLimits(registry.cache(), 'lending');
configureSignInState(registry.cache(), 'lending');
const app = parseTestApp(
  {
    id: 'lending',
    name: 'Lending',
    auth: { roles: { officer: { read: true } } },
    sources: { main: { connection: 'private-db' } },
    resources: { application: { access: 'write' } },
    views: {
      applications: { kind: 'list', from: 'application' },
      apply: {
        kind: 'form',
        label: 'Apply',
        public: true,
        command: reference('submitApplication', submitInput),
        steps: [{ id: 'about-you', label: 'About you', command: reference('startApplication', aboutInput) }],
        resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress' },
        draft: { status: 'in_progress' },
        statusCheck: {
          receipt: 'reference',
          confirm: { last_name: 'Last name' },
          show: ['status'],
          says: { status: { submitted: 'Received' } },
          stepUp: { email: 'email', show: ['last_name'] },
        },
      },
    },
    home: 'applications',
    nav: ['applications'],
  },
  'sign-in state child',
);
const host: AppHost = {
  app: { app, path: '/private/app.ts', pages: [], sources: {} },
  pages: [],
  auth: {
    spec: app.auth!,
    store: '/private/auth.db',
    close() {},
    handler: async (_req, res) => {
      res.writeHead(200);
      res.end('{}');
    },
    session: async () => null,
  },
};
// The test speaks for many visitors through one loopback proxy, each with its own address.
const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies(['127.0.0.1']).ranges };
const server = createApp({ registry, bound, apps: [host], commands: { appId: 'lending', registry: commands } });
server.listen(0, bound.host);
await once(server, 'listening');
process.stdout.write(`${(server.address() as { port: number }).port}\n`);
