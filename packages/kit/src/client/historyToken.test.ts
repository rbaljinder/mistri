import { describe, expect, it, vi } from 'vitest';
import { createHistoryQuarantine, historyToken, historyTokenAvailable, quarantineHistory } from './historyToken.js';

describe('historyToken', () => {
  it.each([1, 2, 42, Number.MAX_SAFE_INTEGER])('preserves ordinary numeric ID %s', (value) => {
    expect(historyToken(value, false)).toBe(value);
    expect(historyToken(value, true)).toBeUndefined();
  });

  it.each([0, -0, -1, 0.5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid ordinary numeric ID %s',
    (value) => {
      expect(historyToken(value, false)).toBeUndefined();
      expect(historyToken(value, true)).toBeUndefined();
    },
  );

  it.each([
    '1',
    '01',
    '1e3',
    '9007199254740993',
    'Infinity',
    'north-token',
    'b697fc96-d0eb-47da-a280-1c67193f4a36',
    'a/b?c#d',
    '__proto__',
  ])('keeps opaque token %s as exact text', (value) => {
    expect(historyToken(value, true)).toBe(value);
    expect(historyToken(value, false)).toBeUndefined();
  });

  it.each([undefined, null, true, false, 1n, Symbol('token'), [], ['token'], {}, new String('token'), new Number(1)])(
    'rejects nonprimitive/non-token input case %# without coercion',
    (value) => {
      expect(historyToken(value, false)).toBeUndefined();
      expect(historyToken(value, true)).toBeUndefined();
    },
  );

  it('does not invoke accessors, conversions or proxy traps, even for a revoked proxy', () => {
    const trap = vi.fn(() => {
      throw new Error('must not inspect');
    });
    const object = {
      get toString() {
        return trap();
      },
      get valueOf() {
        return trap();
      },
      get [Symbol.toPrimitive]() {
        return trap();
      },
    };
    const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [object, proxy, revoked.proxy]) {
      expect(historyToken(value, false)).toBeUndefined();
      expect(historyToken(value, true)).toBeUndefined();
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it.each([
    '',
    ' ',
    '\t',
    '\n',
    ' token',
    'token ',
    '\u00a0token',
    'token\u00a0',
    '\uFEFFtoken',
    'token\u3000',
    '\u2028token',
    'token\u2029',
  ])('rejects empty or edge whitespace case %#', (value) => {
    expect(historyToken(value, true)).toBeUndefined();
  });

  it('rejects every C0, DEL and C1 control even inside a token', () => {
    for (let code = 0; code <= 0x9f; code++) {
      if (code > 0x1f && code < 0x7f) continue;
      expect(historyToken(`a${String.fromCharCode(code)}b`, true)).toBeUndefined();
    }
  });

  it.each(['north south', 'a\u00a0b', 'a\u2028b', 'a\u2029b', 'a\u200bb', '北方', 'é', 'e\u0301', '🔑', '\ud800', '\udfff'])(
    'matches the server identifier contract for Unicode/internal whitespace case %#',
    (value) => {
      expect(historyToken(value, true)).toBe(value);
    },
  );

  it.each(['x'.repeat(128), '北'.repeat(128), '🔑'.repeat(64)])('accepts the exact 128-code-unit boundary case %#', (value) => {
    expect(value.length).toBe(128);
    expect(historyToken(value, true)).toBe(value);
    expect(historyToken(value + 'x', true)).toBeUndefined();
  });

  it('does not normalize case, Unicode, numeric text or punctuation into colliding tokens', () => {
    const values = ['a', 'A', 'é', 'e\u0301', '1', '01', '1.0', '%31', 'a/b', 'a%2Fb'];
    expect(values.map((value) => historyToken(value, true))).toEqual(values);
    expect(new Set(values.map((value) => historyToken(value, true))).size).toBe(values.length);
    expect(historyToken(1, false)).not.toBe(historyToken('1', true));
  });
});

describe('caller-owned history quarantine', () => {
  it('preserves ordinary ceiling ordering and allows strictly newer entries', () => {
    const fresh = createHistoryQuarantine(false);
    expect(historyTokenAvailable(fresh, 1)).toBe(true);
    const first = quarantineHistory(fresh, 20);
    for (const token of [1, 19, 20]) expect(historyTokenAvailable(first, token)).toBe(false);
    expect(historyTokenAvailable(first, 21)).toBe(true);
    expect(historyTokenAvailable(first, Number.MAX_SAFE_INTEGER)).toBe(true);
    const older = quarantineHistory(first, 10);
    expect(older).toEqual(first);
    const newer = quarantineHistory(older, 30);
    expect(historyTokenAvailable(newer, 21)).toBe(false);
    expect(historyTokenAvailable(newer, 31)).toBe(true);
    expect(fresh).toEqual({ tenant: false, ceiling: 0 });
    expect(first).toEqual({ tenant: false, ceiling: 20 });
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each(['1', '9', 'a', 'z', '北方'])('tenant uncertainty for %s blocks every opaque token, not just matching/older ones', (token) => {
    const fresh = createHistoryQuarantine(true);
    expect(historyTokenAvailable(fresh, token)).toBe(true);
    const blocked = quarantineHistory(fresh, token);
    for (const other of [token, '0', '10', 'a', 'z', 'new-unrelated-token', '南方']) {
      expect(historyTokenAvailable(blocked, other)).toBe(false);
    }
    expect(quarantineHistory(blocked, 'another')).toEqual(blocked);
    expect(fresh).toEqual({ tenant: true, blocked: false });
    expect(Object.isFrozen(blocked)).toBe(true);
  });

  it('keeps ordinary, two tenant contexts and fresh generations independent', () => {
    const ordinary = quarantineHistory(createHistoryQuarantine(false), 1);
    const north = quarantineHistory(createHistoryQuarantine(true), '1');
    const south = createHistoryQuarantine(true);
    const newNorth = createHistoryQuarantine(true);
    expect(historyTokenAvailable(ordinary, 2)).toBe(true);
    expect(historyTokenAvailable(ordinary, '2')).toBe(false);
    expect(historyTokenAvailable(north, '2')).toBe(false);
    expect(historyTokenAvailable(south, '1')).toBe(true);
    expect(historyTokenAvailable(newNorth, '1')).toBe(true);
    expect(historyTokenAvailable(south, 1)).toBe(false);
  });

  it.each([undefined, null, '', ' ', {}, 0, -1, NaN, Infinity])('never makes a malformed token available case %#', (value) => {
    for (const tenant of [false, true]) {
      expect(historyTokenAvailable(createHistoryQuarantine(tenant), value)).toBe(false);
    }
  });

  it.each([undefined, '10', 0, NaN, {}])('fails closed if ordinary uncertainty has no usable numeric ceiling case %#', (value) => {
    const state = quarantineHistory(createHistoryQuarantine(false), value);
    expect(historyTokenAvailable(state, 1)).toBe(false);
    expect(historyTokenAvailable(state, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('fails closed on tenant uncertainty even when its token is missing or malformed', () => {
    for (const value of [undefined, '', 1, {}]) {
      const state = quarantineHistory(createHistoryQuarantine(true), value);
      expect(historyTokenAvailable(state, 'a-valid-token')).toBe(false);
    }
  });
});
