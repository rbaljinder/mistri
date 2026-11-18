/**
 * Every built-in AI surface (For review, a record's proposal line, the assistant) says one word beside its mark. An
 * App that calls its model something else names it once, `ai: { label }`, and the payload carries it to the kit's
 * AiMark; without it the mark says "AI".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema = { label: 'Clinic', dialect: 'sqlite', readAt: '', foreignKeys: [], tables: [] } as unknown as DatabaseSchema;
const parsed = (root: object) =>
  parseAppConfig(
    {
      name: 'Clinic',
      resources: { claim: {} },
      views: { claims: { kind: 'list', from: 'claim' } },
      home: 'claims',
      nav: ['claims'],
      ...root,
    },
    'run',
  );

test("the App's word for its model is kept trimmed and served; absent, nothing is served and the mark says AI", () => {
  const named = parsed({ ai: { label: ' Copilot ' } });
  assert.deepEqual(named.ai, { label: 'Copilot' });
  assert.deepEqual(servedApp(named, schema, []).ai, { label: 'Copilot' });
  assert.equal(parsed({}).ai, undefined);
  assert.equal(servedApp(parsed({}), schema, []).ai, undefined);
});

test('a label that is empty, too long or not text, and any other key, is refused where it is written', () => {
  for (const label of ['', '   ', 'x'.repeat(25), 7, undefined])
    assert.throws(() => parsed({ ai: { label } }), /ai\.label is 24 characters or fewer of text/, String(label));
  assert.doesNotThrow(() => parsed({ ai: { label: 'x'.repeat(24) } }));
  assert.throws(() => parsed({ ai: 'Copilot' }), /ai/);
  assert.throws(() => parsed({ ai: { label: 'Copilot', icon: 'spark' } }), /icon/);
});
