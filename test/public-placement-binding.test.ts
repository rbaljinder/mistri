/** Bindings survive restarts and remaps for receipt-only recovery, never new writes. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  createPublicPlacementBindingIssuer,
  PublicPlacementBindingError,
} from '../packages/mistri/src/server/forms/publicPlacementBinding.js';

const start = Date.parse('2026-09-30T12:00:00Z');
const hour = 60 * 60 * 1000;
const placement = {
  appId: 'site',
  form: 'apply',
  commandId: 'applyForFinance',
  commandVersion: 1,
  sourceIdentity: 'database-owner-1',
  tenant: 'north',
  host: 'north.example',
  origin: 'https://north.example',
  epoch: 'epoch-1',
  formRevision: 'form-1',
};
const configuration = () => ({
  issuerId: 'suite-1',
  activeKey: 'key-1',
  keys: [{ id: 'key-1', secret: randomBytes(32).toString('base64url'), issueFrom: start }],
});
const recovery = { appId: 'site', form: 'apply' };
const refuses = (run: () => unknown, code = 'forbidden') =>
  assert.throws(run, (error) => {
    assert.ok(error instanceof PublicPlacementBindingError);
    assert.equal(error.code, code);
    assert.equal(error.message, 'The public form placement could not be verified.');
    assert.equal(error.cause, undefined);
    return true;
  });

test('public binding captures operator keys and placement, survives restart and generates unique operation keys', () => {
  const config = configuration(),
    issuer = createPublicPlacementBindingIssuer(config, () => start);
  const input = { ...placement },
    issued = issuer.issue(input);
  input.tenant = 'south';
  const original = issuer.verifyExecution(issued.binding, issued.submission, placement);
  assert.ok(Object.isFrozen(original));
  assert.ok(Object.isFrozen(issued));
  assert.equal(original.tenant, 'north');
  assert.equal(issued.expiresAt, new Date(start + 2 * hour).toISOString());
  assert.equal(issued.recoverUntil, new Date(start + 24 * hour).toISOString());
  assert.equal(
    createPublicPlacementBindingIssuer(config, () => start).verifyRecovery(issued.binding, issued.submission, recovery).tenant,
    'north',
  );
  config.keys[0].secret = randomBytes(32).toString('base64url');
  assert.equal(issuer.verifyExecution(issued.binding, issued.submission, placement).tenant, 'north');
  refuses(() => createPublicPlacementBindingIssuer(config, () => start).verifyRecovery(issued.binding, issued.submission, recovery));
  const operations = Array.from({ length: 100 }, () => issuer.issue(placement));
  assert.equal(new Set(operations.map((value) => value.submission)).size, 100);
  assert.equal(new Set(operations.map((value) => value.binding)).size, 100);
  for (const value of operations) {
    assert.ok(value.binding.length <= 4096);
    assert.ok(!value.binding.includes('north.example'));
  }
});

test('binding authentication refuses tampering, swapped submission, foreign issuer, App, form and origin', () => {
  const config = configuration(),
    issuer = createPublicPlacementBindingIssuer(config, () => start);
  const issued = issuer.issue(placement),
    other = issuer.issue(placement);
  for (const binding of [
    '',
    'a'.repeat(4097),
    issued.binding + '=',
    issued.binding.replace(/^pp1/, 'pp2'),
    ...[1, 2, 3, 4].map((index) => {
      const parts = issued.binding.split('.');
      parts[index] = (parts[index][0] === 'a' ? 'b' : 'a') + parts[index].slice(1);
      return parts.join('.');
    }),
  ])
    refuses(() => issuer.verifyRecovery(binding, issued.submission, recovery));
  refuses(() => issuer.verifyRecovery(issued.binding, other.submission, recovery));
  refuses(() =>
    createPublicPlacementBindingIssuer({ ...config, issuerId: 'other-suite' }, () => start).verifyRecovery(
      issued.binding,
      issued.submission,
      recovery,
    ),
  );
  for (const expected of [
    { ...placement, appId: 'foreign' },
    { ...placement, form: 'other' },
    { ...placement, origin: 'https://north.example:8443' },
    { ...placement, host: 'south.example', origin: 'https://south.example' },
  ]) {
    refuses(() => issuer.verifyExecution(issued.binding, issued.submission, expected));
  }
  refuses(() => issuer.verifyRecovery(issued.binding, issued.submission, { appId: 'other', form: 'apply' }));
});

test('remapping or replacing command/source/form refuses execution but retains original receipt identity', () => {
  const issuer = createPublicPlacementBindingIssuer(configuration(), () => start),
    issued = issuer.issue(placement);
  for (const expected of [
    { ...placement, tenant: 'south' },
    { ...placement, epoch: 'epoch-2' },
    { ...placement, commandVersion: 2 },
    { ...placement, sourceIdentity: 'replacement-db' },
    { ...placement, formRevision: 'form-2' },
  ]) {
    refuses(() => issuer.verifyExecution(issued.binding, issued.submission, expected), 'placement_changed');
  }
  const original = issuer.verifyRecovery(issued.binding, issued.submission, recovery);
  assert.equal(original.sourceIdentity, placement.sourceIdentity);
  assert.equal(original.epoch, placement.epoch);
  assert.equal(original.commandVersion, 1);
  assert.equal(original.tenant, 'north');
});

test('execution and recovery expire independently without sliding renewal; future-issued claims fail closed', () => {
  let now = start;
  const issuer = createPublicPlacementBindingIssuer(configuration(), () => now),
    issued = issuer.issue(placement);
  now = start + 2 * hour;
  refuses(() => issuer.verifyExecution(issued.binding, issued.submission, placement), 'placement_expired');
  assert.equal(issuer.verifyRecovery(issued.binding, issued.submission, recovery).recoverBefore, start + 24 * hour);
  now = start + 24 * hour;
  refuses(() => issuer.verifyRecovery(issued.binding, issued.submission, recovery));
  now = start - 120001;
  refuses(() => issuer.verifyRecovery(issued.binding, issued.submission, recovery));
});

test('rotation only issues on the active key and retains the previous key for old receipts', () => {
  const old = configuration(),
    original = createPublicPlacementBindingIssuer(old, () => start).issue(placement);
  const replacement = {
    issuerId: old.issuerId,
    activeKey: 'key-2',
    keys: [
      { ...old.keys[0], issueUntil: start + hour },
      { id: 'key-2', secret: randomBytes(32).toString('base64url'), issueFrom: start + hour },
    ],
  };
  const issuer = createPublicPlacementBindingIssuer(replacement, () => start + hour);
  assert.equal(issuer.verifyRecovery(original.binding, original.submission, recovery).tenant, 'north');
  assert.match(issuer.issue(placement).binding, /^pp1\.key-2\./);
  const revoked = createPublicPlacementBindingIssuer({ ...replacement, keys: [replacement.keys[1]] }, () => start + hour);
  refuses(() => revoked.verifyRecovery(original.binding, original.submission, recovery));
  const beforeKey = createPublicPlacementBindingIssuer(replacement, () => start);
  refuses(() => beforeKey.issue(placement));
});

test('closed declaration capture rejects accessors, invalid keys, oversize rings and extra placement claims', () => {
  const config = configuration();
  for (const keys of [
    [],
    [...config.keys, ...config.keys],
    [...config.keys, ...config.keys, ...config.keys],
    [{ ...config.keys[0], secret: 'short' }],
    [{ ...config.keys[0], id: '../key' }],
    [{ ...config.keys[0], issueFrom: NaN }],
  ]) {
    refuses(() => createPublicPlacementBindingIssuer({ ...config, keys }));
  }
  let read = false;
  const dangerous = Object.defineProperty({ ...config }, 'keys', {
    enumerable: true,
    get() {
      read = true;
      return config.keys;
    },
  });
  refuses(() => createPublicPlacementBindingIssuer(dangerous));
  assert.equal(read, false);
  const issuer = createPublicPlacementBindingIssuer(config, () => start);
  for (const input of [
    { ...placement, email: 'private@example.test' },
    { ...placement, tenant: '' },
    { ...placement, commandVersion: 0 },
    { ...placement, host: 'south.example' },
    { ...placement, origin: 'http://north.example' },
    { ...placement, tenant: 'x'.repeat(1025) },
  ]) {
    refuses(() => issuer.issue(input));
  }
});
