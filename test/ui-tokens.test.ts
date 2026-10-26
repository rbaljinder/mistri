import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nearestToken, UI_TOKENS } from '../packages/kit/src/shared/uiTokens.js';
import { FONT_TOKENS, PALETTE_TOKENS, RADIUS_TOKENS } from '../packages/engine/src/shared/themeTokens.js';
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

test('a borrowed or misspelt name is steered to the real token', () => {
  assert.equal(nearestToken('--negative'), '--status-critical');
  assert.equal(nearestToken('--ink-mutd'), '--ink-muted');
  assert.equal(nearestToken('--zzzzzzzzzz'), undefined);
});
