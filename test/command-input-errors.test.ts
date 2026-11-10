/**
 * A command's declaration refused while its module runs is said as that: the file and line first, the key it does not
 * take, and for `required` the word it meant (a field report: it read as a module that failed to load).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { unknownKey } from '../packages/engine/src/shared/suggest.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';

test('required is answered with optional, and only where optional is a key', () => {
  assert.match(unknownKey('required', ['type', 'optional']), /Did you mean "optional: true"\?/);
  assert.doesNotMatch(unknownKey('required', ['type', 'label']), /optional/);
});

test('a refused declaration in the commands module names its file and line, not a module that failed to load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-input-error-'));
  try {
    const file = join(dir, 'commands.mjs');
    writeFileSync(
      file,
      [
        "import { defineCommand, defineCommands, field } from '" + join(process.cwd(), 'packages/mistri/src/server/commands.ts') + "';",
        'export default defineCommands({',
        "  poke: defineCommand({ source: 's', target: 't', input: { note: field.textarea({ required: false }) }, output: { parse: (v) => v }, async handle() {} }),",
        '});',
        '',
      ].join('\n'),
    );
    await assert.rejects(loadBusinessCommands(file), (error: Error) => {
      assert.match(error.message, /^commands\.mjs:3: Command input, input "note" has no "required"\. Did you mean "optional: true"\?/);
      assert.doesNotMatch(error.message, /could not be loaded/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
