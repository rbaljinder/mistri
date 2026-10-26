/**
 * The features that stay Preview at 1.0: one list, read by `mistri check` (the `preview-feature` finding) and by
 * scripts/public-surface.mjs (the inventory's `preview` statuses). They work as documented and may change in any 1.x
 * release; docs/status.md says so beside each, and a root key carries `@preview` in packages/mistri/schema/app.d.ts. A feature
 * leaves the list when it graduates, and the inventory is regenerated in the same commit.
 */

/** Key paths of the App DSL (the inventory's section 1) that are Preview. A path matches when any rule matches it. */
export const PREVIEW_PATHS: readonly RegExp[] = [
  /^resources\.\*\.search(\.|$)/, // a search pack, which ships after 1.0
  /^(flags|audiences|experiments|analytics)(\.|\[|$)/,
  /^auth\.roles\.\*\.(flags|experiments)(\.|\[|$)/,
  /^auth\.roles\.\*\.operations\[\] = "analytics"$/,
  /\[kind=gantt\]/,
];

/** Whole package entry points that are Preview. */
export const PREVIEW_ENTRIES: readonly string[] = ['./openfeature'];

/** Exported names of the Preview features, as `entry: name`. */
export const PREVIEW_EXPORTS: readonly string[] = [
  './app: flag',
  './app: experiment',
  './app: gantt',
  './app: AppFlagGate',
  './app: AppFlagValues',
  './app: AppGanttList',
  './app: AnalyticsDeclaration',
  './app: AnalyticsStep',
  './app: AudienceDefinition',
  './app: ExperimentCapability',
  './app: ExperimentDeclaration',
  './app: FlagCapability',
  './app: FlagDefinition',
  './app: FlagDefinitionOf',
  './app: FlagJson',
  './app: FlagObject',
  './app: FlagOptions',
  './app: FlagValue',
  './commands: ExperimentConversion',
  './commands: defineExperimentConversion',
  './maintenance: AnalyticsFunnel',
  './maintenance: pruneAnalyticsEvents',
  './page: Gantt',
  './ui: FlagReader',
  './ui: useAnalytics',
  './ui: useFlags',
  './ui: useVisitor',
];

/** CLI commands and flags that are Preview, as the inventory names them. */
export const PREVIEW_CLI: readonly string[] = [
  'flag --reindex',
  'command flags',
  'command experiments',
  'command analytics',
  'command suite',
];

interface PreviewApp {
  flags?: object;
  audiences?: object;
  experiments?: object;
  analytics?: unknown;
  auth?: { roles?: Record<string, { flags?: unknown; experiments?: unknown; operations?: readonly string[] } | undefined> };
  views?: Record<string, { presentation?: { kind?: string } } | undefined>;
}

const filled = (value: unknown) => (value && typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(value));

/** The Preview keys an App uses, in a stable order: what `check` lists in its `preview-feature` finding. */
export function previewKeysUsed(app: unknown): string[] {
  const { flags, audiences, experiments, analytics, auth, views } = app as PreviewApp;
  const used: string[] = [];
  if (filled(flags)) used.push('flags');
  if (filled(audiences)) used.push('audiences');
  if (filled(experiments)) used.push('experiments');
  if (filled(analytics)) used.push('analytics');
  const roles = Object.values(auth?.roles ?? {});
  if (roles.some((role) => filled(role?.flags))) used.push('auth.roles.*.flags');
  if (roles.some((role) => filled(role?.experiments))) used.push('auth.roles.*.experiments');
  if (roles.some((role) => role?.operations?.includes('analytics'))) used.push('auth.roles.*.operations: analytics');
  if (Object.values(views ?? {}).some((view) => view?.presentation?.kind === 'gantt')) used.push("presentation kind: 'gantt'");
  return used;
}
