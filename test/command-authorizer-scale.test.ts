/**
 * A large App's command authorizer binds in well under a second and decides
 * exactly as the grant rules say. It once re-checked the App's whole policy
 * for every command, role and request: a tenant App of ~900 commands took
 * about 18 s per authorizer, and a server builds several at startup.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appCommandGrants, resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { createBusinessCommandAuthorizer } from '../packages/mistri/src/server/commands/businessCommandAuthorization.js';
import { BusinessCommandDefinitionError, callerRead } from '../packages/mistri/src/server/commands/businessCommands.js';
import { judgesSecret, largeCommandApp } from './support/largeCommandApp.js';
import { roles } from './support/appCeilings.js';

test('a 900-command App binds quickly and every decision is the grant rule’s', () => {
  const f = largeCommandApp();
  const started = performance.now();
  const authorizer = createBusinessCommandAuthorizer(f.options);
  // About 0.1 s here; the bound is generous so a loaded machine still passes, and far below the 18 s it was.
  assert.ok(performance.now() - started < 5_000, `bound in ${(performance.now() - started).toFixed(0)} ms`);
  const sets = [...f.roles.map((role) => [role]), ['role1', 'role7'], ['role3', 'role9', 'nobody'], ['nobody'], [], f.roles];
  let allowed = 0,
    refused = 0;
  for (const roleSet of sets) {
    // The rule, read from the public functions once per set of roles.
    const grants = appCommandGrants(f.app, roleSet);
    const readable = resolveAppAccess(f.app, f.schema, roleSet).readable;
    for (const id of [...f.commands, 'missing']) {
      const command = f.registry[id];
      const expected = command !== undefined && grants.has(id) && callerRead(command).every((table) => readable.has(table));
      let decided: boolean;
      try {
        const authorized = authorizer.authorize(id, { id: 'person', appId: 'large', roles: roleSet });
        assert.equal(authorized.resource, command.target);
        assert.deepEqual(authorized.keyColumns, ['id']);
        decided = true;
      } catch (error) {
        assert.ok(error instanceof AppAccessDenied, `${id} for ${roleSet.join(',')}: ${(error as Error).message}`);
        decided = false;
      }
      assert.equal(decided, expected, `${id} for [${roleSet.join(', ')}]`);
      if (decided) allowed++;
      else refused++;
    }
  }
  // The table exercises both answers, and the half-reading role is refused a command it is granted.
  assert.ok(allowed > 1_000 && refused > 1_000, `${allowed} allowed, ${refused} refused`);
  const partial = appCommandGrants(f.app, ['role7']);
  assert.ok(
    f.commands.some(
      (id) =>
        partial.has(id) &&
        (() => {
          try {
            authorizer.authorize(id, { id: 'person', appId: 'large', roles: ['role7'] });
            return false;
          } catch {
            return true;
          }
        })(),
    ),
  );
});

test('a large App is still refused at startup for what a role is granted', () => {
  // A role kept from a column is granted a command whose `when` judges it.
  const hidden = largeCommandApp({ commands: 120 });
  const judging = hidden.commands.find((_, index) => judgesSecret(index) && index % 3 === 0)!;
  roles(hidden.app).role1.commands = [...(roles(hidden.app).role1.commands ?? []), judging];
  assert.throws(
    () => createBusinessCommandAuthorizer(hidden.options),
    (error: Error) =>
      error instanceof BusinessCommandDefinitionError &&
      error.message.includes(`"${judging}" is granted to role "role1", which does not read`),
  );
  // A role granted a command the registry does not hold.
  const unknown = largeCommandApp({ commands: 120 });
  roles(unknown.app).role2.commands = [...(roles(unknown.app).role2.commands ?? []), 'c9999'];
  assert.throws(() => createBusinessCommandAuthorizer(unknown.options), /Access grants an unregistered command: "c9999"/);
  // A role edits in place, with no word on which columns, a table commands write.
  const edited = largeCommandApp({ commands: 120 });
  roles(edited.app).role2.write = ['r00'];
  assert.throws(
    () => createBusinessCommandAuthorizer(edited.options),
    /writes "r00", which role "role2" also edits in place \[command-and-edit\]/,
  );
});
