/**
 * A large tenant App checks itself once per thing it checks, not once per
 * command and role. A field report's App — a few hundred tables, about a
 * hundred and fifty commands, ten roles — took one to two and a half minutes
 * to open its port on half a CPU, nearly all of it startup validation doing
 * the same work again: a role's access resolved again for every authorizer
 * and command, the catalog a command's reads bound made again for every
 * action that names it, the same tables found by a scan for every role,
 * command and resource. Wall-clock bounds flake on a loaded machine, so this
 * holds the counts: each piece of derived work is made once per distinct
 * input — a footprint, a set of roles — and every refusal still refuses.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { rowScopeCounters } from '../packages/engine/src/shared/rowScope.js';
import { pruneCounters } from '../packages/mistri/src/server/app/appAccess.js';
import { accessCounters } from '../packages/mistri/src/server/commands/businessCommandAuthorization.js';
import { boundedCatalogCounters } from '../packages/mistri/src/server/commands/businessCommandReferenceChecks.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { tenantReadCounters } from '../packages/mistri/src/server/tenant/tenantReadRuntime.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { largeTenantApp, type LargeTenantShape } from './support/largeTenantApp.js';

async function enrolled<T>(
  shape: LargeTenantShape,
  use: (f: ReturnType<typeof largeTenantApp>, directory: string) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'tenant-startup-scale-'));
  try {
    return await use(largeTenantApp(directory, shape), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a large tenant App derives each catalog and access once, however many commands and roles ask', async () => {
  await enrolled({ tables: 250, commands: 150, roles: 10, reads: 30 }, async (f) => {
    const footprints = new Set(Object.values(f.registry).map((command) => JSON.stringify([...command.read].sort()))).size;
    const before = { pruned: pruneCounters.pruned, made: boundedCatalogCounters.made, resolved: accessCounters.resolved };
    const enrollment = await createTenantEnrollment(f.options);
    try {
      const made = boundedCatalogCounters.made - before.made;
      const resolved = accessCounters.resolved - before.resolved;
      const pruned = pruneCounters.pruned - before.pruned;
      /* Three hundred references (each command's action, and its input's picker) over these footprints, checked by
         two owners: made per reference, as it was, this was three hundred catalogs, each a prune and a reading of
         every resource's rollups, tabs and computed columns. */
      assert.ok(made <= footprints, `${made} bounded catalogs for ${footprints} footprints`);
      /* Each role alone, and every declared role together: shared by the tenant's and the platform's authorizers. */
      assert.ok(resolved <= f.roles.length + 1, `${resolved} role resolutions for ${f.roles.length} roles`);
      assert.ok(
        pruned <= footprints + f.roles.length,
        `${pruned} catalogs pruned for ${footprints} footprints and ${f.roles.length} roles`,
      );
    } finally {
      await enrollment.retire();
    }
  });
});

test('a large tenant App is still refused at startup for what a role is granted', async () => {
  /* c000 is granted to role1, which is kept from `secret` on its tables: a `when` that judges it would say it. */
  await enrolled(
    { tables: 60, commands: 40, roles: 4, reads: 10, whenOf: (index) => (index === 0 ? "secret = 'x'" : undefined) },
    async (f) => {
      await assert.rejects(createTenantEnrollment(f.options), (error: Error) => {
        const said = [error.message, ...refusalReasons(error)].join('\n');
        assert.match(said, /Command "c000" is granted to role "role1", which does not read a column of "t000" its "when" judges/);
        return true;
      });
    },
  );
});

/* A request reads under a grant its roles resolve and a scope its person
   composes. Each was made again per request and checked again at every layer
   and statement it crossed — a field report's profile of a page on a large
   App put the grant, its pruning and the scope's copies among its largest
   costs. Counted, as above: a role set's grant is resolved once per
   deployment, its catalog pruned once, and a request checks its
   scope a fixed number of times however many reads it makes. */
test('a large tenant App resolves a role set once and checks a scope per request, not per read', async () => {
  await enrolled({ tables: 250, commands: 150, roles: 10, reads: 30 }, async (f, directory) => {
    const tenantRoles = f.roles.slice(0, 2);
    const db = new DatabaseSync(join(directory, 'business.db'));
    try {
      for (const [index, tenant] of ['north', 'south'].entries()) {
        db.prepare(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES (?, 'active', '1', 'tenant')`).run(tenant);
        db.prepare(`INSERT INTO "${TENANT_TABLES.membership}" VALUES (?, ?, 'ada', 'active', '1', ?, ?, 'member', NULL, NULL, NULL)`).run(
          `${tenant}-ada`,
          tenant,
          JSON.stringify([tenantRoles[index]]),
          Date.now() + 3_600_000,
        );
      }
    } finally {
      db.close();
    }
    const enrollment = await createTenantEnrollment(f.options);
    try {
      const table = f.tables[0];
      const read = (tenant: string, reads: number) =>
        enrollment.deployment.withContext({}, [tenant], async ({ data }) => {
          for (let i = 0; i < reads; i++) await data.query({ table, limit: 5, offset: 0 });
          return true;
        });
      // Warm: the first request of each role set resolves its grant and prunes its catalog.
      await read('north', 1);
      await read('south', 1);
      const before = {
        grants: tenantReadCounters.grants,
        pruned: pruneCounters.pruned,
        checked: rowScopeCounters.checked,
      };
      await read('north', 1);
      const one = rowScopeCounters.checked - before.checked;
      await read('north', 8);
      const eight = rowScopeCounters.checked - before.checked - one;
      for (let i = 0; i < 10; i++) await read(i % 2 ? 'north' : 'south', 2);
      assert.equal(tenantReadCounters.grants - before.grants, 0, 'a role set already resolved is not resolved again');
      assert.equal(pruneCounters.pruned - before.pruned, 0, 'a kept grant does not prune its catalog again');
      assert.equal(eight, one, `a request of eight reads checked its scope ${eight} times, one of one read ${one}`);
      // The policy's two answers as they arrive, their composition, and its binding to the physical catalog: a few, and fixed.
      assert.ok(one <= 5, `${one} scope checks for one request`);
    } finally {
      await enrollment.retire();
    }
  });
});
