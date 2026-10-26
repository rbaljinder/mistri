/** Explicit launcher-owned enrollment. Reads on resume never repair the journal
 * or generate keys. Public HTTPS origins are served through an operator TLS proxy. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeSuitePublicOrigin, validateTenantHosts } from '../../../../packages/mistri/src/server/http/tenantHosts.ts';
import { suitePlacementConfiguration } from '../../../../packages/mistri/src/server/cli/suitePlacementConfig.ts';

export const placementSecretEnv = 'KEYSTONE_PUBLIC_PLACEMENT_KEY';

export function placementOrigin(publicOrigin, siteHost) {
  const origin = normalizeSuitePublicOrigin(publicOrigin);
  // HTTP loopback is valid for staff, but loopback host mappings are forbidden.
  // Named public hosts therefore require HTTPS; do not emit unusable HTTP bindings.
  if (!origin.startsWith('https://'))
    throw new Error('Site placement requires --public-origin https://<staff-host> and a TLS proxy to the loopback listener.');
  validateTenantHosts([{ host: siteHost, app: 'site', tenant: 'keystone' }], ['site'], origin);
  return origin;
}

/** Pin the actual connected database (including its creation OID), not the URL's
 * password or the shared connection alias. Authentication changes do not rotate
 * the identity; another database requires a separate explicit enrollment. */
export async function inspectPlacementSource(database, requireJournal = false) {
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: database });
  try {
    await db.connect();
    const {
      rows: [row],
    } = await db.query(`SELECT current_database() AS database, oid::text AS oid,
      inet_server_addr()::text AS address, inet_server_port() AS port
      FROM pg_database WHERE datname = current_database()`);
    if (!row) throw new Error('Cannot identify the Keystone placement database.');
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          row.address ?? db.connectionParameters.host,
          row.port ?? db.connectionParameters.port,
          row.database,
          row.oid,
          'keystone',
        ]),
      )
      .digest('hex');
    if (requireJournal) {
      const { assertPostgresPublicPlacementJournal } =
        await import('../../../../packages/mistri/src/adapters/commands/publicPlacementSchema.ts');
      await assertPostgresPublicPlacementJournal(db);
    }
    return `keystone-${identity}`;
  } finally {
    await db.end();
  }
}

function placementConfig(placement) {
  return {
    issuerId: placement.issuerId,
    activeKey: 'one',
    keys: [{ id: 'one', secretEnv: placementSecretEnv, issueFrom: placement.issueFrom }],
    sources: [{ app: 'site', source: 'keystone', identity: placement.sourceIdentity }],
  };
}

export function assertPlacementEnrollment(state, deployment, sourceIdentity) {
  const placement = state.publicPlacement;
  if (
    !placement ||
    placement.sourceIdentity !== sourceIdentity ||
    !isDeepStrictEqual(deployment.publicPlacement, placementConfig(placement))
  ) {
    throw new Error(
      'Placement enrollment is missing or changed. Use --upgrade-placement for a legacy runtime; never reuse enrollment for another database.',
    );
  }
  const site = deployment.apps.find((app) => app.id === 'site');
  if (!site?.policy || !deployment.hosts?.some((host) => host.app === 'site'))
    throw new Error('Site needs its deployment policy and an explicit public host.');
  suitePlacementConfiguration(
    deployment.publicPlacement,
    { [placementSecretEnv]: placement.secret },
    deployment.apps.map((app) => app.id),
    deployment.publicOrigin,
    [state.identitySecret, state.auditSecret],
  );
}

export function enrollPlacement(state, deployment, { publicOrigin, siteHost, policy, tenant, sourceIdentity }) {
  const origin = placementOrigin(publicOrigin, siteHost);
  const apps = deployment.apps.map((app) => app.id);
  if (!apps.includes('site')) throw new Error('The runtime has no Site App.');
  const mapping = { host: siteHost, app: 'site', tenant };
  validateTenantHosts([mapping], apps, origin);
  if (deployment.publicOrigin && deployment.publicOrigin !== origin)
    throw new Error('Additive enrollment cannot replace an existing canonical publicOrigin.');
  const hosts = [...(deployment.hosts ?? [])];
  const existing = hosts.find((host) => host.host === siteHost);
  if (existing && (existing.app !== 'site' || existing.tenant !== tenant))
    throw new Error('Site host already belongs to another placement.');
  if (!existing) hosts.push(mapping);
  validateTenantHosts(hosts, apps, origin);
  if (!state.publicPlacement && deployment.publicPlacement) throw new Error('Refusing to replace an existing placement issuer.');
  const nextState = {
    ...state,
    publicPlacement: state.publicPlacement ?? {
      issuerId: `keystone-${randomUUID()}`,
      secret: randomBytes(32).toString('base64url'),
      issueFrom: Date.now(),
      sourceIdentity,
    },
  };
  if (deployment.publicPlacement) assertPlacementEnrollment(nextState, deployment, sourceIdentity);
  const nextDeployment = {
    ...deployment,
    publicOrigin: origin,
    hosts,
    publicPlacement: deployment.publicPlacement ?? placementConfig(nextState.publicPlacement),
    apps: deployment.apps.map((app) => (app.id === 'site' ? { ...app, policy } : app)),
  };
  assertPlacementEnrollment(nextState, nextDeployment, sourceIdentity);
  return { state: nextState, deployment: nextDeployment };
}
