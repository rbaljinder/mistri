import { beforeEach, expect, test, vi } from 'vitest';
import { loadJson, saveJson } from './core.js';
import { draftRecovery } from './draftRecovery.js';
import { establishSessionIdentity, lockSessionIdentity, sessionStorageKey } from './sessionIdentity.js';

const account = (accountId = 'alice', appId = 'atlas') => ({ signedIn: true, accountId, appId });
const key = 'mistri.history.v1';
const draftKey = 'mistri.pages.draft.atlas.incident';
const original = { name: 'Incident' };
const draft = { name: 'Private draft' };
const decode = (value: unknown): { name: string } | undefined =>
  value && typeof value === 'object' && 'name' in value && typeof value.name === 'string' ? { name: value.name } : undefined;
beforeEach(() => localStorage.clear());

test('JSON storage isolates account and App, with no authenticated reads or writes of unscoped keys', () => {
  localStorage.setItem(key, JSON.stringify(['Legacy query']));
  establishSessionIdentity(account());
  expect(loadJson(key, [])).toEqual([]);
  expect(saveJson(key, ['Alice query'])).toBe(true);
  expect(loadJson(key, [])).toEqual(['Alice query']);
  establishSessionIdentity(account('bob'));
  expect(loadJson(key, [])).toEqual([]);
  expect(saveJson(key, ['Bob query'])).toBe(true);
  establishSessionIdentity(account('alice', 'finance'));
  expect(loadJson(key, [])).toEqual([]);
  establishSessionIdentity(account());
  expect(loadJson(key, [])).toEqual(['Alice query']);
  expect(localStorage.getItem(key)).toBe(JSON.stringify(['Legacy query']));
});

test('anonymous JSON reads its own keys while locked storage fails closed', () => {
  localStorage.setItem(key, JSON.stringify(['Standalone query']));
  expect(loadJson(key, [])).toEqual(['Standalone query']);
  lockSessionIdentity();
  expect(loadJson(key, [])).toEqual([]);
  expect(saveJson(key, ['Not saved'])).toBe(false);
  expect(localStorage.getItem(key)).toBe(JSON.stringify(['Standalone query']));
  expect(saveJson('mistri.theme', 'dark')).toBe(true);
  expect(loadJson('mistri.theme', 'light')).toBe('dark');
});

test('JSON serialization cannot move a captured save into a new account', () => {
  establishSessionIdentity(account());
  const value = {
    toJSON: () => {
      establishSessionIdentity(account('bob'));
      return ['Alice query'];
    },
  };
  expect(saveJson(key, value)).toBe(false);
  expect(loadJson(key, [])).toEqual([]);
  establishSessionIdentity(account());
  expect(loadJson(key, [])).toEqual([]);
});

test('JSON storage continues returning fallbacks or failure when browser storage throws', () => {
  const getter = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('Disabled');
  });
  try {
    expect(loadJson(key, [])).toEqual([]);
    expect(saveJson(key, ['Query'])).toBe(false);
  } finally {
    getter.mockRestore();
  }
});

test('draft recovery captures account ownership for its entire lifetime', () => {
  establishSessionIdentity(account());
  const alice = draftRecovery(draftKey, original, decode);
  expect(alice.write(draft)).toBe('stored');
  const aliceKey = sessionStorageKey(draftKey)!;
  const saved = localStorage.getItem(aliceKey);
  establishSessionIdentity(account('bob'));
  const bob = draftRecovery(draftKey, original, decode);
  expect(bob.recovered).toBeUndefined();
  expect(bob.write({ name: 'Bob draft' })).toBe('stored');
  expect(alice.write({ name: 'Late Alice draft' })).toBe('unavailable');
  expect(alice.clear()).toBe('unavailable');
  expect(localStorage.getItem(aliceKey)).toBe(saved);
  expect(draftRecovery(draftKey, original, decode).recovered?.draft.name).toBe('Bob draft');
  establishSessionIdentity(account());
  expect(alice.clear()).toBe('unavailable');
  expect(draftRecovery(draftKey, original, decode).recovered?.draft).toEqual(draft);
});

test('drafts do not fall back to unowned legacy recovery and cannot save after lock', () => {
  const legacy = draftRecovery(draftKey, original, decode);
  expect(legacy.write(draft)).toBe('stored');
  const saved = localStorage.getItem(draftKey);
  establishSessionIdentity(account());
  const authenticated = draftRecovery(draftKey, original, decode);
  expect(authenticated.recovered).toBeUndefined();
  lockSessionIdentity();
  expect(authenticated.write(draft)).toBe('unavailable');
  expect(authenticated.clear()).toBe('unavailable');
  expect(localStorage.getItem(draftKey)).toBe(saved);
});
