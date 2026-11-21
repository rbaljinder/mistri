import { beforeEach, expect, test, vi } from 'vitest';
import type { SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';

/* The module holds what this tab was told (`held`), so each test starts from a fresh copy and empty stores. */
let choices: typeof import('./appChoices.js');
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  choices = await import('./appChoices.js');
});

const person = (overrides: Partial<SessionIdentitySnapshot> = {}): SessionIdentitySnapshot => ({
  mode: 'authenticated',
  epoch: 1,
  accountId: 'acct-1',
  appId: 'clinic',
  ...overrides,
});
const inTenant = (tenantId: string) =>
  person({ tenantRequired: true, tenant: { tenantId } as unknown as SessionIdentitySnapshot['tenant'] });
const choose = { site: { table: 'sites' } };

test('a pick is kept per tenant: another tenant of the same person starts with nothing picked', () => {
  const north = inTenant('north-clinic');
  const south = inTenant('south-clinic');
  expect(choices.choiceKey(north, 'site')).not.toBe(choices.choiceKey(south, 'site'));
  choices.writeChoice(north, 'site', '12');
  expect(choices.heldChoice(north, 'site')).toBe('12');
  expect(choices.heldChoice(south, 'site')).toBeNull();
  expect(choices.chosenNow(south, choose)).toEqual({});
});

test('nothing is kept for a signed-out visitor, or before a tenant App knows its tenant', () => {
  expect(choices.choiceKey(person({ mode: 'anonymous', accountId: null }), 'site')).toBeNull();
  expect(choices.choiceKey(person({ tenantRequired: true }), 'site')).toBeNull();
  choices.writeChoice(person({ tenantRequired: true }), 'site', '12');
  expect(localStorage.length + sessionStorage.length).toBe(0);
});

test('another person on this browser does not inherit a pick', () => {
  choices.writeChoice(person(), 'site', '12');
  expect(choices.heldChoice(person({ accountId: 'acct-2' }), 'site')).toBeNull();
});

test("the tab's own pick wins over the browser's last, so two tabs may work at two sites", () => {
  const key = choices.choiceKey(person(), 'site')!;
  localStorage.setItem(key, '3');
  expect(choices.readChoice(person(), 'site')).toBe('3');
  sessionStorage.setItem(key, '4');
  expect(choices.readChoice(person(), 'site')).toBe('4');
});

test('a pick tells its listeners and moves the version; forgetting clears both stores', () => {
  const told = vi.fn();
  const stop = choices.subscribeChoices(told);
  const before = choices.choicesVersion();
  choices.writeChoice(person(), 'site', '12');
  expect(told).toHaveBeenCalledOnce();
  expect(choices.choicesVersion()).toBe(before + 1);
  choices.writeChoice(person(), 'site', null);
  expect(localStorage.length + sessionStorage.length).toBe(0);
  expect(choices.heldChoice(person(), 'site')).toBeNull();
  stop();
  choices.writeChoice(person(), 'site', '5');
  expect(told).toHaveBeenCalledTimes(2);
});

test('a stored value longer than any key the server takes is no pick', () => {
  localStorage.setItem(choices.choiceKey(person(), 'site')!, 'x'.repeat(129));
  expect(choices.readChoice(person(), 'site')).toBeNull();
});

test('only declared choices are sent', () => {
  choices.writeChoice(person(), 'site', '12');
  choices.writeChoice(person(), 'region', '3');
  expect(choices.chosenNow(person(), choose)).toEqual({ site: '12' });
  expect(choices.chosenNow(person(), undefined)).toEqual({});
});

test("the account menu's entries: each chooser takes back only its own", () => {
  const a = { choice: 'site', word: 'Site:', name: 'Northside', open: () => {} };
  const b = { choice: 'region', word: 'Region:', name: 'East', open: () => {} };
  choices.setChoiceEntry(a);
  choices.setChoiceEntry(b);
  const replaced = { ...a, name: 'Southside' };
  choices.setChoiceEntry(replaced, a);
  expect(choices.choiceEntries().map((entry) => entry.name)).toEqual(['East', 'Southside']);
  choices.setChoiceEntry(undefined, replaced);
  expect(choices.choiceEntries()).toEqual([b]);
});

test('where the server keeps picks, they are the default and only a deviation is sent', () => {
  const picks = { site: '12' };
  expect(choices.readChoice(person(), 'site', picks)).toBe('12');
  expect(choices.chosenNow(person(), choose, picks)).toEqual({});
  choices.writeChoice(person(), 'site', '7', true);
  expect(choices.heldChoice(person(), 'site', picks)).toBe('7');
  expect(choices.chosenNow(person(), choose, picks)).toEqual({ site: '7' });
  /* Nothing is kept in the browser for later: the server holds it. */
  expect(localStorage.length).toBe(0);
});
