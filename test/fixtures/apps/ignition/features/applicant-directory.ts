import { defineFeature, header, listView, navGroup, page, related } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* The lender's customer file, in a database of its own.

   `applicants` is a **platform-only source** (`sources.applicants.realm:
   'platform'`), which is a stronger statement than a role grant. A dealership's
   context is not built with it: the tables are absent from its catalog and its
   schema, no command may name it or look it up, intake never touches it, and the
   tenant writer has no access to it. Its connection is never `writable: true`.
   So "dealers cannot see the lender's customer file" is not a permission anyone
   can widen — it is a source that is not there.

   Within the platform realm, reads are still narrowed twice: the policy's
   `resolvePlatformRows` names the tables by qualified name, and the column
   ceilings below narrow what a reviewer in particular may read.

   A dealership sees only what its own lead captured. There is no key between
   the two databases, and `loan_application.applicant_ref` is an opaque string,
   not a foreign key — no cross-source join, path or reference exists. */

const verification = { tone: { pending: 'neutral', verified: 'good', needs_review: 'warn' } } as const;

export const applicantDirectory = defineFeature({
  id: 'applicant-directory',
  resources: {
    'applicants.applicant': { display: { verification_status: verification } },
    'applicants.residence': { display: { monthly_housing_cost: { format: 'money' } } },
    'applicants.employment': { display: { stated_annual_income: { format: 'money' }, verification_status: verification } },
  },
  auth: {
    roles: {
      /* Column ceilings for the reviewer role: the applicant's preferred name,
         street address, postal code, housing cost, contact values, employer, job
         title and stated income stay out of its reads, enforced by the server's
         projection and not by the UI. A reviewer checks an application; the
         lender's full customer file is a manager's to read.

         Keys and the label column stay readable so the directory still resolves.
         A screen that names a hidden column is withheld from the role whole
         rather than drawn with gaps, which is why the lists below were written
         not to name one and the applicant record page — which does — simply does
         not open for a reviewer. */
      reviewer: {
        read: ['applicants.applicant', 'applicants.residence', 'applicants.contact', 'applicants.employment'],
        fields: {
          'applicants.applicant': { read: ['id', 'name', 'reference', 'created_on', 'verification_status'] },
          'applicants.contact': { read: ['id', 'applicant_id', 'name', 'kind', 'verified', 'preferred'] },
          'applicants.residence': { read: ['id', 'applicant_id', 'name', 'city', 'region', 'tenure', 'months_at_address', 'current'] },
          'applicants.employment': { read: ['id', 'applicant_id', 'name', 'kind', 'months_employed', 'verification_status'] },
        },
      },
    },
  },
  views: {
    applicants: listView('Applicants', 'applicants.applicant', {
      icon: 'user-circle',
      realm: 'platform',
      show: ['name', 'reference', 'verification_status', 'created_on'],
      filters: ['name', 'reference', 'verification_status'],
    }),
    residences: listView('Residences', 'applicants.residence', {
      icon: 'house',
      realm: 'platform',
      show: ['applicant_id.name', 'name', 'city', 'tenure', 'months_at_address'],
    }),
    // The directory lists name what a desk scans for; the address, contact
    // value, employer and income are on the applicant record. That is also what
    // lets the reviewer's column ceiling hide those columns without leaving a
    // list that cannot be drawn for that role.
    contacts: listView('Contact details', 'applicants.contact', {
      icon: 'phone',
      realm: 'platform',
      show: ['applicant_id.name', 'kind', 'verified', 'preferred'],
      filters: ['kind', 'verified'],
    }),
    employment: listView('Employment', 'applicants.employment', {
      icon: 'briefcase',
      realm: 'platform',
      show: ['applicant_id.name', 'kind', 'months_employed', 'verification_status'],
      filters: ['kind', 'verification_status'],
    }),
  },
  pages: {
    applicant: page(
      'applicants.applicant',
      [
        header({ status: 'verification_status', facts: ['reference', 'preferred_name', 'created_on'] }),
        related('Contact details', 'applicants.contact', 'applicant_id', { show: ['kind', 'value', 'verified', 'preferred'] }),
        related('Residences', 'applicants.residence', 'applicant_id', {
          show: ['address_line', 'city', 'tenure', 'monthly_housing_cost'],
        }),
        related('Employment', 'applicants.employment', 'applicant_id', {
          show: ['employer', 'job_title', 'stated_annual_income', 'verification_status'],
        }),
      ],
      { listTabs: true, realm: 'platform' },
    ),
  },
  nav: [
    navGroup('lender-applicants', 'Applicant directory', ['applicants', 'residences', 'contacts', 'employment'], { realm: 'platform' }),
  ],
} satisfies Feature);
