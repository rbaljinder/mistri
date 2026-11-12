import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nearestToken, UI_TOKENS } from '../packages/kit/src/shared/uiTokens.js';
import { FONT_TOKENS, PALETTE_TOKENS, RADIUS_TOKENS, THEME_BASES, shapeTokens } from '../packages/engine/src/shared/themeTokens.js';
import { effectiveThemeDefinition, themePreset } from '../packages/engine/src/shared/themePresets.js';
import { UI_EXPORTS } from '../packages/mistri/src/shared/uiSdk.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 4.5: the tokens were unlisted, so a component wrote var(--negative) and got nothing. */
test('every role, face and corner a theme wears is a token a component may read', () => {
  for (const token of [...Object.values(PALETTE_TOKENS), ...Object.values(FONT_TOKENS), ...Object.values(RADIUS_TOKENS)])
    assert.ok(UI_TOKENS.includes(token), token);
  assert.ok(UI_EXPORTS.includes('tokens'));
});

test('the published types list exactly the tokens', () => {
  const types = readFileSync(`${ROOT}packages/mistri/schema/ui.d.ts`, 'utf8');
  const union = /export type Token =\n([\s\S]*?);/.exec(types)![1]!;
  assert.deepEqual(
    [...union.matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]),
    [...UI_TOKENS],
  );
});

/** A field report: the sheet defined --space-1h and check refused it, and --control-h was the kit's own height that a page's control could not read by name: two lists, one the sheet's and one check's. The sheet's scales and semantic steps are read off it. */
test('every step of the space and text scales and every semantic size the base sheet defines is a token a component may read', () => {
  const base = readFileSync(`${ROOT}packages/ui/src/tokens.css`, 'utf8');
  const defined = [
    ...base.matchAll(/^\s*(--(?:space-[0-9a-z]+|text-[a-z]+|control-h|section-seam|room-inset|row-h|page-[a-z-]+))\s*:/gm),
  ].map((match) => match[1]!);
  assert.ok(defined.length > 15, 'the scales were found');
  assert.deepEqual(
    defined.filter((token) => !UI_TOKENS.includes(token)),
    [],
  );
});

test('a borrowed or misspelt name is steered to the real token', () => {
  assert.equal(nearestToken('--negative'), '--status-critical');
  assert.equal(nearestToken('--ink-mutd'), '--ink-muted');
  assert.equal(nearestToken('--zzzzzzzzzz'), undefined);
  /* A word Object.prototype holds is not a borrowed name: no function's source as a token. */
  for (const word of ['--constructor', '--toString', '--valueOf', '--hasOwnProperty']) {
    assert.equal(nearestToken(word), undefined, word);
  }
});

/** Roles a look says only when it has its own idea of them: the sheets read them with a fallback (`var(--primary, var(--accent))`)
    or only under the attribute or look that sets them (`data-nav-current`, appTheme.js). */
const OPTIONAL = new Set([
  '--primary',
  '--on-primary',
  '--nav-current',
  '--nav-on-current',
  '--rules-section',
  '--rules-head',
  '--rules-weight',
  '--band',
  '--panel-radius',
]);

const sheets = () => ['packages/kit/src/client', 'packages/ui/src'].flatMap((dir) => globSync(`${ROOT}${dir}/**/*.css`));

/**
 * A field report: `--pill-radius` was a token a component may read and `mistri check` accepts, but no look gave it a
 * value, so a rule that read it drew square corners. A token is either the theme's to say, and then every built-in look
 * says it; or a sheet's, declared once for all of them; or optional (above). Anything else is a token a component reads to nothing, and the next one added cannot go missing quietly.
 */
test('every token a component may read has a value under every built-in look, light and dark', () => {
  const declared = new Set<string>();
  for (const file of sheets()) for (const match of readFileSync(file, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(match[1]!);
  // What the shell writes beside the theme's own tokens (appTheme.js, visualTheme.ts): the control's corner as --radius,
  // the data face as --mono, and the title weight.
  const written = new Set(['--radius', '--mono', '--heading-weight']);
  const missing: string[] = [];
  for (const base of THEME_BASES) {
    const definition = effectiveThemeDefinition(themePreset(base)!);
    for (const mode of ['light', 'dark'] as const) {
      const tokens = new Set<string>(written);
      for (const key of Object.keys(definition[mode])) tokens.add(PALETTE_TOKENS[key as keyof typeof PALETTE_TOKENS]);
      for (const key of Object.keys(definition.fonts ?? {})) tokens.add(FONT_TOKENS[key as keyof typeof FONT_TOKENS]);
      for (const token of Object.keys(shapeTokens(definition))) tokens.add(token);
      for (const token of UI_TOKENS)
        if (!tokens.has(token) && !declared.has(token) && !OPTIONAL.has(token)) missing.push(`${base} ${mode} ${token}`);
    }
  }
  assert.deepEqual(missing, []);
});
