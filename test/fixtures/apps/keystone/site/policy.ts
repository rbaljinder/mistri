// Private deployment enrollment (--policy); never imported by app.ts.
import { defineAppRowPolicy, type RowScope } from '@mistriwork/mistri/policy';
import { resolveIntake, resolvePublicRows } from './server/publicPlacement.ts';
import type { Rows } from './mistri-schema.d.ts';

export default defineAppRowPolicy<Rows>({
  appId: 'site',
  // Canonical staff access is explicit and independent of public host placement.
  // These are still intersected with web_admin's declared resource/field ceilings.
  resolveRows(principal): RowScope {
    return principal.roles.includes('web_admin')
      ? {
          dealer: true,
          dealer_site: true,
          vehicle: true,
          vehicle_photo: true,
          program: true,
          lead: true,
          lead_activity: true,
          applicant: true,
        }
      : {};
  },
  resolvePublicRows,
  // All commands are public; their result declarations belong to the forms below.
  resultReferences: {},
  publicForms: {
    ask: {
      kind: 'placement',
      source: 'keystone',
      resolvePlacement: (intent, context) => resolveIntake(intent, context, false),
      resultReferences: () => [],
    },
    'test-drive': {
      kind: 'placement',
      source: 'keystone',
      resolvePlacement: (intent, context) => resolveIntake(intent, context, false),
      resultReferences: () => [],
    },
    apply: {
      kind: 'placement',
      source: 'keystone',
      resolvePlacement: (intent, context) => resolveIntake(intent, context, true),
      resultReferences: () => [],
    },
  },
});
