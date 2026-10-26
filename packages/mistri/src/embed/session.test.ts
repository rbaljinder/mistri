import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXCHANGE_PATH, SIGN_OUT_PATH, crossOrigin, startSession } from './session.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('the embed session', () => {
  it('exchanges nothing for the cookie', async () => {
    const fetcher = vi.fn();
    const session = startSession('/api/tw', 'cookie', fetcher);
    await session.ready;
    expect(fetcher).not.toHaveBeenCalled();
    expect(session.authorization()).toBeUndefined();
  });

  it('knows its own origin from another', () => {
    expect(crossOrigin('/api/tw')).toBe(false);
    expect(crossOrigin(`${window.location.origin}/api/tw`)).toBe(false);
    expect(crossOrigin('https://tw.example.com/tools')).toBe(true);
  });

  it('same origin: posts the assertion with the cookie, and the reply sets the session', async () => {
    const fetcher = vi.fn(async () => json(200, { ok: true }));
    const session = startSession('/api/tw', { assertion: async () => 'signed' }, fetcher);
    await session.ready;
    expect(fetcher).toHaveBeenCalledWith(
      `/api/tw${EXCHANGE_PATH}`,
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ assertion: 'signed' }) }),
    );
    expect(session.authorization()).toBeUndefined();
  });

  it('another origin: keeps the token in memory, sends it as a bearer, and renews it before it lapses', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(200, { token: `t${++n}`, expiresAt: Date.now() + 10 * 60_000 }),
    );
    const assertion = vi.fn(async () => 'signed');
    const session = startSession('https://tw.example.com', { assertion }, fetcher);
    await session.ready;
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
    expect(session.authorization()).toBe('Bearer t1');

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    // The renewal is the exchange again, with the host's fresh assertion as its whole proof.
    expect(fetcher.mock.calls[1][0]).toBe(`https://tw.example.com${EXCHANGE_PATH}`);
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('authorization')).toBeNull();
    expect(assertion).toHaveBeenCalledTimes(2);
    expect(session.authorization()).toBe('Bearer t2');

    session.close();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('another origin: a reply with no token is refused', async () => {
    const fetcher = vi.fn(async () => json(200, {}));
    await expect(startSession('https://tw.example.com', { assertion: async () => 'signed' }, fetcher).ready).rejects.toThrow(
      /without a session for this origin/,
    );
  });

  it('the host’s person is gone: signs out of mistri too, and tells the host', async () => {
    const fetcher = vi.fn(async () => json(200, {}));
    const onUnauthenticated = vi.fn();
    const assertion = async () => {
      throw Object.assign(new Error('no session'), { status: 401 });
    };
    await expect(startSession('/api/tw', { assertion, onUnauthenticated }, fetcher).ready).rejects.toThrow(/signed out too/);
    expect(fetcher).toHaveBeenCalledWith(`/api/tw${SIGN_OUT_PATH}`, expect.objectContaining({ method: 'POST' }));
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('posts to the App’s own exchange and sign-out routes', () => {
    expect([EXCHANGE_PATH, SIGN_OUT_PATH]).toEqual(['/api/auth/embed/exchange', '/api/auth/embed/sign-out']);
  });

  it('another origin: signing out shows the server the bearer it ends', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(200, { token: 'kept', expiresAt: Date.now() + 2 * 60_000 }),
    );
    const assertion = vi.fn(async () => {
      if (++calls > 1) throw Object.assign(new Error('gone'), { status: 401 });
      return 'signed';
    });
    const onUnauthenticated = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = startSession('https://tw.example.com', { assertion, onUnauthenticated }, fetcher);
    await session.ready;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const signOut = fetcher.mock.calls.find(([url]) => String(url).endsWith(SIGN_OUT_PATH));
    expect(new Headers(signOut?.[1]?.headers).get('authorization')).toBe('Bearer kept');
    expect(signOut?.[1]).toMatchObject({ credentials: 'omit' });
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(session.authorization()).toBeUndefined();
    errors.mockRestore();
  });

  it('a refused exchange says the server’s sentence and tells the host', async () => {
    const fetcher = vi.fn(async () => json(403, { error: 'This assertion has expired.' }));
    const onUnauthenticated = vi.fn();
    await expect(startSession('/api/tw', { assertion: async () => 'old', onUnauthenticated }, fetcher).ready).rejects.toThrow(
      'This assertion has expired.',
    );
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });
});
