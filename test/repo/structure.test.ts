// test-package: shared — a check of the repository that names both binaries (scripts/test-owners.mjs).
/*
 * The repository's shape, pinned: how large a module may grow, which layer
 * may import which, that a module says what it owns, and where tests live.
 * Every rule starts from an allowlist equal to today's exceptions. An
 * allowlist only shrinks — a new exception fails, and so does an entry that
 * no longer is one — so each split, header and layering fix is kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanes, parseHeadStart, shard } from '../../scripts/test-node.mjs';
import { lanes as browserLanes } from '../../scripts/e2e-lanes.mjs';
import { ownerOf, suites } from '../../scripts/test-owners.mjs';
import { sourceGraph } from './runtimeCycles.js';
import { inPackages } from '../support/packages.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).map((file) => join(dir, file).split('\\').join('/'));
const TEST = /\.test\.(ts|tsx|js|mjs)$/;
/** Non-test code under every package's src/: what the size, header and boundary rules govern. */
const sources = inPackages('src')
  .flatMap(walk)
  .filter((file) => /\.(ts|tsx|js|mjs)$/.test(file) && !TEST.test(file) && !file.endsWith('.d.ts'))
  .sort();
/* A module's path inside its package (`packages/kit/src/client/core.js` is `src/client/core.js`): the folders by where
   a module runs are the same in every package. */
const local = (file: string) => file.replace(/^packages\/[^/]+\//, '');
const PACKAGE_DIRS: Record<string, string> = {
  '@mistriwork/engine': 'packages/engine',
  '@mistriwork/kit': 'packages/kit',
  '@mistriwork/ui': 'packages/ui',
  '@mistriwork/mistri': 'packages/mistri',
  tablewalk: 'packages/tablewalk',
};
/** Where an import lands, as a repository path: a relative name, or a workspace package's module by its path. */
function landing(file: string, specifier: string): string | undefined {
  if (specifier.startsWith('.'))
    return relative(root, resolve(join(root, dirname(file)), specifier))
      .split('\\')
      .join('/');
  const named = /^(@mistriwork\/[a-z]+|tablewalk)\/((?:client|server|shared|adapters|embed|schema)\/.+)$/.exec(specifier);
  if (!named || !PACKAGE_DIRS[named[1]]) return undefined;
  return `${PACKAGE_DIRS[named[1]]}/${named[2].startsWith('schema/') ? '' : 'src/'}${named[2]}`;
}
const lines = (file: string) => readFileSync(join(root, file), 'utf8').split('\n').length;

/**
 * 1,500 lines is a signal, not a rule: a module past it is named in the test
 * output as one to split along its seams when that is worth doing. 2,250 is
 * the one hard stop. Both were 1,000 and 1,500 until oxfmt laid the code out
 * one clause to a line, which made the same modules about half again as tall.
 */
test('no source module passes 2,250 lines; past 1,500 is noted', (t) => {
  const over: string[] = [];
  const noted: string[] = [];
  for (const file of sources) {
    const n = lines(file);
    if (n > 2250) over.push(`${file} has ${n} lines; split it along its seams (the hard stop is 2,250).`);
    else if (n > 1500) noted.push(`${file} (${n})`);
  }
  if (noted.length) t.diagnostic(`past 1,500 lines, worth a split when convenient: ${noted.join(', ')}`);
  assert.deepEqual(over, []);
});

/**
 * A module opens with a comment saying what it owns and why it is separate.
 * Components under 300 lines (200 before oxfmt's taller layout) are exempt: their name and props say it. These
 * are the modules that open with code today; each gains its header when it
 * is next split or reworked.
 */
const HEADERLESS = new Set([
  'packages/mistri/src/adapters/commands/commandJournal.ts',
  'packages/mistri/src/adapters/commands/commandJournalTypes.ts',
  'packages/mistri/src/adapters/events/commandEventSchema.ts',
  'packages/mistri/src/adapters/events/commandEventStore.ts',
  'packages/mistri/src/adapters/events/eventDeliverySchema.ts',
  'packages/mistri/src/adapters/events/eventDeliverySource.ts',
  'packages/mistri/src/adapters/events/eventDeliveryStore.ts',
  'packages/mistri/src/adapters/events/eventDeliveryTypes.ts',
  'packages/mistri/src/adapters/events/eventSourceIdentity.ts',
  'packages/mistri/src/adapters/jobs/jobStore.ts',
  'packages/mistri/src/adapters/jobs/jobStoreSchema.ts',
  'packages/mistri/src/adapters/jobs/jobStoreTypes.ts',
  'packages/engine/src/adapters/scoped/scopedReads.ts',
  'packages/engine/src/adapters/scoped/scopedTransaction.ts',
  'packages/engine/src/adapters/scoped/sqliteScopeCatalog.ts',
  'packages/engine/src/adapters/scoped/updateGuard.ts',
  'packages/mistri/src/client/accountProfile.ts',
  'packages/mistri/src/client/appHeader.ts',
  'packages/mistri/src/client/appLabels.ts',
  'packages/mistri/src/client/commandState.ts',
  'packages/kit/src/client/connectionScope.ts',
  'packages/kit/src/client/draftRecovery.ts',
  'packages/kit/src/client/historyToken.ts',
  'packages/kit/src/client/layoutDraftRecovery.ts',
  'packages/kit/src/client/menuScope.ts',
  'packages/kit/src/client/recordDrafts.ts',
  'packages/kit/src/client/recordEditValidation.ts',
  'packages/kit/src/client/recordSource.ts',
  'packages/kit/src/client/recordWriteRefresh.ts',
  'packages/kit/src/client/relatedRows.ts',
  'packages/kit/src/client/requestIdentity.ts',
  'packages/kit/src/client/resourceRequests.ts',
  'packages/kit/src/client/sessionIdentity.ts',
  'packages/kit/src/client/sessionLifecycle.ts',
  'packages/mistri/src/client/tenantAdministration.ts',
  'packages/mistri/src/client/tenantBrowser.ts',
  'packages/mistri/src/client/tenantInvitations.ts',
  'packages/mistri/src/client/tenantLink.ts',
  'packages/mistri/src/client/tenantMutationState.ts',
  'packages/mistri/src/client/tenantNavigation.ts',
  'packages/mistri/src/client/tenantRenewal.ts',
  'packages/mistri/src/client/tenantSuspension.ts',
  'packages/mistri/src/client/tenantTransport.ts',
  'packages/kit/src/client/toast.ts',
  'packages/kit/src/client/updateAttempts.ts',
  'packages/kit/src/client/visualTheme.ts',
  'packages/mistri/src/server/app/appAccess.ts',
  'packages/mistri/src/server/app/appEntrypoint.ts',
  'packages/mistri/src/server/app/appErrors.ts',
  'packages/mistri/src/server/app/appFieldProjection.ts',
  'packages/mistri/src/server/app/appResources.ts',
  'packages/mistri/src/server/app/appRuntimeResources.ts',
  'packages/mistri/src/server/app/appSourceAdapter.ts',
  'packages/mistri/src/server/app/appSourceCatalog.ts',
  'packages/mistri/src/server/app/appValidation.ts',
  'packages/mistri/src/server/auth/accountProfile.ts',
  'packages/mistri/src/server/auth/authStoreSeparation.ts',
  'packages/mistri/src/server/commands/businessCommandAccess.ts',
  'packages/mistri/src/server/commands/businessCommandAuthorization.ts',
  'packages/mistri/src/server/commands/businessCommandExecution.ts',
  'packages/mistri/src/server/commands/businessCommandHttp.ts',
  'packages/mistri/src/server/commands/businessCommandLoader.ts',
  'packages/mistri/src/server/commands/scopedBusinessCommandAccess.ts',
  'packages/mistri/src/server/events/eventProducer.ts',
  'packages/mistri/src/server/events/eventPublisher.ts',
  'packages/mistri/src/server/jobs/jobRunner.ts',
  'packages/mistri/src/server/jobs/jobs.ts',
  'packages/engine/src/server/operations/diagnostics.ts',
  'packages/mistri/src/server/operations/operations.ts',
  'packages/mistri/src/server/operations/operationsAdapter.ts',
  'packages/mistri/src/server/operations/operationsHeadless.ts',
  'packages/mistri/src/server/policy/appPolicyContext.ts',
  'packages/mistri/src/server/policy/appPolicyDeployment.ts',
  'packages/mistri/src/server/policy/appPolicyHttp.ts',
  'packages/mistri/src/server/policy/appPolicyResources.ts',
  'packages/mistri/src/server/policy/appPolicyUpdates.ts',
  'packages/mistri/src/server/policy/appRowPolicy.ts',
  'packages/mistri/src/server/policy/appTenantPolicy.ts',
  'packages/mistri/src/server/policy/scopedTransactionFacade.ts',
  'packages/engine/src/server/recordHistoryOperations.ts',
  'packages/engine/src/server/recordWriteOperations.ts',
  'packages/engine/src/server/resourceReadHttp.ts',
  'packages/engine/src/server/resourceReadOperations.ts',
  'packages/mistri/src/server/tenant/tenantAdministration.ts',
  'packages/mistri/src/server/tenant/tenantAdministrationHttp.ts',
  'packages/mistri/src/server/tenant/tenantAdministrationJournal.ts',
  'packages/mistri/src/server/tenant/tenantAdministrationModel.ts',
  'packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts',
  'packages/mistri/src/server/tenant/tenantBootstrap.ts',
  'packages/mistri/src/server/tenant/tenantCapabilities.ts',
  'packages/mistri/src/server/tenant/tenantCommandTransaction.ts',
  'packages/mistri/src/server/tenant/tenantCommands.ts',
  'packages/mistri/src/server/tenant/tenantContexts.ts',
  'packages/mistri/src/server/tenant/tenantDeployment.ts',
  'packages/mistri/src/server/tenant/tenantEnrollment.ts',
  'packages/mistri/src/server/tenant/tenantHistoryPartitions.ts',
  'packages/mistri/src/server/tenant/tenantHttp.ts',
  'packages/mistri/src/server/tenant/tenantInverseImages.ts',
  'packages/mistri/src/server/tenant/tenantInvitationChange.ts',
  'packages/mistri/src/server/tenant/tenantInvitationHttp.ts',
  'packages/mistri/src/server/tenant/tenantInvitationLinks.ts',
  'packages/mistri/src/server/tenant/tenantInvitationModel.ts',
  'packages/mistri/src/server/tenant/tenantInvitationOperations.ts',
  'packages/mistri/src/server/tenant/tenantInvitationStore.ts',
  'packages/mistri/src/server/tenant/tenantInvitationToken.ts',
  'packages/mistri/src/server/tenant/tenantInvocation.ts',
  'packages/mistri/src/server/tenant/tenantManagedTransaction.ts',
  'packages/mistri/src/server/tenant/tenantMembership.ts',
  'packages/mistri/src/server/tenant/tenantMetadata.ts',
  'packages/mistri/src/server/tenant/tenantOwnership.ts',
  'packages/mistri/src/server/tenant/tenantPageOperations.ts',
  'packages/mistri/src/server/tenant/tenantReadRuntime.ts',
  'packages/mistri/src/server/tenant/tenantReadScope.ts',
  'packages/mistri/src/server/tenant/tenantReadSource.ts',
  'packages/mistri/src/server/tenant/tenantRecordHistory.ts',
  'packages/mistri/src/server/tenant/tenantRequestRuntime.ts',
  'packages/mistri/src/server/tenant/tenantRetirement.ts',
  'packages/mistri/src/server/tenant/tenantRuntimeClock.ts',
  'packages/mistri/src/server/tenant/tenantSourceIdentity.ts',
  'packages/mistri/src/server/tenant/tenantStartup.ts',
  'packages/mistri/src/server/tenant/tenantStore.ts',
  'packages/mistri/src/server/tenant/tenantVisibleFields.ts',
  'packages/mistri/src/server/tenant/tenantWriteRuntime.ts',
  'packages/mistri/src/server/tenant/tenantWriteSource.ts',
  'packages/mistri/src/shared/command.ts',
  'packages/engine/src/shared/form.ts',
  'packages/mistri/src/shared/formRules.ts',
  'packages/engine/src/shared/relatedCreate.ts',
  'packages/engine/src/shared/scopeCatalog.ts',
  'packages/engine/src/shared/tableSizing.ts',
  'packages/mistri/src/shared/tenantInvitations.ts',
  'packages/engine/src/shared/theme.ts',
  'packages/engine/src/shared/themePresets.ts',
]);

test('every source module opens with a header comment', () => {
  const problems: string[] = [];
  for (const file of sources) {
    const text = readFileSync(join(root, file), 'utf8');
    const exempt = local(file).startsWith('src/client/components/') && text.split('\n').length < 300;
    const first =
      text
        .split('\n')
        .find((line) => line.trim() && !line.startsWith('#!'))
        ?.trim() ?? '';
    const headed = exempt || /^(\/\/|\/\*)/.test(first);
    if (!headed && !HEADERLESS.has(file)) problems.push(`${file} opens with code; start it with a comment saying what the module owns.`);
    if (headed && HEADERLESS.has(file)) problems.push(`${file} now has a header (or is exempt); remove it from HEADERLESS.`);
  }
  for (const file of HEADERLESS) if (!sources.includes(file)) problems.push(`${file} is in HEADERLESS but no longer exists; remove it.`);
  assert.deepEqual(problems, []);
});

/**
 * The layers: shared imports only shared; the client imports the client and
 * shared; adapters import shared (and their drivers); the server imports
 * anything but the client. schema/ is the public DSL's type declarations
 * and may be imported from anywhere. There are no exceptions: a crossing is
 * fixed by moving the shared rule into shared/, as the filter, the limit
 * policy, canonical JSON and the event checks were.
 *
 * These are folders by where a module runs, not the package matrix
 * (scripts/check-boundary.mjs, docs/boundary.md), which says who installs
 * it: the kit may import the engine, and the engine holds the server's data
 * paths, so only this rule keeps a server module out of the page.
 */
const LAYERS: Record<string, string[]> = {
  shared: ['shared'],
  client: ['client', 'shared'],
  adapters: ['adapters', 'shared'],
  server: ['server', 'shared', 'adapters'],
};

test('imports keep to the layers', () => {
  const problems: string[] = [];
  const IMPORT =
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const file of sources) {
    const layer = local(file).split('/')[1];
    const allowed = LAYERS[layer];
    if (!allowed) continue;
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const target = landing(file, specifier);
      if (!target) continue;
      const [top, folder] = local(target).split('/');
      if (top === 'schema' || (top === 'src' && allowed.includes(folder))) continue;
      problems.push(`${file} -> ${target}: ${layer} may import only ${allowed.join(', ')}.`);
    }
  }
  assert.deepEqual(problems, []);
});

/* What a first visit downloads is every module its entry and surface import
   statically (vite.config.ts, `surfaces`), and every export of each, used or
   not: a part loaded on demand may call it from its own chunk, so the
   bundler keeps it where the module lives. The App's manifest parser is the
   server's — the client is sent a parsed App — and it once rode into every
   App and Workbench page this way: 27 modules imported `humanName` from
   app.ts, which installs its key homes at load, which import every parser's
   key list, the page parser among them (scripts/bundle-budget.mjs). A client
   module wants a helper from appModel.ts, appNoun.ts or a module of its own;
   the page builder parses on demand. */
const FIRST_PAINT_ROOTS = [
  'packages/kit/src/client/boot.js',
  'packages/mistri/src/client/appShell.js',
  'packages/mistri/src/client/publicSurface.js',
  'packages/kit/src/client/app.js',
  'packages/mistri/src/client/appnav.js',
  'packages/tablewalk/src/client/workbenchShell.js',
  'packages/tablewalk/src/client/workbench.js',
  'packages/mistri/src/client/tenantShell.js',
];
const MANIFEST_PARSER = [
  'packages/mistri/src/shared/app.ts',
  'packages/mistri/src/shared/appPages.ts',
  'packages/engine/src/shared/pageConfig.ts',
  'packages/engine/src/shared/page.ts',
  'packages/engine/src/shared/appComponents.ts',
  'packages/mistri/src/shared/appKeyHomes.ts',
];

test('no first paint imports the App manifest parser', () => {
  const graph = sourceGraph(root, { onDemand: false });
  const from = new Map<string, string | null>(FIRST_PAINT_ROOTS.map((file) => [file, null]));
  const pending = [...FIRST_PAINT_ROOTS];
  for (const file of FIRST_PAINT_ROOTS) assert.ok(graph.has(file), `${file} is no longer a first page's module; update FIRST_PAINT_ROOTS.`);
  while (pending.length) {
    const file = pending.shift()!;
    for (const next of graph.get(file) ?? [])
      if (!from.has(next)) {
        from.set(next, file);
        pending.push(next);
      }
  }
  const chain = (file: string): string => {
    const path = [file];
    for (let at = from.get(file); at; at = from.get(at)) path.unshift(at);
    return path.join(' -> ');
  };
  assert.deepEqual(
    MANIFEST_PARSER.filter((file) => from.has(file)).map(chain),
    [],
    'A first paint imports the manifest parser. Import the helper from a lighter module, or load the caller on demand.',
  );
});

/* Who may reach into tenancy. `src/server/tenant/` is the largest thing in
   the codebase, and until `tenantData.ts` moved out to `evidence.ts` almost
   every arrow pointing into it was that one generic helper — 38 modules
   outside the folder imported it, and the boundary said nothing. What is left
   is the real surface: the three public barrels (`@mistriwork/mistri/commands`,
   `/policy`, `/maintenance`), the modules named for tenancy, and the entry
   points that compose a tenant deployment. An allowlist that only shrinks:
   adding a file here means a new module learned about tenancy, which is a
   decision worth making on purpose. */
const TENANT_IMPORTERS = [
  'packages/mistri/src/server/api/apiTenantCommandCatalog.ts',
  'packages/mistri/src/server/api/apiTenantReadCatalog.ts',
  // A row-policy App's API request is branded the way a tenant's is (tenantApiRequest.ts), so the
  // policy's verifier asks the bearer token, never a session; `serve` composes that brand at startup.
  'packages/mistri/src/server/api/policyApiOwner.ts',
  'packages/mistri/src/server/api/tenantApiReadOwner.ts',
  'packages/mistri/src/server/cli/apiTokenTenant.ts',
  'packages/mistri/src/server/cli/appMcpMode.ts',
  // `mistri dev` and `mistri test init` are a developer's entry points on their own machine: dev signs each
  // role in as a member, test init reads the tenants it writes tests for (tenant/tenantLocalAccess.ts).
  'packages/mistri/src/server/cli/devMode.ts',
  // `--reindex` is an operator's entry point: a tenant App's index keeps each
  // row's tenant, which only the tenant policy's ownership names.
  'packages/mistri/src/server/cli/reindex.ts',
  'packages/mistri/src/server/cli/serve.ts',
  'packages/mistri/src/server/cli/tenant.ts',
  // `mistri tenant clone|import|clock` is an operator's entry point: it validates the deployment as a start
  // does, and runs the sandbox steps of tenant maintenance.
  'packages/mistri/src/server/cli/tenantCommand.ts',
  'packages/mistri/src/server/cli/testInitTenant.ts',
  'packages/mistri/src/server/commands.ts',
  'packages/mistri/src/server/commands/businessCommandAccess.ts',
  // Suite composition is an entry point for an enrolled tenant App; tenant
  // runtime and policy still stay in their existing tenant modules.
  'packages/mistri/src/server/http/suiteTenant.ts',
  // The test host's setup routes (token, loopback and NODE_ENV=test only) make a tenant and a member the way
  // `mistri dev` does, so a tenant App's tests start from the same local access.
  'packages/mistri/src/server/http/testControl.ts',
  'packages/mistri/src/server/maintenance.ts',
  'packages/mistri/src/server/policy.ts',
  'packages/mistri/src/server/policy/appTenantPolicy.ts',
  // The store registry names the tenant stores' layouts beside every other store's, so one upgrade reads them all.
  'packages/mistri/src/server/storeLayouts.ts',
];

test('only the tenant folder, its barrels and its entry points import tenancy', () => {
  const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  const reaching = new Set<string>();
  for (const file of sources) {
    if (!local(file).startsWith('src/') || local(file).startsWith('src/server/tenant/')) continue;
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(IMPORT)) {
      const target = landing(file, match[1] ?? match[2]);
      if (target && local(target).startsWith('src/server/tenant/')) reaching.add(file);
    }
  }
  const unexpected = [...reaching].filter((file) => !TENANT_IMPORTERS.includes(file)).sort();
  assert.deepEqual(unexpected, [], 'A module outside tenancy imported it. Compose at an entry point, or say why here.');
  const stale = TENANT_IMPORTERS.filter((file) => !reaching.has(file));
  assert.deepEqual(stale, [], 'This file no longer imports tenancy: take it off the list rather than leaving the door open.');
});

/* What the vanilla side may reach for inside `components/`.
   The client is two halves: stores, models and the walk in `.js`/`.ts`, and
   the React tree under `components/`. The designed crossing is `mount` and
   `onDemand` — a vanilla module hands a part a host element, or names a
   chunk to load — and 35 and 14 files respectively use them, which is the
   shape working as intended. Everything else listed here is a module that
   happens to live under `components/` and is read by the other half: a model
   with no React in it, or a dialog a store opens. Each is a crossing someone
   chose; the list only shrinks, so a new one is a decision rather than a
   drift, and moving a React-free model up to `src/client/` retires its entry.
   The other direction — components reading stores — is not restricted: that
   is the model layer being read, and there are 374 of those. */
const CLIENT_CROSSINGS = [
  'AccountControl',
  // The App's action bar and reach, installed as the shell's slots (shellMode.ts) by appnav.js at boot.
  'Actions',
  'AgentConsole',
  // The App's home, named as the shell's `rooms` (shellMode.ts) by appnav.js: drawn by Content when the walk is empty.
  'AppHome',
  'AppIssues',
  // The failed-save overlay: drawn by appLive.ts, itself a chunk app.js loads only for a watched App.
  'AppReloadProblem',
  // A call to action into another App of the suite, installed as the shell's slots by appnav.js.
  'AppTargetAction',
  'Ask',
  // The assistant's page, named as the shell's `rooms` by appnav.js and fetched on demand.
  'AssistantPanel',
  // The bar's assistant button: a few lines in the shell, its panel fetched on demand behind it.
  'AssistantTrigger',
  'Composer',
  'ConnectionDialog',
  'ConnectionManager',
  'ConnectionPicker',
  'Content',
  // An embedded list's own component (sdk/), installed as the shell's slots by appnav.js and fetched on demand.
  'CustomList',
  // An author's page section (sdk/), installed as the shell's slots by appnav.js and fetched on demand.
  'CustomSection',
  // The App's dashboard room, named as the shell's `rooms` (shellMode.ts) by appnav.js and fetched on demand.
  'Dashboard',
  // A record's document, named as the shell's `rooms` by appnav.js and fetched on demand.
  'Document',
  // The dev observer (observe/) is a React page of its own, and wears the tool's listbox.
  'Dropdown',
  'EnterDealerDialog',
  'FindValue',
  // A New form's lines, installed as the shell's slots by appnav.js and fetched the first time a form has them.
  'FormLines',
  // A saved form's account screen and status check, each fetched when its page is shown.
  'FormClaimSurface',
  // A signed-in form's room, named as the shell's `rooms` by appnav.js.
  'FormRoom',
  'FormStatusSurface',
  'FormSurface',
  // A free-form page's room, named as the shell's `rooms` by appnav.js.
  'FreePage',
  'HelpPanel',
  'History',
  // The inbox's page, named as the shell's `rooms` by appnav.js and fetched on demand.
  'InboxList',
  // The shell mounts its authored brand mark and mobile navigation directly.
  'Icon',
  // A list's import, installed as the shell's slots by appnav.js.
  'ImportButton',
  'LandingSurface',
  'LayoutBuilder',
  'MobileNavDrawer',
  // The header's New menu: its host is in the shell, the menu fetched on demand when an App declares one.
  'NewMenu',
  'NewRecord',
  // The OAuth consent page: oauthConsent.js is a chunk shellStart.js loads only for a sign-in address with ?authorize=.
  'OAuthConsent',
  'OverflowMenu',
  'PageBuilder',
  'Palette',
  'Peek',
  'PeekPanel',
  // The public form host mounts this on demand, like SavedFormSurface. Keeping
  // its entry here leaves the operation owner React-free and avoids a lazy
  // FormSurface -> PlacedFormSurface -> FormSurface dependency cycle.
  'PlacedFormSurface',
  'Prefs',
  'Prompt',
  'RecordModal',
  // A public form saved on every step, fetched when one is shown.
  'SavedFormSurface',
  'ShapeCheck',
  'Sidebar',
  'SignIn',
  // A split's record room, named as the shell's `rooms` by appnav.js.
  'SplitRecordRoom',
  'TimelineComposer',
  'SqlPane',
  // Which of a suite's Apps opens first, installed as the shell's slots by appnav.js.
  'SuiteAppPreference',
  'SupportBanner',
  'SupportLog',
  // The platform's cross-tenant support sessions: opened the way SupportLog is, a dialog loaded on demand.
  'SupportSessions',
  'TenantChooser',
  'ThMenu',
  'ThemeLab',
  'TopNav',
  'Tour',
  // The form a headline link opens over its record (`open: 'modal'`), a public form or a signed-in one, installed as
  // the shell's slots by appnav.js and fetched on demand.
  'ViewFormDialog',
  'Welcome',
  'WriteConfirm',
  'appListModel',
  'appRooms',
  // A selection's and a tag's commands (sdk/commands.tsx), installed as the shell's slots by appnav.js.
  'commands',
  'dashboardModel',
  // A record field's suggestion and a list cell's mark, installed as the shell's slots by appnav.js; the chip they draw
  // is fetched on demand.
  'decisionAdornment',
  'decisionMarks',
  'editInteraction',
  'listNavigation',
  'myViews',
  'navCounts',
  'navigationTree',
  'pageDraft',
  'pageModel',
  'recordSurface',
  'sidebarModel',
  'useRecordInsert',
  // yesNoRule.ts takes only the DisplayRule type, erased at build: nothing of the record room is loaded.
  'viewLink',
  // Where an App's components are fetched from, installed by surfaceShell.js for pages served without app.js.
  'appComponents',
  // An App list's presentation chain, installed as the shell's `present` by appnav.js.
  'presentedList',
  // The server-sent event reader, React-free: live sync's stream (liveSync.ts) reads its frames with the assistant's.
  'assistantStream',
];

test('outside components/, the client crosses into it only where it was meant to', () => {
  // A type-only import is erased before the browser sees it, so it crosses nothing.
  const IMPORT = /(?:^|\n)\s*(?:import|export)\s(?!type\s)[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  const crossed = new Set<string>();
  const problems: string[] = [];
  for (const file of sources) {
    if (!local(file).startsWith('src/client/') || local(file).includes('/components/') || /\.(test|spec)\./.test(file)) continue;
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(IMPORT)) {
      const target = landing(file, match[1] ?? match[2]);
      if (!target?.includes('src/client/components/')) continue;
      const name = target.slice(target.lastIndexOf('/') + 1).replace(/\.js$/, '');
      if (name === 'mount' || name === 'onDemand') continue;
      crossed.add(name);
      if (!CLIENT_CROSSINGS.includes(name)) problems.push(`${file} -> components/${name}: a new crossing into the React half.`);
    }
  }
  assert.deepEqual(
    [...new Set(problems)].sort(),
    [],
    'Reach the React half through mount or onDemand, or add this module here on purpose.',
  );
  const stale = CLIENT_CROSSINGS.filter((name) => !crossed.has(name));
  assert.deepEqual(stale, [], 'Nothing outside components/ imports these any more: take them off the list.');
});

test('node tests live under test/, never among fixtures, load scripts or support code, and the gate finds every one', () => {
  const misplaced = [...walk('test/fixtures'), ...walk('test/load'), ...walk('test/support')].filter((file) => file.endsWith('.test.ts'));
  assert.deepEqual(misplaced, [], 'A *.test.ts under test/fixtures, test/load or test/support would run in the gate as a test.');
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
  // `npm test` is its parts, each run by name.
  const expand = (name: string): string => scripts[name].replace(/npm run ([\w:-]+)/g, (_, part: string) => expand(part));
  const script = expand('test');
  assert.match(script, /node scripts\/test-node\.mjs/, 'npm test must run the node suite through its two-lane runner.');
  assert.match(script, /node scripts\/audit-exports\.mjs/, 'npm test must run the export audit.');

  /* The runner replaced a glob in `package.json` with a partition, so "the gate
     finds every one" is checked against the partition itself: every test file
     lands in exactly one lane, and the two lanes together are the suite. A glob
     could only ever be misspelled; a partition can silently drop a file. */
  const { serial, parallel } = lanes();
  const found = [...serial, ...parallel].sort();
  assert.deepEqual([...new Set(found)], found, 'A test file is in both lanes.');
  // An example App's own suite (examples/apps/<app>/tests) runs in the gate beside the repository's.
  const examples = walk('examples/apps').filter((file) => /^examples\/apps\/[^/]+\/tests\/[^/]+\.test\.ts$/.test(file));
  assert.deepEqual(
    found,
    [...walk('test').filter((file) => file.endsWith('.test.ts')), ...examples].sort(),
    'The two lanes must together be every test/**/*.test.ts and examples/apps/*/tests/*.test.ts.',
  );

  /* CI splits the node suite into shards: the runner's own
     `--shard`, not node's `--test-shard`, because each lane is split separately.
     One leg also runs the static checks and the component tests. */
  /* Packed by recorded time, the shards still cover each lane exactly once,
     a file with no record included: every shard computes the same packing. */
  for (const lane of [serial, parallel]) {
    const pieces = [1, 2, 3, 4, 5, 6].flatMap((index) => shard([...lane, 'test/never-recorded.test.ts'], index, 6));
    assert.deepEqual(pieces.sort(), [...lane, 'test/never-recorded.test.ts'].sort(), 'The shards must cover the lane exactly once.');
  }
  const packed = [1, 2].map((index) => shard(['a', 'b', 'c', 'd'], index, 2, { a: 9, b: 1, c: 1, d: 1 }));
  assert.deepEqual(packed, [['a'], ['b', 'c', 'd']], 'A shard is packed by time, not by count.');
  const sharded = 'node scripts/test-node.mjs --shard=${{ matrix.shard }}/6';
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(ci.includes(sharded), `ci.yml must shard the node suite npm test runs: ${sharded}`);
  assert.match(ci, /run: npm run test:static && npx vitest run/, 'ci.yml must run the static checks and the component tests.');
  /* The release does not re-run the suites: it requires a green CI run on the tagged commit. */
  const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(release, /\n  ci-green:/, 'release.yml must require a green CI run through a ci-green job.');
  assert.ok(
    !release.includes('test-node.mjs') && !release.includes('npx vitest'),
    'release.yml must not re-run the node or component tests.',
  );
});

test('node shards treat skipped, missing and invalid timings as unknown cost', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const timingCases = [
    { a: 0, b: 0, c: 0 },
    { a: 4, b: 4, c: 0, d: -1, e: NaN, f: Infinity, g: '4' },
  ];
  for (const timings of timingCases) {
    const pieces = [1, 2, 3, 4].map((index) => shard(files, index, 4, timings));
    assert.deepEqual(pieces.flat().sort(), files, 'coverage is complete and disjoint');
    assert.deepEqual(
      pieces.map((piece) => piece.length),
      [2, 2, 2, 2],
      'unknown costs cannot accumulate on one shard',
    );
    assert.deepEqual(
      pieces,
      [1, 2, 3, 4].map((index) => shard(files, index, 4, timings)),
      'assignment is deterministic',
    );
  }
  assert.deepEqual(
    [1, 2, 3].map((index) => shard(files, index, 3, { a: 0, b: 0 })),
    [
      ['a', 'd', 'g'],
      ['b', 'e', 'h'],
      ['c', 'f'],
    ],
    'all unknown costs use round-robin',
  );
});

test('a shard with other work to do starts that far behind, and takes less of the lane', () => {
  /* CI's first node leg also runs the static checks, Vitest and a browser run;
     --head-start says so in average shards, and the packer starts that bin full. */
  const files = ['a', 'b', 'c', 'd', 'e', 'f'];
  const timings = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 };
  const even = [1, 2, 3].map((index) => shard(files, index, 3, timings));
  assert.deepEqual(
    even.map((piece) => piece.length),
    [2, 2, 2],
  );
  const ahead = [1, 2, 3].map((index) => shard(files, index, 3, timings, parseHeadStart(['--head-start=1:1.5'], 3)));
  assert.deepEqual(
    ahead.map((piece) => piece.length),
    [0, 3, 3],
    'a leg one and a half average shards behind gets nothing while the others catch up',
  );
  assert.deepEqual(ahead.flat().sort(), files, 'coverage is still complete and disjoint');
  assert.deepEqual(parseHeadStart(['--shard=1/3'], 3), [], 'no flag, no head start');
  assert.deepEqual(parseHeadStart(['--head-start=1:0.5,3:0.25'], 3), [0.5, 0, 0.25]);
  for (const bad of ['--head-start=4:1', '--head-start=0:1', '--head-start=1:-1', '--head-start=1', '--head-start=x:1']) {
    assert.throws(() => parseHeadStart([bad], 3), /--head-start takes shard:amount pairs/, bad);
  }
});

test('the browser suite is two lanes that together are every spec, and the gate runs both', () => {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
  assert.match(scripts.e2e, /node scripts\/test-e2e\.mjs/, 'npm run e2e must run the browser suite through its two-lane runner.');

  /* The same property the node lanes are held to, and for the same reason: the
     partition replaced "every spec Playwright's testDir finds", so a spec that
     falls out of both `testMatch` regexes would simply stop running. */
  const { owned, shared } = browserLanes();
  const found = [...owned, ...shared].sort();
  assert.deepEqual([...new Set(found)], found, 'A spec is in both lanes.');
  assert.deepEqual(
    found,
    walk('e2e')
      .filter((file) => file.endsWith('.spec.ts'))
      .sort(),
    'The two lanes must together be every e2e/**/*.spec.ts.',
  );

  /* The owned lane runs with no shared server (playwright.config.ts drops
     `webServer` for it), so a spec there that reaches one fails loudly. That is
     only true while the lane the runner names and the lane the config reads are
     the same word. */
  const config = readFileSync(join(root, 'playwright.config.ts'), 'utf8');
  assert.match(config, /lane === 'owned'\s*\?\s*\[\]/, 'The owned lane must start none of the shared servers.');

  /* CI shards the browser suite: the runner passes `--shard`
     down to each lane separately, so a shard gets its share of both. */
  const sharded = 'npm run e2e -- --shard=${{ matrix.shard }}/6';
  assert.ok(
    readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').includes(sharded),
    `ci.yml must shard the browser suite: ${sharded}`,
  );
  assert.ok(
    !readFileSync(join(root, '.github/workflows/release.yml'), 'utf8').includes('npm run e2e'),
    'release.yml must not re-run the browser suite; it requires a green CI run.',
  );
});

/* Each package runs its own suites (`--package=<name>`, scripts/test-owners.mjs), and will take them with it when it
   leaves this tree. That holds only while every test has exactly one owner, and while the owner map reads the same
   files the gates run: a test with none would run in no package's suite, and one the map did not read would be
   dropped from every package's. */
test('every test belongs to exactly one package, and the owner map reads the files the gates run', () => {
  const all = suites();
  const { serial, parallel } = lanes();
  const { owned, shared } = browserLanes();
  assert.deepEqual(all.node, [...serial, ...parallel].sort(), 'The owner map and the Node lanes read different files.');
  assert.deepEqual(all.e2e, [...owned, ...shared].sort(), 'The owner map and the browser lanes read different files.');
  const vitest = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
  assert.match(
    vitest,
    /include: kept \? ownedBy\(suites\(\)\.components, kept\) : COMPONENT_GLOBS/,
    "Vitest must read the owner map's globs.",
  );
  const unowned = Object.values(all)
    .flat()
    .map((file) => ({ file, ...ownerOf(file) }))
    .filter(({ owner }) => !owner)
    .map(({ file, why }) => `${file}: ${why}`);
  assert.deepEqual(unowned, [], "A test with no one owner runs in no package's suite.");
  /* Each product walks its own rooms: the smoke walk is one spec per binary, not one spec that needs both. */
  assert.equal(ownerOf('e2e/smoke-tablewalk.spec.ts').owner, 'tablewalk');
  assert.equal(ownerOf('e2e/smoke-mistri.spec.ts').owner, 'mistri');
});
