import { randomUUID } from 'node:crypto';

export function captureReleasePostgres(inspected) {
  if (!Array.isArray(inspected) || inspected.length !== 1) throw new Error('Owned PostgreSQL container unavailable');
  const value = inspected[0],
    bindings = value?.NetworkSettings?.Ports?.['5432/tcp'];
  if (
    value.Name !== '/tablewalk-050-postgres' ||
    value.State?.Running !== true ||
    !/^[a-f0-9]{64}$/.test(value.Id ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(value.Image ?? '') ||
    bindings?.length !== 1 ||
    bindings[0].HostIp !== '127.0.0.1' ||
    bindings[0].HostPort !== '55450'
  ) {
    throw new Error('Owned PostgreSQL container identity/binding mismatch');
  }
  return Object.freeze({ id: value.Id, image: value.Image, host: '127.0.0.1', port: 55450 });
}

/** Test-injectable I/O, never a user-selected target. The caller constructs the
 * one fixed control connection only after container preflight. */
export async function ownPostgresDatabase(control, inspect) {
  const container = captureReleasePostgres(await inspect());
  const name = `tw_load_${randomUUID().replaceAll('-', '')}`;
  const sameContainer = async () => {
    if (JSON.stringify(captureReleasePostgres(await inspect())) !== JSON.stringify(container))
      throw new Error('Owned PostgreSQL container changed');
  };
  await sameContainer();
  try {
    await control.query(`CREATE DATABASE "${name}"`);
  } catch {
    throw new Error(`Owned PostgreSQL CREATE acknowledgement unavailable; possible orphan ${name}; no automatic DROP`);
  }
  const facts = async () => {
    const { rows } = await control.query('SELECT oid::text AS oid, datdba::text AS owner FROM pg_catalog.pg_database WHERE datname=$1', [
      name,
    ]);
    if (rows.length !== 1 || !/^[1-9][0-9]*$/.test(rows[0].oid) || !/^[1-9][0-9]*$/.test(rows[0].owner)) {
      throw new Error(`Owned PostgreSQL database identity unavailable: ${name}`);
    }
    return { oid: rows[0].oid, owner: rows[0].owner };
  };
  let identity;
  try {
    identity = await facts();
  } catch {
    throw new Error(`Owned PostgreSQL database needs manual recovery: ${name}; identity capture failed`);
  }
  const assertCurrent = async () => {
    await sameContainer();
    if (JSON.stringify(await facts()) !== JSON.stringify(identity)) throw new Error(`Owned PostgreSQL database identity changed: ${name}`);
  };
  let cleanup;
  return Object.freeze({
    name,
    container,
    identity,
    assertCurrent,
    drop: () =>
      (cleanup ??= (async () => {
        await assertCurrent();
        // Only after the owned HTTP child and fixture clients have stopped.
        // Recheck OID and owner in the termination predicate as well.
        await control.query(
          `SELECT pg_terminate_backend(a.pid) FROM pg_catalog.pg_stat_activity a
        JOIN pg_catalog.pg_database d ON d.oid=a.datid
        WHERE d.datname=$1 AND d.oid=$2::oid AND d.datdba=$3::oid AND a.pid<>pg_backend_pid()`,
          [name, identity.oid, identity.owner],
        );
        await assertCurrent();
        await control.query(`DROP DATABASE "${name}"`);
      })()),
  });
}
