/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const refreshViewportScale = vi.fn();
vi.mock('./core.js', () => ({ refreshViewportScale }));

beforeEach(() => {
  vi.resetModules();
  // happy-dom binds Storage methods on access; use a plain storage boundary so
  // throwing reads/writes are actually exercised, not a shadowed prototype spy.
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
  document.documentElement.removeAttribute('style');
  document.body.className = '';
  refreshViewportScale.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('density keeps successful persistence, external reads and normalization unchanged', async () => {
  const density = await import('./density.js');
  expect(density.densityChoice()).toBe('comfortable');
  localStorage.setItem('mistri.density', 'obsolete');
  expect(density.densityChoice()).toBe('comfortable');
  density.setDensity('spacious');
  expect(localStorage.getItem('mistri.density')).toBe('spacious');
  expect(document.documentElement.style.getPropertyValue('zoom')).toBe('1.24');
  expect(document.documentElement.style.getPropertyValue('--shell-vh')).toBe('calc(100vh / 1.24)');
  localStorage.setItem('mistri.density', 'compact');
  density.applyDensity();
  expect(document.documentElement.style.getPropertyValue('zoom')).toBe('');
  density.setDensity('invalid');
  expect(density.densityChoice()).toBe('comfortable');
  expect(refreshViewportScale).toHaveBeenCalledTimes(3);
});

test('failed density writes override readable stale storage for this tab', async () => {
  localStorage.setItem('mistri.density', 'spacious');
  const density = await import('./density.js');
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  density.setDensity('compact');
  expect(localStorage.getItem('mistri.density')).toBe('spacious');
  expect(density.densityChoice()).toBe('compact');
  density.applyDensity();
  expect(document.documentElement.style.getPropertyValue('zoom')).toBe('');
  write.mockRestore();
  density.setDensity('comfortable');
  expect(localStorage.getItem('mistri.density')).toBe('comfortable');
});

test('blocked density reads retain defaults, last read values and explicit choices', async () => {
  const density = await import('./density.js');
  const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(density.densityChoice()).toBe('comfortable');
  density.setDensity('spacious');
  expect(density.densityChoice()).toBe('spacious');
  expect(document.documentElement.style.getPropertyValue('zoom')).toBe('1.24');
  read.mockRestore();
  localStorage.setItem('mistri.density', 'compact');
  expect(density.densityChoice()).toBe('compact');
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(density.densityChoice()).toBe('compact');
});

test('typography preserves defaults, explicit face precedence and stale-value fallback', async () => {
  const type = await import('./typography.js');
  localStorage.setItem('mistri.typography', '{malformed');
  expect(type.typographyPreference()).toBe('default');
  type.setTypography('sans');
  expect(localStorage.getItem('mistri.typography')).toBe('sans');
  expect(document.body).toHaveClass('type-sans');
  type.setTypography('invalid');
  expect(type.typographyPreference()).toBe('mono');
  expect(document.body).toHaveClass('type-mono');
  expect(document.body).not.toHaveClass('type-sans');
  type.setTypography('default');
  expect(localStorage.getItem('mistri.typography')).toBeNull();
  expect(document.body).not.toHaveClass('type-mono');
});

test('blocked typography writes and removals preserve the chosen face or app default', async () => {
  localStorage.setItem('mistri.typography', 'mono');
  const type = await import('./typography.js');
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  const remove = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  type.setTypography('sans');
  expect(type.typographyPreference()).toBe('sans');
  expect(document.body).toHaveClass('type-sans');
  expect(localStorage.getItem('mistri.typography')).toBe('mono');
  type.setTypography('default');
  type.applyTypography();
  expect(type.typographyPreference()).toBe('default');
  expect(document.body).not.toHaveClass('type-sans');
  expect(document.body).not.toHaveClass('type-mono');
  remove.mockRestore();
  type.setTypography('default');
  expect(localStorage.getItem('mistri.typography')).toBeNull();
});

test('blocked typography reads retain both a previous read and a new choice', async () => {
  const type = await import('./typography.js');
  localStorage.setItem('mistri.typography', 'sans');
  expect(type.typographyPreference()).toBe('sans');
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  type.applyTypography();
  expect(document.body).toHaveClass('type-sans');
  type.setTypography('mono');
  expect(type.typographyPreference()).toBe('mono');
  expect(document.body).toHaveClass('type-mono');
});
