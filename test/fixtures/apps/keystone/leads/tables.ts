import type { Tables } from './mistri-schema.d.ts';

/* Keystone's thirty-one tables by owner (SUITE.md, "Who owns each table").
   A tenant App's database may hold only its declared resources, so every one
   is declared here, including the lender's tables no role of this App reads. */

/** A dealer's own rows, owned through `dealer_id`. */
export const dealerTables = [
  'dealer_site',
  'dealer_user',
  'vehicle',
  'vehicle_photo',
  'lead',
  'lead_activity',
  'applicant',
  'deal',
  'trade_in',
  'deal_scenario',
  'loan_application',
  'stipulation',
] as const;

/** The lender's own. `dealer` is the tenancy profile: one row per dealer, its id the tenant id.
    Not checked against `Tables`: the generated types hold what some role of
    this App can read, and most of these no role here reads at all. */
export const lenderTables = [
  'dealer',
  'lender_user',
  'dealer_visit',
  'underwriting_file',
  'underwriting_note',
  'decision_alert',
  'funding',
  'intake_submission',
  'customer',
  'loan',
  'installment',
  'payment',
  'autopay',
  'payoff_quote',
  'loan_document',
  'servicing_note',
  'prequalification',
  'saved_vehicle',
] as const;

/** What a dealer's people read: their own working tables and the rate sheet.
    Naming them says what the realm is; a tenant role's reads stop at the
    lender's tables whatever this says. */
export const dealerReads = [
  'vehicle',
  'vehicle_photo',
  'lead',
  'lead_activity',
  'applicant',
  'deal',
  'trade_in',
  'deal_scenario',
  'loan_application',
  'stipulation',
  'dealer_user',
  'program',
] as const satisfies readonly (keyof Tables)[];

/** What Keystone's dealer support reads: every dealer's pipeline, the dealer
    profiles, the triage queue and the late-decision alerts. Not the lender's
    underwriting, funding or servicing: those are the lender App's. */
export const supportReads = [
  'dealer',
  'intake_submission',
  'decision_alert',
  'lead',
  'lead_activity',
  'deal',
  'deal_scenario',
  'trade_in',
  'loan_application',
  'stipulation',
  'vehicle',
  'dealer_user',
  'program',
] as const satisfies readonly (keyof Tables)[];
