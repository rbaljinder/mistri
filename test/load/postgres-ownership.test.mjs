import test from 'node:test';
import assert from 'node:assert/strict';
import { captureReleasePostgres, ownPostgresDatabase } from './postgres-ownership.mjs';
const container = () => [
  {
    Name: '/tablewalk-050-postgres',
    Id: 'a'.repeat(64),
    Image: `sha256:${'b'.repeat(64)}`,
    State: { Running: true },
    NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55450' }] } },
  },
];
test('only exact release-owned running container and loopback55450 binding pass', () => {
  assert.equal(captureReleasePostgres(container()).port, 55450);
  for (const port of ['55451', '55452', '5432']) {
    const value = container();
    value[0].NetworkSettings.Ports['5432/tcp'][0].HostPort = port;
    assert.throws(() => captureReleasePostgres(value));
  }
  for (const mutate of [
    (v) => (v[0].State.Running = false),
    (v) => (v[0].Name = '/preview'),
    (v) => (v[0].NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'),
    (v) => (v[0].Id = 'unknown'),
  ]) {
    const value = container();
    mutate(value);
    assert.throws(() => captureReleasePostgres(value));
  }
});
test('failed preflight has no CREATE and uncertain CREATE never acquires drop authority', async () => {
  const queries = [],
    client = {
      query: async (text) => {
        queries.push(text);
        throw new Error('private URL/password');
      },
    };
  await assert.rejects(ownPostgresDatabase(client, () => []));
  assert.equal(queries.length, 0);
  await assert.rejects(ownPostgresDatabase(client, container), /possible orphan tw_load_[a-f0-9]{32}; no automatic DROP/);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^CREATE DATABASE "tw_load_[a-f0-9]{32}"$/);
});
test('cleanup is exact, identity fenced and one-shot', async () => {
  const queries = [],
    client = {
      query: async (text, values) => {
        queries.push({ text, values });
        return { rows: [{ oid: '123', owner: '10' }] };
      },
    };
  const owned = await ownPostgresDatabase(client, container);
  await Promise.all([owned.drop(), owned.drop()]);
  assert.equal(queries.filter((q) => q.text.startsWith('DROP')).length, 1);
  assert.equal(queries.find((q) => q.text.includes('pg_terminate_backend')).values[0], owned.name);
  assert.equal(queries.at(-1).text, `DROP DATABASE "${owned.name}"`);
});
for (const change of ['oid', 'owner', 'container'])
  test(`changed ${change} refuses cleanup without termination/drop`, async () => {
    let changed = false;
    const queries = [],
      client = {
        query: async (text) => {
          queries.push(text);
          return { rows: [{ oid: changed && change === 'oid' ? '124' : '123', owner: changed && change === 'owner' ? '11' : '10' }] };
        },
      };
    const owned = await ownPostgresDatabase(client, () => {
      const value = container();
      if (changed && change === 'container') value[0].Id = 'c'.repeat(64);
      return value;
    });
    changed = true;
    await assert.rejects(owned.drop());
    assert.equal(
      queries.some((q) => q.includes('pg_terminate_backend') || q.startsWith('DROP')),
      false,
    );
  });
