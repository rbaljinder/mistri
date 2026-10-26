/**
 * What this App calls its roles (`auth.roles.<id>.label`), as the sign-in
 * answer said them. Words for a person only: every choice and request still
 * names the id, so a missing or odd label never changes what is granted.
 */
const labels = new Map<string, string>();

const isLabel = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 60 && value.trim() === value && !/\p{Cc}/u.test(value);

/** The labels from `/api/whoami`'s `roleLabels`; anything else there is ignored, and the previous App's go. */
export function setRoleLabels(value: unknown): void {
  labels.clear();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [role, label] of Object.entries(value)) if (isLabel(label)) labels.set(role, label);
}

let kept = false;
/** From `/api/whoami`'s `hasRoles`: whether the App names roles at all. */
export function setAppKeepsRoles(value: unknown): void {
  kept = value === true;
}
export const appKeepsRoles = (): boolean => kept;

/** The App's own name for a role, where it gave one. */
export const roleLabel = (role: string): string | undefined => labels.get(role);
