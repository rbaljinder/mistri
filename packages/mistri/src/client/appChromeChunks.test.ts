import { expect, test, vi } from 'vitest';

/* The two parts the App's chrome fetches by hand: live sync and the source
   watcher. A chunk that does not arrive (a deploy replaced it, the network
   dropped) was an unhandled rejection and a page that quietly stopped
   following changes; it now says so, as onDemand.tsx does for a part. */
const sayUnavailable = vi.hoisted(() => vi.fn());
vi.mock('@mistriwork/kit/client/components/onDemand.js', async (actual) => ({
  ...(await actual<object>()),
  sayUnavailable,
}));
vi.mock('./appState.js', async (actual) => ({
  ...(await actual<object>()),
  inAppMode: () => true,
  appFollowsSaves: () => true,
}));
vi.mock('./publicVisitor.js', async (actual) => ({ ...(await actual<object>()), isPublicVisitor: () => false }));
vi.mock('./liveSync.js', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/liveSync.js');
});
vi.mock('./appLive.js', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/appLive.js');
});

test('a live-sync or source-watcher chunk that does not load is reported, not left unhandled', async () => {
  /* The chrome is most of the shell: its first import is slow on a loaded machine. */
  const { followSaves } = await import('./appChrome.js');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  followSaves(() => {});
  await vi.waitFor(() => expect(sayUnavailable).toHaveBeenCalledTimes(2));
  expect(errors.mock.calls.map(([message]) => message)).toEqual(
    expect.arrayContaining(['The live sync chunk did not load.', 'The App source watcher chunk did not load.']),
  );
  errors.mockRestore();
}, 60_000);
