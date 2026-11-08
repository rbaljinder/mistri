/**
 * N05: an App with a job on an event, started before its stores were made. The refusal names which store is missing
 * (not "the job store or event delivery") and the one public command that makes it, so the author is not left
 * with an authority-lock message and a generic line.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bootstrapApp, mistri } from './support/bootstrapApp.js';

test('a start without the job store names it and the migrate command', { timeout: 120_000 }, (t) => {
  const { dir, app, db } = bootstrapApp(t);
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: join(dir, '.config'), MISTRI_CHECK_VALIDATION: '1' };
  // The table and the commands' stores exist; the job store and the delivery destination a new event job needs do not.
  const file = new DatabaseSync(db);
  file.exec(
    "CREATE TABLE item (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', version INTEGER NOT NULL DEFAULT 0)",
  );
  file.close();
  // The commands' stores alone: the journal and the event store, without the App's jobs.
  assert.equal(mistri(['migrate', 'stores', 'up', '--app', '.', '--commands', 'commands.ts'], app, env).code, 0);
  const refused = mistri(['--app', '.', '--jobs', 'jobs.mjs', '--commands', 'commands.ts'], app, env);
  assert.notEqual(refused.code, 0, refused.said);
  assert.match(refused.said, /the job store on source "[^"]+" could not be opened and attested/);
  assert.match(refused.said, /mistri migrate up --app <the App's directory> --jobs <file>/);
  assert.doesNotMatch(refused.said, /job store or event delivery/);
});
