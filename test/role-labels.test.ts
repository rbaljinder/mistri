/**
 * `auth.roles.<id>.label`: the role's name as people read it. It is words
 * only — parsed, sent with the sign-in answer, drawn by every screen that
 * names a role — and `check` says which roles shown to people have none.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appRoleWarnings } from '../packages/mistri/src/server/app/appRoleChecks.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { roleLabelsOf } from '../packages/mistri/src/shared/appModel.js';
import { resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { roleName } from '../packages/mistri/src/client/tenantNames.js';
import { setRoleLabels } from '../packages/kit/src/client/roleLabels.js';
import { parseTestApp } from './support/commandCatalog.js';

const schema = {
  label: 'desk',
  dialect: 'sqlite',
  readAt: '2026-10-01T00:00:00Z',
  foreignKeys: [],
  tables: [{ id: 'ticket', name: 'ticket', schema: 'main', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] }],
} as unknown as DatabaseSchema;
const desk = (roles: Record<string, unknown>) =>
  parseTestApp(
    {
      id: 'desk',
      name: 'Desk',
      resources: { ticket: {} },
      auth: { roles },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
      nav: ['tickets'],
    },
    'role label fixture',
  );

test('a label is words only: kept beside the grant, sent in the sign-in answer, and it grants nothing', () => {
  const app = desk({ loan_officer: { label: 'Loan officer', read: true }, auditor: { read: true } });
  assert.equal(app.auth!.roles!.loan_officer.label, 'Loan officer');
  assert.deepEqual(roleLabelsOf(app.auth), { roleLabels: { loan_officer: 'Loan officer' } });
  assert.deepEqual(roleLabelsOf(desk({ auditor: { read: true } }).auth), {});
  const plain = desk({ loan_officer: { read: true } });
  assert.deepEqual(
    [...resolveAppAccess(app, schema, ['loan_officer']).readable],
    [...resolveAppAccess(plain, schema, ['loan_officer']).readable],
  );
});

test('a label that is not a short name is refused, naming the role', () => {
  for (const label of ['', ' Officer', 'x'.repeat(61), 'Line\nbreak', 7]) {
    assert.throws(
      () => desk({ officer: { label, read: true } }),
      /role "officer", "label" is the role's name as people read it/,
      JSON.stringify(label),
    );
  }
});

test('check names each role without a label, and only those', () => {
  const app = desk({ loan_officer: { label: 'Loan officer', read: true }, auditor: { read: true } });
  const loaded = { app, path: '/apps/desk/app.ts', pages: [], sources: {} } as unknown as LoadedApp;
  assert.deepEqual(
    appRoleWarnings(loaded, schema).filter((line) => line.includes('[role-label]')),
    [
      'app.ts: role "auditor" [role-label]: it has no "label", so the screens that name it to people say "Auditor". Give it the name people know it by: roles.auditor.label.',
    ],
  );
});

test("a screen says the App's label for a role, and the id made words where there is none", () => {
  setRoleLabels({ loan_officer: 'Underwriter', bad: 'x\u0000y' });
  try {
    assert.equal(roleName('loan_officer'), 'Underwriter');
    assert.equal(roleName('branch_viewer'), 'Branch viewer');
    assert.equal(roleName('bad'), 'Bad', 'a malformed label is ignored');
  } finally {
    setRoleLabels(undefined);
  }
  assert.equal(roleName('loan_officer'), 'Loan officer', 'the id made words again');
});

/* The bootstrapped account (MISTRI_AUTH_ADMIN_EMAIL) holds `admin`; an App whose roles leave `admin` out signs
   it in to "This database has no tables", with both checks green. */
test('check warns when roles grant nothing to admin, the role the first account holds', () => {
  const without = desk({ manager: { label: 'Manager', read: true } });
  const loaded = { app: without, path: '/apps/desk/app.ts', pages: [], sources: {} } as unknown as LoadedApp;
  const warned = appRoleWarnings(loaded, schema).filter((line) => line.includes('[admin-grants-nothing]'));
  assert.equal(warned.length, 1);
  assert.match(warned[0], /MISTRI_AUTH_ADMIN_EMAIL/);
  assert.match(warned[0], /roles\.admin/);
  const withAdmin = desk({ admin: { label: 'Administrator', read: true }, manager: { label: 'Manager', read: true } });
  assert.deepEqual(
    appRoleWarnings({ ...loaded, app: withAdmin } as LoadedApp, schema).filter((line) => line.includes('[admin-grants-nothing]')),
    [],
  );
});
