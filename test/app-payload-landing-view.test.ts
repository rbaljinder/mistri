/**
 * The `/api/app` payload's landing view key: servedApp names the App's
 * landing view where it declares one, and names none where it declares
 * none — so PublicHome matches its home against the payload instead of
 * probing `/api/landing`, which answered 404 for a form-home App with no
 * landing. Additive only: no existing payload key changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import { parseTestApp } from './support/commandCatalog.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const WHERE = 'test/app.json';

const col = (name: string) => ({ name, type: 'text', nullable: true, primaryKey: false });
const SCHEMA: DatabaseSchema = {
  label: 'demo',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      name: 'loan',
      schema: '',
      id: 'loan',
      columns: [{ ...col('id'), primaryKey: true }, col('name')],
      isView: false,
    },
  ],
  foreignKeys: [],
};

const base: Record<string, unknown> = {
  name: 'Loans',
  auth: { providers: ['email'], roles: { viewer: { read: true, write: false } } },
  sources: { lending: { connection: 'loans' } },
  resources: { loan: {} },
  views: {
    loans: { kind: 'list', from: 'loan' },
    finance: {
      kind: 'form',
      label: 'Apply',
      public: true,
      steps: [{ id: 'you', label: 'You', fields: ['applicant'] }],
      command: { id: 'apply', version: 1, input: { applicant: { label: 'Name', type: 'text' } } },
    },
  },
  home: 'loans',
  nav: ['loans'],
};

test('servedApp names the landing view where the App declares a landing', () => {
  const app = parseTestApp(
    {
      ...base,
      views: {
        ...(base.views as object),
        welcome: { kind: 'landing', hero: { heading: 'Finance your next car', actions: [{ label: 'Apply', to: 'finance' }] } },
      },
      home: [{ view: 'welcome', signedOut: true }, { view: 'loans' }],
    },
    WHERE,
  );
  assert.equal(servedApp(app, SCHEMA).landingView, 'welcome');
});

test('servedApp names no landing view where the App declares none', () => {
  const app = parseTestApp(base, WHERE);
  assert.equal(servedApp(app, SCHEMA).landingView, undefined);
});
