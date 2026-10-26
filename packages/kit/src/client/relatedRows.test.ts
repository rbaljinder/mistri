import { beforeEach, expect, test, vi } from 'vitest';
const loadJson = vi.fn();
const saveJson = vi.fn();
vi.mock('./core.js', () => ({ loadJson, saveJson }));
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});

test('invalid stored values fall back and blocked persistence does not revert this tab', async () => {
  loadJson.mockReturnValue(999);
  saveJson.mockReturnValue(false);
  const store = await import('./relatedRows.js');
  expect(store.relatedRows()).toBe(10);
  const changed = vi.fn();
  const unsubscribe = store.subscribeRelatedRows(changed);
  store.setRelatedRows(20);
  expect(store.relatedRows()).toBe(20);
  expect(saveJson).toHaveBeenCalledWith('mistri.related-rows', 20);
  expect(changed).toHaveBeenCalledOnce();
  unsubscribe();
  store.setRelatedRows(50);
  expect(changed).toHaveBeenCalledOnce();
});
