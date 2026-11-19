/* `when` offers an entry to the tenants whose shared profile meets it: arrangement only, as `roles` is. Its columns
   are judged against the catalog when the App loads (appTenantProfile.ts), where the profile is known. A nav entry
   and a New menu line (appUi.ts) say it the same way. */
export function parseWhen(value: unknown, at: string): { when?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${at} has a "when" that is not a condition like 'tenant.plan = pro'.`);
  return { when: value.trim() };
}
