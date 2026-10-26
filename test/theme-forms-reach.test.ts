import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipeAttributes } from '../packages/engine/src/shared/themeRecipes.js';
import { EDGELESS_FIELD_DELTA, themeTypeWarnings, themeWarnings } from '../packages/engine/src/shared/theme.js';
import { shapeTokens } from '../packages/engine/src/shared/themeTokens.js';
import { PALETTE_TOKENS } from '../packages/engine/src/shared/themeTokens.js';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { hearth } from '../examples/apps/lintel/hearth.js';

/**
 * What a theme may say about a form (forms wave 2): a field's fill, a control's height, no edge on a filled field, a
 * tighter title, and the four recipes a form reads. Each is checked where an author meets it: `compileAppTheme`
 * refuses, `themeWarnings` is `check`.
 */
const base = { kind: 'theme', id: 'pebble', label: 'Pebble', extends: 'lumen' } as const;
const wear = (more: Record<string, unknown>) => compileAppTheme({ ...base, ...more }, 'theme');
const refuse = (more: Record<string, unknown>, pattern: RegExp) => assert.throws(() => wear(more), pattern);

/** Warm paper under white, as Hearth has it, in both modes: a filled field must stand apart from both grounds. */
const PAPER = {
  light: { ground: '#f7f6f2', surface: '#ffffff', ink: '#161513' },
  dark: { ground: '#151412', surface: '#1f1d1a', ink: '#f3f1eb' },
};

test('a field fill is a role of its own, worn as --field-fill, and the surface where a theme names none', () => {
  assert.equal(PALETTE_TOKENS.field, '--field-fill');
  assert.equal(wear({}).light.field, undefined);
  assert.equal(wear({ colors: { light: { field: '#EEEDE7' } } }).light.field, '#eeede7');
  refuse({ colors: { light: { field: 'wheat' } } }, /colors\.light\.field must be a six-digit hex color/);
});

test('the ink is measured on the field: a fill the words cannot be read on is a finding', () => {
  const ok = wear({ colors: { light: { field: '#eeede7' } } });
  // (Lumen's edge, 2.92:1 on a warm fill, is a finding too: an edge is measured on the field it frames.)
  assert.deepEqual(
    themeWarnings([ok]).filter((warning) => /ink\/field/.test(warning)),
    [],
  );
  const dim = wear({ colors: { light: { field: '#5a5a5a' } } });
  assert.ok(
    themeWarnings([dim]).some((warning) => /\(light\).*ink\/field contrast is \d\.\d\d:1; normal text needs 4\.5:1/.test(warning)),
    themeWarnings([dim]).join('\n'),
  );
});

test('a control is 32px to 56px tall, in whole pixels, worn as --control-h', () => {
  for (const height of ['32px', '34px', '56px'])
    assert.equal(shapeTokens(wear({ shape: { height: { control: height } } }))['--control-h'], height);
  for (const height of ['31px', '57px', '40.5px', '40', 'tall'])
    refuse({ shape: { height: { control: height } } }, /theme\.shape\.height\.control must be a length from 32px to 56px/);
  refuse({ shape: { height: { field: '40px' } } }, /theme\.shape\.height has no "field"/);
  assert.equal(shapeTokens(wear({}))['--control-h'], undefined);
});

test('no edge on a field is allowed only when its fill stands apart from the ground and the surface', () => {
  assert.equal(wear({ shape: { border: { control: '0px' } } }).light.rulesControl, '0px');
  assert.equal(shapeTokens(wear({}))['--control-border-w'], undefined);
  // The fill it sits on is the surface: no distance at all.
  const bare = wear({ colors: PAPER, shape: { border: { control: '0px' } } });
  assert.ok(
    themeWarnings([bare]).some((warning) => /field\/surface contrast is 1\.00:1; a field with no edge/.test(warning)),
    themeWarnings([bare]).join('\n'),
  );
  // Hearth's well is 1.085 from the paper and 1.17 from white; a nearly white fill is not a field.
  const faint = wear({
    colors: { light: { ...PAPER.light, field: '#fbfaf7' }, dark: { ...PAPER.dark, field: '#2c2a26' } },
    shape: { border: { control: '0px' } },
  });
  assert.ok(themeWarnings([faint]).some((warning) => /\(light\).*field\/ground contrast is 1\.0\d:1; a field with no edge/.test(warning)));
  const well = wear({
    colors: { light: { ...PAPER.light, field: '#eeede7' }, dark: { ...PAPER.dark, field: '#2c2a26' } },
    shape: { border: { control: '0px' } },
  });
  assert.deepEqual(
    themeWarnings([well]).filter((warning) => /no edge/.test(warning)),
    [],
  );
  // The same bare theme with an edge is as it always was.
  assert.deepEqual(
    themeWarnings([wear({ colors: PAPER, shape: { border: { control: '1px' } } })]).filter((warning) => /no edge/.test(warning)),
    [],
  );
  assert.ok(EDGELESS_FIELD_DELTA < 1.085, "Hearth's field must pass");
});

test("Lintel's Hearth has the warm fill, no edge, the optional word and a tight title, and passes check", () => {
  const theme = compileAppTheme(hearth, 'hearth', new Set(), { faces: true });
  assert.equal(theme.light.field, '#eeede7');
  assert.equal(theme.light.rulesControl, '0px');
  assert.equal(theme.recipes?.required, 'optional-word');
  assert.deepEqual(themeWarnings([theme]), []);
  assert.deepEqual(themeTypeWarnings([theme]), []);
});

test('a title and a display line may lead down to 0.85, with a warning under 1.0; a heading still stops at 1.1', () => {
  for (const role of ['title', 'display'] as const) {
    const theme = wear({ type: { roles: { [role]: { leading: 0.85 } } } });
    assert.equal(theme.type?.roles?.[role]?.leading, 0.85);
    assert.ok(
      themeTypeWarnings([theme]).some((warning) => new RegExp(`type\\.roles\\.${role}\\.leading 0\\.85 is under 1\\.0`).test(warning)),
    );
    refuse({ type: { roles: { [role]: { leading: 0.84 } } } }, new RegExp(`${role}\\.leading must be a number from 0\\.85 to 1\\.8`));
    assert.deepEqual(themeTypeWarnings([wear({ type: { roles: { [role]: { leading: 1.0 } } } })]), []);
  }
  refuse({ type: { roles: { heading: { leading: 1.0 } } } }, /heading\.leading must be a number from 1\.1 to 1\.8/);
});

test('the form recipes are on the menu, default to the plain forms, and are worn as attributes', () => {
  const plain = recipeAttributes(wear({})).attributes;
  assert.equal(plain['data-look-required'], 'star');
  assert.equal(plain['data-look-checkbox'], 'native');
  assert.equal(plain['data-look-form-step'], 'plain');
  assert.equal(plain['data-look-action-bar'], 'plain');
  const worn = recipeAttributes(
    wear({ recipes: { required: 'optional-word', checkbox: 'drawn', formStep: 'ruled', actionBar: 'raised' } }),
  ).attributes;
  assert.equal(worn['data-look-required'], 'optional-word');
  assert.equal(worn['data-look-checkbox'], 'drawn');
  assert.equal(worn['data-look-form-step'], 'ruled');
  assert.equal(worn['data-look-action-bar'], 'raised');
  refuse({ recipes: { required: 'bold' } }, /theme\.recipes\.required is not on the menu: pick one of star, optional-word/);
});
