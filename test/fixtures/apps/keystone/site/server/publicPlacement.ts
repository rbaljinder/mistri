// Server-only. A host selects an exact dealer key; it never establishes eligibility.
import type { PolicyReadContext, PublicEligibilityAnchor, PublicPlacementIntent, RowScope } from '@mistriwork/mistri/policy';
import type { Rows } from '../mistri-schema.d.ts';

const equal = (column: string, value: string): RowScope[string] => ({ groups: [[{ column, op: '=', value }]] });

/** These versions and positive facts are rechecked under the intake writer's locks.
 * schema.sql already makes dealer_site.dealer_id UNIQUE: find is not the proof.
 * Policy DB deliberately reads status/version even though public grants hide them. */
export async function eligibleStorefront(intent: PublicPlacementIntent | null, { db }: PolicyReadContext<Rows>) {
  if (!intent || intent.appId !== 'site' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(intent.tenant)) return null;
  const dealer = await db.dealer.find({ id: intent.tenant });
  if (!dealer || dealer.id !== intent.tenant || dealer.status !== 'active' || !Number.isSafeInteger(dealer.version) || dealer.version < 0)
    return null;
  const site = await db.dealer_site.find({ dealer_id: dealer.id });
  if (
    !site ||
    site.dealer_id !== dealer.id ||
    site.published !== true ||
    !site.id ||
    !Number.isSafeInteger(site.version) ||
    site.version < 0
  )
    return null;
  const anchors: readonly PublicEligibilityAnchor[] = [
    { table: 'dealer', key: { id: dealer.id }, expected: { status: 'active', version: dealer.version } },
    { table: 'dealer_site', key: { id: site.id }, expected: { dealer_id: dealer.id, published: true, version: site.version } },
  ];
  return { dealerId: dealer.id, anchors };
}

/** Ownership alone belongs in these predicates. Stock status and advertised
 * rates remain the authored merchandising queries, not new authorization rules. */
export function storefrontRows(dealerId: string): RowScope {
  const own = equal('dealer_id', dealerId);
  return {
    dealer: equal('id', dealerId),
    dealer_site: own,
    vehicle: own,
    vehicle_photo: own,
    program: true,
    lead: false,
    lead_activity: false,
    applicant: false,
  };
}

export async function resolvePublicRows(intent: PublicPlacementIntent | null, context: PolicyReadContext<Rows>): Promise<RowScope> {
  const storefront = await eligibleStorefront(intent, context);
  // The canonical host is a neutral shell with shared rates, never a default dealer.
  return storefront ? storefrontRows(storefront.dealerId) : { program: true };
}

export async function resolveIntake(intent: PublicPlacementIntent, context: PolicyReadContext<Rows>, financing: boolean) {
  const storefront = await eligibleStorefront(intent, context);
  if (!storefront) throw new Error('The storefront is unavailable.');
  const own = equal('dealer_id', storefront.dealerId);
  // Exactly this form's command footprint plus its eligibility anchors, on keystone.
  const rows: RowScope = {
    dealer: equal('id', storefront.dealerId),
    dealer_site: own,
    vehicle: own,
    lead: own,
    lead_activity: own,
    ...(financing ? { applicant: own } : {}),
  };
  return { rows, anchors: storefront.anchors };
}
