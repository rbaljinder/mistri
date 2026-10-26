import { beforeEach, expect, test, vi } from 'vitest';
import { establishSessionIdentity, lockSessionIdentity } from '../../../kit/src/client/sessionIdentity.js';

/* An App has no Undo (undo.js): its writes run side by side on a writer
   pool, so there is no "last write" to take back. The keystroke and the
   history ask the server nothing. */
const { api, toast, invalidateQueries, state } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  state: { activeConnection: 'app', canWrite: true },
}));
vi.mock('../../../kit/src/client/core.js', () => ({ api, toast, state }));
vi.mock('../../../kit/src/client/components/mount.js', () => ({ queryClient: { invalidateQueries } }));
vi.mock('../../../kit/src/client/connectionScope.js', () => ({ canUseDatabaseTools: () => false }));
const { canUndo, initUndo, refreshUndo, undoToast } = await import('./undo.js');

beforeEach(() => {
  vi.clearAllMocks();
  api.mockReset();
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
});

test("in an App, Cmd+Z, the history and a confirmation's Undo ask the server nothing", async () => {
  initUndo();
  const event = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  await refreshUndo();
  expect(canUndo()).toBe(false);
  expect(undoToast(7)).toBeUndefined();
  expect(api).not.toHaveBeenCalled();
});
