import { expect, test } from 'vitest';
import { menuItems, setMenuGroup } from './menu.js';

test('a group registered with a kind carries it, so the palette never reads a display name to tell a page from an action', () => {
  setMenuGroup('Páginas', [{ label: 'Clientes', onSelect: () => {} }], 'page');
  setMenuGroup('Ver', [{ label: 'Preferencias', onSelect: () => {} }]);
  const byLabel = new Map(menuItems().map((item) => [String(item.label), item]));
  expect(byLabel.get('Clientes')?.kind).toBe('page');
  expect(byLabel.get('Preferencias')?.kind).toBeUndefined();
});
