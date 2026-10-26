/**
 * A resource's `live: false` leaves its table out of live sync, which an App joins only with `live: true` at its top.
 * On an App that does not, the word does nothing, and check says so beside its verdict (`[live-unused]`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appAdvisories, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema = { label: 'Desk', dialect: 'sqlite', readAt: '', foreignKeys: [], tables: [] } as unknown as DatabaseSchema;
const advice = (app: object) =>
  appAdvisories(
    {
      path: 'desk.ts',
      app: parseAppConfig(
        {
          name: 'Desk',
          resources: { ticket: {}, audit: { live: false } },
          views: { tickets: { kind: 'list', from: 'ticket' } },
          home: 'tickets',
          nav: ['tickets'],
          ...app,
        },
        'run',
      ),
      pages: [],
      sources: {},
    } as unknown as LoadedApp,
    schema,
  ).filter((line) => /live-unused/.test(line));

test("a resource's live: false on an App without live sync is advised, by the resource and the code", () => {
  const said = advice({});
  assert.equal(said.length, 1);
  assert.match(said[0], /resources "audit" \[live-unused\]: it says live: false/);
  assert.equal(validationCode(said[0]), 'live-unused');
});

test('on an App that says live: true, a resource that leaves it is saying something, and nothing is advised', () => {
  assert.deepEqual(advice({ live: true }), []);
});
