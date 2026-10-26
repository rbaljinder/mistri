/** The clinic's tables, as test/fixtures/databases/clinic/seed.mjs makes them. */
export type Rows = {
  clinic: { id: string; name: string; intake_address: string | null; public_address: string | null };
  patient: { id: string; clinic_id: string; name: string; phone: string | null };
  appointment: { id: string; clinic_id: string; patient_id: string; starts_at: string; status: string; fee_cents: number };
  payment: { id: string; clinic_id: string; appointment_id: string; amount_cents: number; method: string };
  service: { id: string; clinic_id: string; name: string; price_cents: number; published: number };
  visit_request: { id: string; clinic_id: string; name: string; phone: string; note: string | null };
  notice: { id: string; clinic_id: string; body: string };
  triage: { id: string; name: string; phone: string; note: string | null };
};

export type Tables = { [T in keyof Rows]: Extract<keyof Rows[T], string> };
