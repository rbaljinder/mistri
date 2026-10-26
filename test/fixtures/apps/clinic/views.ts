import { commandForm, listView, navGroup } from '@mistriwork/mistri/app';

export const views = {
  // A clinic's own rooms.
  appointments: listView('Appointments', 'appointment', { show: ['starts_at', 'patient_id', 'status', 'fee_cents'] }),
  patients: listView('Patients', 'patient', { show: ['name', 'phone'] }),
  payments: listView('Payments', 'payment', { show: ['appointment_id', 'amount_cents', 'method'] }),
  services: listView('Services', 'service', { show: ['name', 'price_cents', 'published'] }),
  requests: listView('Visit requests', 'visit_request', { show: ['name', 'phone', 'note'] }),
  notices: listView('Notices', 'notice', { show: ['body'] }),
  // The platform's.
  clinics: listView('Clinics', 'clinic', { show: ['name'], realm: 'platform' }),
  triage: listView('Triage', 'triage', { show: ['name', 'phone', 'note'], realm: 'platform' }),
  'post-notice': commandForm('Post a notice', 'postNotice', { realm: 'platform' }),
  // A visitor's: the request form a clinic publishes with its intake address.
  'request-visit': commandForm('Request a visit', 'requestVisit', { public: true }),
};

export const nav = [
  navGroup('clinic', 'Clinic', ['appointments', 'patients', 'payments', 'services', 'requests', 'notices'], { realm: 'tenant' }),
  navGroup('platform', 'Platform', ['clinics', 'triage', 'post-notice'], { realm: 'platform' }),
];
