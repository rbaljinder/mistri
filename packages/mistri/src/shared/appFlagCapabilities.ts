/** Scoped flag and experiment capability declarations, reference checks and authority-lock facts. */
import { captureFlagDeclaration, flagDeclarationName, flagDeclarationObject } from './appExperiments.js';
import type { FlagCatalog } from './appFlags.js';

export interface FlagCapability {
  readonly actions: readonly ('view' | 'manage' | 'killswitch')[];
  readonly environments: readonly string[];
  readonly owners: readonly string[];
  readonly ids?: readonly string[];
}
export interface ExperimentCapability {
  readonly actions: readonly ('view' | 'manage' | 'decide')[];
  readonly environments: readonly string[];
  readonly owners: readonly string[];
  readonly ids?: readonly string[];
}
/** Stable entry identity for authority.lock and feature provenance. */
export function flagCapabilityKey(entry: FlagCapability | ExperimentCapability): string {
  return JSON.stringify({
    actions: [...entry.actions].sort(),
    environments: [...entry.environments].sort(),
    owners: [...entry.owners].sort(),
    ...(entry.ids ? { ids: [...entry.ids].sort() } : {}),
  });
}
export function normalizeFlagCapabilities(input: unknown, kind: 'flags'): readonly FlagCapability[];
export function normalizeFlagCapabilities(input: unknown, kind: 'experiments'): readonly ExperimentCapability[];
export function normalizeFlagCapabilities(
  input: unknown,
  kind: 'flags' | 'experiments',
): readonly (FlagCapability | ExperimentCapability)[];
export function normalizeFlagCapabilities(
  input: unknown,
  kind: 'flags' | 'experiments',
): readonly (FlagCapability | ExperimentCapability)[] {
  const raw = captureFlagDeclaration(input);
  const list = (value: unknown): readonly string[] => {
    if (!Array.isArray(value) || !value.length || value.length > 256)
      throw new Error('Flag capability lists must be explicit and nonempty.');
    const names = value.map(flagDeclarationName);
    if (new Set(names).size !== names.length) throw new Error('Duplicate flag capability entry.');
    return names;
  };
  if (!Array.isArray(raw) || !raw.length || raw.length > 256) throw new Error('Flag capabilities must be a nonempty bounded list.');
  for (const value of raw) {
    const entry = flagDeclarationObject(value, ['actions', 'environments', 'owners', 'ids']);
    const actions = kind === 'flags' ? ['view', 'manage', 'killswitch'] : ['view', 'manage', 'decide'];
    if (list(entry.actions).some((action) => !actions.includes(action))) throw new Error(`Unknown ${kind} capability action.`);
    list(entry.environments);
    list(entry.owners);
    if (Object.hasOwn(entry, 'ids')) list(entry.ids);
  }
  return raw as readonly (FlagCapability | ExperimentCapability)[];
}

/** Resolve all authored references, including inactive roles. No valid-looking subset. */
export function checkFlagCapabilityReferences(
  roles: Readonly<Record<string, { flags?: readonly FlagCapability[]; experiments?: readonly ExperimentCapability[] }>>,
  catalog: FlagCatalog,
  experiments: Readonly<Record<string, unknown>>,
): void {
  for (const [role, grant] of Object.entries(roles))
    for (const kind of ['flags', 'experiments'] as const) {
      if (grant[kind] === undefined) continue;
      const entries = normalizeFlagCapabilities(grant[kind], kind);
      const candidates = Object.entries(catalog.flags).filter(([id]) => kind === 'flags' || Object.hasOwn(experiments, id));
      for (const entry of entries) {
        for (const owner of entry.owners)
          if (!candidates.some(([, flag]) => flag.owner === owner))
            throw new Error(`Role "${role}" ${kind} names undeclared owner "${owner}".`);
        for (const id of entry.ids ?? [])
          if (!candidates.some(([key, flag]) => key === id && entry.owners.includes(flag.owner)))
            throw new Error(`Role "${role}" ${kind} names undeclared or differently owned flag "${id}".`);
      }
    }
}
