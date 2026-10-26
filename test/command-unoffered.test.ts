import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppDef } from '../packages/mistri/src/shared/app.js';
import type { BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { unofferedCommandWarnings } from '../packages/mistri/src/server/app/appCommandOfferChecks.js';

const command = (extra: Record<string, unknown> = {}) => ({ target: 'lead', source: 'main', ...extra });
const registry = (entries: Record<string, ReturnType<typeof command>>) => entries as unknown as BusinessCommandRegistry;
const app = (extra: Record<string, unknown> = {}) => ({ resources: { lead: { actions: [] } }, views: {}, ...extra }) as unknown as AppDef;

test('a targeted command nothing offers is warned of, with a stable code', () => {
  const [warning, ...rest] = unofferedCommandWarnings(app(), registry({ archive: command() }));
  assert.equal(rest.length, 0);
  assert.match(warning, /^command "archive" .*\[command-unoffered\]: .*403 forbidden/);
});

test('an action, an API exposure, a service run, a creating or a public command is not warned of', () => {
  const offering = app({
    resources: {
      lead: { actions: [{ id: 'archive', label: 'Archive', command: { id: 'archive', version: 1, target: 'lead', input: [] } }] },
    },
    api: { commands: [{ command: { id: 'exposed', version: 1, target: 'lead', input: [] } }] },
  });
  const commands = registry({
    archive: command(),
    exposed: command(),
    nightly: command(),
    create: command({ targets: 'none' }),
    apply: command({ targets: 'none', public: true }),
  });
  assert.deepEqual(unofferedCommandWarnings(offering, commands, new Set(['nightly'])), []);
  assert.deepEqual(unofferedCommandWarnings(offering, undefined), []);
});
