import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openerFor } from '../packages/engine/src/server/cli/browser.js';

test('each platform opens a URL with a real program, and a Windows URL with & stays one argument', () => {
  const url = 'http://127.0.0.1:3000/?a=1&b=2';
  assert.deepEqual(openerFor('darwin', url), { cmd: 'open', args: [url] });
  assert.deepEqual(openerFor('linux', url), { cmd: 'xdg-open', args: [url] });
  // `start` is a cmd.exe builtin, not a program: spawning it by name fails with ENOENT.
  assert.deepEqual(openerFor('win32', url), { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
});
