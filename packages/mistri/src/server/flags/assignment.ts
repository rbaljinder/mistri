/** Pure sticky assignment. This module creates no visitor identity or cookie. */
import { createHash } from 'node:crypto';
import { normalizeFlagAssignment, type FlagAssignment } from '../../shared/appFlags.js';
export type { FlagAssignment } from '../../shared/appFlags.js';
/** A stable percentage in [0,100), or null without a stable identity. Revision
 * is deliberately absent: changing a value must not reshuffle the audience. */
export function flagAssignmentBucket(input: FlagAssignment): number | null {
  const captured = normalizeFlagAssignment(input),
    identity = captured.identity;
  if (!identity) return null;
  const bytes = createHash('sha256')
    .update(
      JSON.stringify([
        'mistri.flags.v1',
        captured.appId,
        captured.environment,
        captured.tenantId,
        captured.flagId,
        captured.experimentVersion,
        captured.purpose,
        identity.kind,
        identity.id,
      ]),
    )
    .digest();
  // 48 bits fit exactly in a JS number; unlike a rounded 64-bit conversion the
  // largest bucket cannot round up to 100.
  return (bytes.readUIntBE(0, 6) / 281474976710656) * 100;
}
