import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function seed(file) {
  file = resolve(file);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new database path.`);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE engineer(id INTEGER PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL);
      CREATE TABLE service(id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER REFERENCES engineer(id), tier TEXT NOT NULL, repository TEXT NOT NULL);
      CREATE TABLE release_run(id INTEGER PRIMARY KEY, name TEXT NOT NULL, service_id INTEGER NOT NULL REFERENCES service(id), owner_id INTEGER REFERENCES engineer(id), version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','staged','shipping','shipped','blocked')), target_on DATE NOT NULL, summary TEXT);
      CREATE TABLE deployment(id INTEGER PRIMARY KEY, name TEXT NOT NULL, service_id INTEGER NOT NULL REFERENCES service(id), release_id INTEGER REFERENCES release_run(id), environment TEXT NOT NULL CHECK(environment IN ('preview','staging','production')), status TEXT NOT NULL CHECK(status IN ('healthy','degraded','failed')), version TEXT NOT NULL, deployed_on DATE NOT NULL);
      CREATE TABLE incident(id INTEGER PRIMARY KEY, name TEXT NOT NULL, service_id INTEGER REFERENCES service(id), owner_id INTEGER REFERENCES engineer(id), severity TEXT NOT NULL CHECK(severity IN ('critical','major','minor')), status TEXT NOT NULL CHECK(status IN ('investigating','monitoring','resolved')), opened_on DATE NOT NULL, summary TEXT);
      CREATE TABLE approval(id INTEGER PRIMARY KEY, name TEXT NOT NULL, release_id INTEGER NOT NULL REFERENCES release_run(id), reviewer_id INTEGER NOT NULL REFERENCES engineer(id), decision TEXT NOT NULL CHECK(decision IN ('pending','approved','changes_requested')), notes TEXT);
      BEGIN;`);
    const people = ['Maya Chen', 'Theo Laurent', 'Ari Patel', 'Sam Rivera'];
    people.forEach((name, i) => db.prepare('INSERT INTO engineer VALUES(?,?,?)').run(i + 1, name, i % 2 ? 'Product systems' : 'Platform'));
    const services = ['Edge gateway', 'Identity', 'Event pipeline', 'Search index'];
    services.forEach((name, i) =>
      db
        .prepare('INSERT INTO service VALUES(?,?,?,?,?)')
        .run(i + 1, name, i + 1, i < 2 ? 'critical' : 'standard', `platform/${name.toLowerCase().replaceAll(' ', '-')}`),
    );
    const statuses = ['shipping', 'staged', 'queued', 'blocked', 'shipped'];
    for (let i = 0; i < 20; i++) {
      const service = i % 4;
      const version = `2.${8 + Math.floor(i / 4)}.${i % 3}`;
      db.prepare('INSERT INTO release_run VALUES(?,?,?,?,?,?,?,?)').run(
        i + 1,
        `${services[service]} ${version}`,
        service + 1,
        service + 1,
        version,
        statuses[i % 5],
        `2026-09-${String(6 + (i % 12)).padStart(2, '0')}`,
        [
          'Connection pooling and request-budget fixes.',
          'Incremental rollout with error-rate checks.',
          'Schema compatibility verified against downstream consumers.',
          'Waiting for the upstream dependency review.',
        ][i % 4],
      );
    }
    for (let i = 0; i < 12; i++)
      db.prepare('INSERT INTO deployment VALUES(?,?,?,?,?,?,?,?)').run(
        i + 1,
        `${services[i % 4]} / ${['preview', 'staging', 'production'][Math.floor(i / 4)]}`,
        (i % 4) + 1,
        (i % 4) + 1,
        ['preview', 'staging', 'production'][Math.floor(i / 4)],
        i === 10 ? 'degraded' : 'healthy',
        `2.8.${i % 3}`,
        '2026-09-06',
      );
    ['Elevated queue latency', 'Token refresh failures', 'Slow index catch-up', 'Preview worker capacity'].forEach((name, i) =>
      db
        .prepare('INSERT INTO incident VALUES(?,?,?,?,?,?,?,?)')
        .run(
          i + 1,
          name,
          i + 1,
          i + 1,
          i === 1 ? 'critical' : 'major',
          ['monitoring', 'investigating', 'resolved', 'resolved'][i],
          '2026-09-06',
          'Track investigation notes and operational follow-up here.',
        ),
    );
    for (let i = 0; i < 20; i++)
      db.prepare('INSERT INTO approval VALUES(?,?,?,?,?,?)').run(
        i + 1,
        i % 2 ? 'Operational readiness' : 'Compatibility review',
        i + 1,
        ((i + 1) % 4) + 1,
        statuses[i % 5] === 'blocked' ? 'changes_requested' : statuses[i % 5] === 'queued' ? 'pending' : 'approved',
        'Manual review record; this does not authorize or execute a deployment.',
      );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'relay', url: file, writable: true }] }, null, 2)}\n`, {
    flag: 'wx',
  });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(seed(process.argv[2] ?? '.demo/relay.db'));
