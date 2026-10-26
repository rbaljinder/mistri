/**
 * `support: 'refuse'` on a command, and the principal marker it answers.
 *
 * Commands are allowed under a support session by default — a session exists to
 * get the dealer's work done, and every change it makes is recorded beside it
 * (test/tenant-support-write-audit.test.ts). An App withholds one anyway when
 * its consequence leaves the dealer's own records. This suite pins the option's
 * shape, and that the authorizer is where it is answered.
 *
 * The marker is not a caller's word: `authorize` rebuilds the principal from an
 * explicit set of properties, so a forged one reaches nothing. These tests hand
 * it in directly, as the suites for public and service principals do, because
 * the runtime that would set it from support evidence is a later slice.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import {
  createBusinessCommandAuthorizer,
  type BusinessCommandAuthorizationOptions,
} from '../packages/mistri/src/server/commands/businessCommandAuthorization.js';
import {
  BusinessCommandDefinitionError,
  defineCommand,
  defineCommands,
  type BusinessCommandActor,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/* defineCommand takes no `id`: the registry key names the command. `input` is
   a record of declared fields, `output` a parser for the handler's return. */
const input = { note: { label: 'Note', type: 'text', max: 120 } } as const;
const output = { parse: (value: unknown) => ({ version: (value as { version: number }).version }) };
const base = {
  source: 'main',
  target: 'lead',
  read: ['lead'],
  write: ['lead'],
  input,
  output,
  handle: () => ({ version: 1 }),
} as never;
const define = (patch: Record<string, unknown>) => defineCommand({ ...(base as object), ...patch } as never);
const refusal = (patch: Record<string, unknown>): string => {
  try {
    define(patch);
  } catch (error) {
    assert.ok(error instanceof BusinessCommandDefinitionError, `not a definition refusal: ${String(error)}`);
    return (error as Error).message;
  }
  assert.fail(`defined: ${JSON.stringify(patch)}`);
};

test('a command may withhold itself from an operator inside a dealer, and says so in one word', () => {
  const withheld = define({ support: 'refuse' }) as unknown as { support?: string };
  assert.equal(withheld.support, 'refuse');
  // Allowed is what a command already is under support, so there is no second
  // word to write and no way to spell one.
  const ordinary = define({}) as unknown as { support?: string };
  assert.equal(ordinary.support, undefined);
  for (const value of ['allow', 'refused', true, false, null, '']) {
    assert.match(refusal({ support: value }), /Command support must be "refuse" when present\./);
  }
});

test('a platform-realm command takes no support option: it is already refused for the whole account', () => {
  assert.match(
    refusal({ realm: 'platform', support: 'refuse' }),
    /already refused while its account is inside a dealer, so it takes no support option\./,
  );
  // Without the option it still defines, so the refusal is about the pair.
  assert.equal((define({ realm: 'platform' }) as unknown as { realm?: string }).realm, 'platform');
});

test('an unknown option is still named rather than ignored', () => {
  assert.match(refusal({ supported: 'refuse' }), /unknown option: supported\./);
});

/* ---------- what the option does, at the boundary that answers it ---------- */

/** One registry with a withheld command and an ordinary one, so a refusal can
 * be shown to be about the marked principal and this command, not about either
 * alone. */
function authorizer() {
  const schema: DatabaseSchema = {
    label: 'Private',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: ['lead'].map((id) => ({
      id,
      name: id,
      schema: '',
      isView: false,
      columns: ['id', 'tenant_id', 'value'].map((name) => ({ name, type: 'TEXT', nullable: false, primaryKey: name === 'id' })),
    })),
  };
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      auth: { roles: { dealer_staff: { read: true, commands: ['payOut', 'addNote'] } } },
      sources: { business: { connection: 'private' } },
      resources: { lead: { access: 'write' } },
      views: { leads: { kind: 'list', from: 'lead' } },
      home: 'leads',
    },
    'support refusal fixture',
  );
  /* The authorizer binds against the schema above, which has
     no such column, and the command needs none to be authorized. */
  const shape = {
    source: 'business',
    target: 'lead',
    read: ['lead'],
    write: ['lead'],
    input: { note: { label: 'Note', type: 'text', optional: true } },
    output: { parse: (value: unknown) => value },
  } as never;
  const options: BusinessCommandAuthorizationOptions = {
    app,
    schema,
    registry: defineCommands({
      payOut: defineCommand({ ...(shape as object), support: 'refuse', handle: () => ({ ok: true }) } as never),
      addNote: defineCommand({ ...(shape as object), handle: () => ({ ok: true }) } as never),
    }),
    connectionFor: () => 'private',
    writableConnection: () => true,
    transactionalConnection: () => true,
    managedOwnership: { lead: 'tenant_id' },
  };
  return createBusinessCommandAuthorizer(options);
}
const member: BusinessCommandActor = { id: 'sam', appId: 'app', roles: ['dealer_staff'] };
const operator: BusinessCommandActor = { ...member, id: 'olivia', support: true };

test('a withheld command refuses the operator inside the dealer, and no one else', () => {
  const authorize = authorizer();
  // The dealer's own member runs it: the option withholds it from the lender's
  // operator, and narrows nothing for the dealer.
  assert.equal(authorize.authorize('payOut', member).command.support, 'refuse');
  // The operator is refused that one, and still runs the rest of the dealer's work.
  assert.throws(() => authorize.authorize('payOut', operator), AppAccessDenied);
  assert.equal(authorize.authorize('addNote', operator).actor.support, true);
  // The marker survives the rebuild, which is the only reason it can be read
  // above: a principal is reconstructed from known properties, never adopted.
  assert.equal(authorize.authorize('addNote', member).actor.support, undefined);
});

test('a forged or incoherent marker is refused rather than quietly ignored', () => {
  const authorize = authorizer();
  // Anything but true is malformed.
  for (const support of [false, 'yes', 1, null]) {
    assert.throws(() => authorize.authorize('addNote', { ...member, support } as unknown as BusinessCommandActor), AppAccessDenied);
  }
  // A public or service principal is never inside a dealer.
  assert.throws(
    () =>
      authorize.authorize('addNote', {
        id: 'service:nightly',
        appId: 'app',
        roles: ['dealer_staff'],
        kind: 'service',
        support: true,
      } as BusinessCommandActor),
    AppAccessDenied,
  );
});
