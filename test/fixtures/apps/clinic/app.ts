import { defineApp } from '@mistriwork/mistri/app';
import { resources } from './resources.ts';
import { nav, views } from './views.ts';

const clinicReads = ['patient', 'appointment', 'payment', 'service', 'visit_request', 'notice'];

/* A clinic is a tenant; the business that runs every clinic is the platform. A sign-in grants nothing until a
   membership does: a clinic's owner invites its people, the platform's operators are granted by the operator. */
export default defineApp({
  id: 'clinic',
  name: 'Clinic',
  sources: { business: { connection: 'clinic-db' } },
  resources,
  auth: {
    providers: ['email'],
    signUp: 'open',
    rows: 'tenant',
    tenancy: { label: 'Clinic', profile: 'clinic', platform: { label: 'Operator' } },
    public: { read: ['service'], fields: { service: { read: ['id', 'name', 'price_cents'] } } },
    roles: {
      // The owner reads its clinic's log of support visits; the operator, every clinic's.
      owner: {
        label: 'Owner',
        realm: 'tenant',
        read: clinicReads,
        write: ['patient', 'service'],
        commands: ['recordPayment'],
        operations: ['support'],
      },
      reception: { label: 'Reception', realm: 'tenant', read: clinicReads, write: ['patient'], commands: ['recordPayment'] },
      operator: {
        label: 'Operator',
        realm: 'platform',
        read: ['clinic', 'triage', ...clinicReads],
        write: ['clinic'],
        commands: ['postNotice'],
        operations: ['support'],
      },
    },
  },
  views,
  nav,
  home: [{ view: 'request-visit', signedOut: true }, { view: 'appointments' }],
});
