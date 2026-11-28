/**
 * Declarative progressive-disclosure skills for `assistant(...)` (Wave 4B).
 *
 * Security & token-efficiency invariants:
 * - Only skill `id`, `label`, and 1-line `description` are projected into the system prompt and browser payload.
 * - Full procedural `instructions` load on demand only when the model calls `load_skill({ name })`.
 * - Role-gated skills are filtered per viewer and never leak `roles` or `instructions` to `/api/app`.
 */

const SKILL_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_SKILLS = 16;
const SKILL_KEYS = ['label', 'description', 'instructions', 'roles'] as const;

export interface AppAssistantSkill {
  id: string;
  label: string;
  description: string;
  instructions: string;
  roles?: string[];
}

/** Viewer-safe skill summary served in `/api/app` (never leaks `instructions` or `roles`). */
export interface ServedAssistantSkill {
  id: string;
  label: string;
  description: string;
}

export function parseAssistantSkills(
  raw: unknown,
  allowedRoles: readonly string[] | undefined,
  where: string,
): Record<string, AppAssistantSkill> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} is an object keyed by skill id.`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_SKILLS) {
    throw new Error(`${where} declares 1 to ${MAX_SKILLS} skills.`);
  }
  const out: Record<string, AppAssistantSkill> = {};
  for (const [id, spec] of entries) {
    const at = `${where}.${id}`;
    if (!SKILL_ID.test(id)) {
      throw new Error(`${at} has an invalid skill id: use lowercase letters, digits, hyphens, underscores.`);
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${at} is an object: { label, description, instructions, roles? }.`);
    }
    const s = spec as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (!(SKILL_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${at} has an unknown key "${key}"; it takes ${SKILL_KEYS.join(', ')}.`);
      }
    }
    if (typeof s.label !== 'string' || !s.label.trim() || s.label.trim().length > 80) {
      throw new Error(`${at}.label is a non-empty string up to 80 characters.`);
    }
    if (typeof s.description !== 'string' || !s.description.trim() || s.description.trim().length > 240) {
      throw new Error(`${at}.description is a non-empty string up to 240 characters.`);
    }
    if (typeof s.instructions !== 'string' || !s.instructions.trim() || s.instructions.trim().length > 8000) {
      throw new Error(`${at}.instructions is a non-empty string up to 8000 characters.`);
    }
    let roles: string[] | undefined;
    if (s.roles !== undefined) {
      if (!allowedRoles) throw new Error(`${at}.roles names roles, and the App declares no "auth" with roles.`);
      if (!Array.isArray(s.roles) || !s.roles.length || s.roles.some((r) => typeof r !== 'string' || !r)) {
        throw new Error(`${at}.roles is a non-empty list of role names.`);
      }
      for (const r of s.roles as string[]) {
        if (!allowedRoles.includes(r)) throw new Error(`${at}.roles names "${r}", which is not one of the App's roles.`);
      }
      roles = [...new Set(s.roles as string[])];
    }
    out[id] = {
      id,
      label: s.label.trim(),
      description: s.description.trim(),
      instructions: s.instructions.trim(),
      ...(roles ? { roles } : {}),
    };
  }
  return out;
}

/** Viewer-safe skills projection (filters by `roles` and strips `roles`). */
export function skillsFor(
  skills: ReadonlyArray<ServedAssistantSkill & { roles?: readonly string[] }> | undefined,
  roles: readonly string[],
): ServedAssistantSkill[] {
  if (!skills?.length) return [];
  return skills.filter((skill) => !skill.roles || skill.roles.some((r) => roles.includes(r))).map(({ roles: _roles, ...rest }) => rest);
}
