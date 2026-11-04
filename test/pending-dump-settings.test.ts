/**
 * A pg_dump newer than its server writes `SET`s for settings the server has never heard of (17's
 * `transaction_timeout` against a 16 server), and the copy of the schema `check --pending` loads them into refuses
 * the whole dump. Only a `SET` of an unknown setting is dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutUnknownSettings } from '../packages/mistri/src/server/build/pending.js';

const DUMP = `--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE TABLE public.items (id integer NOT NULL);`;

test('a SET of a setting the server lacks is dropped, and nothing else', () => {
  const known = new Set(['statement_timeout', 'lock_timeout', 'client_encoding', 'standard_conforming_strings']);
  const kept = withoutUnknownSettings(DUMP, known);
  assert.ok(!kept.includes('transaction_timeout'));
  assert.equal(kept, DUMP.replace('SET transaction_timeout = 0;\n', ''));
});

test('a server that knows the setting keeps it', () => {
  const known = new Set(['statement_timeout', 'lock_timeout', 'transaction_timeout', 'client_encoding', 'standard_conforming_strings']);
  assert.equal(withoutUnknownSettings(DUMP, known), DUMP);
});
