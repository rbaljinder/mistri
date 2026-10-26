/**
 * The icon glyphs are data generated from Phosphor (scripts/generate-icons.mjs),
 * and the answers that name an App icon carry its drawing: the client bundles
 * only the chrome's few, so a glyph missing from a payload is a blank icon.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { APP_ICONS } from '../packages/engine/src/shared/appIcons.js';
import { APP_ICON_GLYPHS } from '../packages/engine/src/shared/iconGlyphs.js';
import { iconGlyphsIn, withIconGlyphs } from '../packages/mistri/src/server/app/iconPayload.js';
import { appLook } from '../packages/mistri/src/shared/appUi.js';
import { render } from '../scripts/generate-icons.mjs';

test('the committed glyph files are what the generator writes from the installed Phosphor', async () => {
  const files: Record<string, string> = await render();
  for (const [path, text] of Object.entries(files)) {
    assert.equal(
      readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
      text,
      `${path} is stale: run node scripts/generate-icons.mjs`,
    );
  }
});

test('every App icon has a regular and a bold drawing, and nothing else', () => {
  assert.deepEqual(Object.keys(APP_ICON_GLYPHS), [...APP_ICONS]);
  for (const [name, glyph] of Object.entries(APP_ICON_GLYPHS)) {
    assert.equal(glyph.length, 2, name);
    for (const weight of glyph) assert.ok(weight.length && weight.every((d) => /^M[\d.,\s\-A-Za-z]+$/.test(d)), name);
  }
});

test('an answer carries the drawings of the icons it names, under icon and logo, and only those', () => {
  const payload = {
    ui: { logo: 'buildings' },
    nav: [{ group: 'work', icon: 'briefcase', children: [{ view: 'tasks', label: 'Tasks' }] }],
    views: { overview: { sections: [{ kind: 'note', icon: 'gauge' }] }, tasks: { icon: 'list-checks', title: 'house' } },
  };
  assert.deepEqual(Object.keys(iconGlyphsIn(payload) ?? {}).sort(), ['briefcase', 'buildings', 'gauge', 'list-checks']);
  assert.equal(iconGlyphsIn({ icon: 'rocket', views: {} }), undefined, 'a word that is no App icon is not one');
  const look = withIconGlyphs(appLook({ id: 'a', name: 'A', ui: { logo: 'car' } }));
  assert.deepEqual(look.icons, { car: APP_ICON_GLYPHS.car });
  assert.deepEqual(withIconGlyphs(appLook({ id: 'a', name: 'A', ui: {} })), { id: 'a', name: 'A' });
});
