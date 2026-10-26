import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact, scrubSecrets } from '../packages/engine/src/server/connectionRedaction.js';
import { redact as compatibilityRedact, scrubSecrets as compatibilityScrub } from '../packages/engine/src/server/connections.js';

test('Registry compatibility exports retain the exact connection redaction leaf', () => {
  assert.equal(compatibilityRedact, redact);
  assert.equal(compatibilityScrub, scrubSecrets);
});

test('display redaction preserves target details without passwords or query strings', () => {
  assert.equal(redact('postgres://alice:synthetic@db.example:5432/app?password=other'), 'alice@db.example:5432/app');
  assert.equal(redact('postgres://u:p%40ss%3Aword@host/db'), 'u@host/db');
  assert.equal(redact('postgres://[broken'), '(connection)');
  assert.equal(redact('/private/path/data.sqlite'), 'data.sqlite');
});

test('driver redaction sweeps whole URLs and encoded or decoded standalone passwords', () => {
  const url = 'postgres://user:p%40ss%3Aword@db.example/db';
  const message = `Failed ${url}: p%40ss%3Aword and p@ss:word`;
  const result = scrubSecrets(message, url, undefined);
  assert.equal(result, 'Failed user@db.example/db: •••• and ••••');
  assert.equal(scrubSecrets('bad x', 'postgres://user:x@host/db'), 'bad ••••');
  assert.equal(scrubSecrets('ordinary error', '/data/file.sqlite'), 'ordinary error');
});
