/**
 * The mark before a menu entry: a declared icon always, a stand-in only in a
 * railed menu, and never anything that changes the entry's accessible name.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { APP_ICONS } from '../../../../engine/src/shared/appIcons.js';
import { APP_ICON_GLYPHS } from '../../../../engine/src/shared/iconGlyphs.js';
import { registerIcons } from './Icon.js';
import { NavGlyph } from './NavGlyph.js';

afterEach(cleanup);

describe('NavGlyph', () => {
  test('every App icon has its glyph, drawn as decoration', () => {
    registerIcons(APP_ICON_GLYPHS);
    for (const icon of APP_ICONS) {
      const { container } = render(createElement(NavGlyph, { icon, label: 'Leads' }));
      const svg = container.querySelector('svg.nav-icon');
      expect(svg, icon).not.toBeNull();
      expect(svg!.querySelector('path'), icon).not.toBeNull();
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      cleanup();
    }
  });

  test('an App that declares no icon gets nothing drawn, outside the rail', () => {
    const { container } = render(createElement(NavGlyph, { label: 'Leads' }));
    expect(container.innerHTML).toBe('');
    // A name the client does not know is treated as none, not drawn as a broken glyph.
    const unknown = render(createElement(NavGlyph, { icon: 'rocket-ship', label: 'Leads' }));
    expect(unknown.container.innerHTML).toBe('');
  });

  test('in a railed menu, an entry without an icon gets a stand-in the rail alone shows', () => {
    const initial = render(createElement(NavGlyph, { label: 'leads', railed: true }));
    const letter = initial.container.querySelector('.nav-initial.nav-rail-only');
    expect(letter?.textContent).toBe('L');
    expect(letter?.getAttribute('aria-hidden')).toBe('true');
    cleanup();
    const given = render(createElement(NavGlyph, { label: 'Favorites', railed: true, rail: 'star' }));
    expect(given.container.querySelector('svg.nav-icon.nav-rail-only')).not.toBeNull();
    cleanup();
    // A declared icon wins over any stand-in, and is shown open or folded.
    const declared = render(createElement(NavGlyph, { icon: 'kanban', label: 'Board', railed: true, rail: 'star' }));
    expect(declared.container.querySelector('svg.nav-icon')?.classList.contains('nav-rail-only')).toBe(false);
  });
});
