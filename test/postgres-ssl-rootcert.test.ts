import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pgConnectionOptions } from '../packages/engine/src/adapters/postgresValues.js';

const planetScale = 'postgresql://user:pw@aws.connect.psdb.cloud:6432/app?sslmode=verify-full&sslrootcert=system';

test('sslrootcert=system is stripped and asks for a verified connection', () => {
  const options = pgConnectionOptions(planetScale);
  assert.equal(options.connectionString, 'postgresql://user:pw@aws.connect.psdb.cloud:6432/app?sslmode=verify-full');
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
});

test('sslrootcert=system alone leaves no empty query', () => {
  assert.equal(pgConnectionOptions('postgres://h/db?sslrootcert=system').connectionString, 'postgres://h/db');
  assert.equal(
    pgConnectionOptions('postgres://h/db?sslrootcert=system&application_name=x').connectionString,
    'postgres://h/db?application_name=x',
  );
});

test('every other string passes through untouched, a real path included', () => {
  for (const url of ['postgres://h/db', 'postgres://h/db?sslmode=require', 'postgres://h/db?sslrootcert=/etc/ssl/ca.pem']) {
    assert.deepEqual(pgConnectionOptions(url), { connectionString: url });
  }
});

test('what is left parses without reading a file', () => {
  // pg's own parameter reader (the one Pool uses), so the package is not imported twice over.
  const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters');
  const config = new ConnectionParameters(pgConnectionOptions(planetScale).connectionString);
  assert.deepEqual(config.ssl, {});
});

test('sslmode=disable forces no ssl, with or without the system root', () => {
  const options = pgConnectionOptions('postgres://h/db?sslmode=disable&sslrootcert=system');
  assert.equal(options.connectionString, 'postgres://h/db?sslmode=disable');
  assert.equal(options.ssl, undefined);
  assert.deepEqual(pgConnectionOptions('postgres://h/db?sslmode=disable'), { connectionString: 'postgres://h/db?sslmode=disable' });
});
