/** Where a test host sends its setup, job runs, a tenant App's memberships and its read audit's reads, and the header its token rides in (http/testControl.ts). */
export const TEST_CONTROL_PATHS = {
  seed: '/api/test/seed',
  job: '/api/test/job',
  membership: '/api/test/membership',
  readAudit: '/api/test/read-audit',
} as const;
export const TEST_CONTROL_HEADER = 'x-mistri-test-control';
