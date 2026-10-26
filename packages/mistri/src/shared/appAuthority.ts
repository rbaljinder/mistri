/**
 * The effective authority of an App, as text: one fact per line, each naming
 * who contributes it — the App, or a feature. It is what authority.lock holds
 * beside the manifest, so a grant that widens is one added line in a review.
 *
 * Read from the resolution the runtime judges identities by — the resource
 * ceilings and checkedGrants — never from a second model, and written out
 * the way it is enforced: a role's `read: true` as the resources it reaches.
 * Sorted by name, so the text moves only when the authority does, and
 * independent of any catalog, so a lock is checked without a database.
 *
 * A fact and its contributors are separate halves of a line. The server
 * compares facts (the effective authority, whoever states it); mistri check
 * compares whole lines, so a committed lock also says truthfully who grants.
 */
import { AUTHORED_OPERATIONS, checkedGrants, realmResources } from './appAuthGrants.js';
import { grantsByRole, isPublicForm, type AppDef } from './appModel.js';
import { THE_APP, type AppOrigins } from './appFeatures.js';
import { apiAuthorityFacts } from './apiAuthority.js';
import { flagCapabilityKey } from './appFlagCapabilities.js';

const SEPARATOR = ' — ';
const HEADER = [
  '# authority.lock: the effective authority of this App, one fact per line, then who contributes it.',
  '# Written by `mistri check --app <dir> --write-authority`. The server does not start or',
  '# reload an App whose authority differs from it, and mistri check fails until it is rewritten.',
];

/** A variable the App's definition may read, as mistri.json's `apps[].env` passes it (packages/engine/src/server/cli/config.ts). */
export interface AppEnvName {
  name: string;
  secret?: true;
}

export function authorityReport(app: AppDef, origins?: AppOrigins, env: readonly AppEnvName[] = []): string {
  const lines: string[] = [];
  const fact = (text: string, path?: string) => {
    const who = path !== undefined && origins?.authority[path]?.length ? origins.authority[path] : [THE_APP];
    lines.push(`${text}${SEPARATOR}${who.join(', ')}`);
  };
  const sorted = (names: Iterable<string>) => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (!app.auth) fact('auth none');
  else {
    fact(`auth providers ${app.auth.providers.join(', ')}`);
    /* Who may make an account at a first sign-in is who may walk in: each
       provider and domain a line, so a widening is one added line. */
    const signUp = app.auth.signUp;
    if (typeof signUp === 'string') fact(`auth sign-up ${signUp}`);
    else {
      fact('auth sign-up just-in-time');
      for (const provider of sorted(signUp.providers ?? [])) fact(`auth sign-up just-in-time provider ${provider}`);
      for (const domain of sorted(signUp.domains ?? [])) fact(`auth sign-up just-in-time domain ${domain}`);
    }
    fact(`auth default-role ${app.auth.defaultRole}`);
    fact(`auth rows ${app.auth.rows}`);
    if (app.auth.tenancy?.platform) fact('auth platform realm enabled');
    if (app.auth.tenancy?.profile) fact(`auth tenant profile ${app.auth.tenancy.profile}`);
  }
  // These are configured binding names, never resolved connection credentials.
  if (app.sources)
    for (const name of sorted(Object.keys(app.sources))) {
      const source = app.sources[name];
      fact(`source ${name} connection ${JSON.stringify(source.connection)}`);
      if (source.default) fact(`source ${name} default`);
      if (source.schema !== undefined) fact(`source ${name} schema ${JSON.stringify(source.schema)}`);
      /* Implicit blocks grant nothing, but they are what the App touches: a
       widening from a list to every table is one changed line in review. */
      if (source.resources !== undefined)
        fact(`source ${name} resources ${source.resources === 'all' ? 'all' : [...source.resources].sort().join(', ')}`);
      // Turning a platform-only source into an ordinary one is a removed line in review.
      if (source.realm === 'platform') fact(`source ${name} realm platform read-only`);
    }
  else if (app.connection !== undefined) fact(`connection ${JSON.stringify(app.connection)}`);
  fact(
    grantsByRole(app)
      ? 'scope roles: every read and write is granted by role, within the ceilings'
      : "scope ceilings: the declared resources read, and only those with access 'write' write",
  );

  for (const name of sorted(Object.keys(app.resources ?? {}))) {
    const resource = app.resources![name];
    const at = `resources.${name}`;
    /* Without role grants, declaring a resource is what serves it: a table
       added to the App's reach is a line added in review. */
    if (!grantsByRole(app)) fact(`resource ${name} reads`, at);
    if (resource.physical !== undefined) fact(`resource ${name} physical ${resource.physical}`, `${at}.physical`);
    if (resource.access !== undefined) fact(`resource ${name} access ${resource.access}`, `${at}.access`);
    if (resource.delete) fact(`resource ${name} delete`, `${at}.delete`);
    if (resource.owner !== undefined) fact(`resource ${name} owner ${resource.owner}`, `${at}.owner`);
    for (const column of sorted(resource.fields?.read ?? [])) fact(`resource ${name} fields read ${column}`, `${at}.fields`);
    for (const column of sorted(resource.fields?.write ?? [])) fact(`resource ${name} fields write ${column}`, `${at}.fields`);
  }

  // Ownership and tenant management determine the required authority. Values,
  // weights, rollout percentages and provider revisions never enter the lock.
  for (const id of sorted(Object.keys(app.flags ?? {}))) {
    const flag = app.flags![id];
    fact(`flag ${id} owner ${flag.owner} tenant-managed ${flag.tenantManaged === true}`, `flags.${id}`);
  }
  for (const id of sorted(Object.keys(app.experiments ?? {}))) {
    const epoch = app.experiments![id];
    fact(`experiment ${id} declared unit ${epoch.unit}`, `experiments.${id}`);
    fact(`experiment ${id} primary conversion ${epoch.primary.conversion}`, `experiments.${id}`);
    for (const conversion of sorted((epoch.guardrails ?? []).map((metric) => metric.conversion)))
      fact(`experiment ${id} guardrail conversion ${conversion}`, `experiments.${id}`);
  }

  if (grantsByRole(app)) {
    const grants = checkedGrants(app);
    /* The operations a role is granted, in the words it was granted in. */
    const authored = (operation: string) => (operation === 'support' ? AUTHORED_OPERATIONS[1] : operation);
    for (const role of sorted(Object.keys(grants.roles))) {
      const grant = grants.roles[role];
      const at = `roles.${role}`;
      const reach = (value: boolean | string[], ceiling: string[]) =>
        value === true ? realmResources(app, grant.realm, ceiling) : value === false ? [] : value;
      if (grant.realm !== undefined) fact(`role ${role} realm ${grant.realm}`, `${at}.realm`);
      /* Where its grants came from; the grants themselves are listed in full below, inherited ones among them. */
      if (grant.extends !== undefined) fact(`role ${role} extends ${grant.extends}`, `${at}.extends`);
      /* Who holds the role is authority too when a provider's claims say it:
         a value added to a mapping is one added line in review. */
      if (grant.claims?.provider !== undefined) fact(`role ${role} claims from provider ${grant.claims.provider}`, `${at}.claims.provider`);
      for (const claim of sorted(Object.keys(grant.claims?.match ?? {}))) {
        for (const value of sorted(grant.claims!.match[claim]))
          fact(`role ${role} from claim ${claim} ${JSON.stringify(value)}`, `${at}.claims`);
      }
      const before = lines.length;
      for (const resource of sorted(reach(grant.read, grants.read))) fact(`role ${role} read ${resource}`, `${at}.read.${resource}`);
      for (const resource of sorted(reach(grant.write, grants.write))) fact(`role ${role} write ${resource}`, `${at}.write.${resource}`);
      for (const resource of sorted(grant.export ?? [])) fact(`role ${role} export ${resource}`, `${at}.export.${resource}`);
      for (const command of sorted(grant.commands ?? [])) fact(`role ${role} command ${command}`, `${at}.commands.${command}`);
      for (const resource of sorted(Object.keys(grant.actions ?? {}))) {
        for (const label of sorted(grant.actions![resource]))
          fact(`role ${role} action ${resource} ${JSON.stringify(label)}`, `${at}.actions.${resource}.${label}`);
      }
      for (const operation of sorted((grant.operations ?? []).map(authored)))
        fact(`role ${role} operation ${operation}`, `${at}.operations.${operation}`);
      for (const kind of ['flags', 'experiments'] as const) {
        const entries = new Set((grant[kind] ?? []).map(flagCapabilityKey));
        for (const entry of sorted(entries)) fact(`role ${role} ${kind} ${entry}`, `${at}.${kind}.${entry}`);
      }
      for (const resource of sorted(Object.keys(grant.fields ?? {}))) {
        const columns = grant.fields![resource];
        // No read list is the resource's own read ceiling: the role narrows only what it writes.
        for (const column of sorted(columns.read ?? [])) fact(`role ${role} fields ${resource} read ${column}`, `${at}.fields.${resource}`);
        for (const column of sorted(columns.write ?? []))
          fact(`role ${role} fields ${resource} write ${column}`, `${at}.fields.${resource}`);
      }
      if (lines.length === before) fact(`role ${role} grants nothing`);
    }
    /* What anyone reads without signing in: each resource named, and its columns when narrowed. */
    for (const resource of sorted(grants.public?.read ?? [])) fact(`public read ${resource}`, `public.read.${resource}`);
    for (const resource of sorted(Object.keys(grants.public?.fields ?? {}))) {
      for (const column of sorted(grants.public!.fields![resource].read))
        fact(`public fields ${resource} read ${column}`, `public.fields.${resource}`);
    }
  }

  /* A public form runs its command for anyone: which ones an App offers is authority too. */
  for (const key of sorted(Object.keys(app.views))) {
    const form = app.views[key];
    if (!isPublicForm(form)) continue;
    const feature = origins?.views[key];
    lines.push(
      `public form ${key} runs command ${form.command.id} version ${form.command.version}${SEPARATOR}${feature ? `features "${feature}"` : THE_APP}`,
    );
  }
  /* A free-form page reads, runs and loads what it declares: which resources
     and commands an author's whole page may ask for is authority, as a
     role's grants are, and so is a public page, which a signed-out visitor
     opens. Its file is the App's own, so the App contributes it. */
  for (const key of sorted(Object.keys(app.views))) {
    const view = app.views[key];
    if (!('sections' in view) || !view.page) continue;
    const by = `${SEPARATOR}${origins?.views[key] ? `features "${origins.views[key]}"` : THE_APP}`;
    for (const resource of sorted(view.page.reads)) lines.push(`page ${key} reads ${resource}${by}`);
    for (const command of sorted(view.page.commands)) lines.push(`page ${key} runs ${command}${by}`);
    if (view.page.loader) lines.push(`page ${key} loads ${view.page.loader}${by}`);
    if (view.page.public) lines.push(`page ${key} public${by}`);
  }
  /* A way out of the page for the App's components: the policy opens exactly these origins beside its own. */
  for (const origin of app.ui.csp?.connect ?? []) fact(`egress connect ${origin}`);
  for (const origin of app.ui.csp?.images ?? []) fact(`egress images ${origin}`);
  /* What the definition may read of the server's environment: the names,
     never a value. They are the operator's grant, so mistri.json is named
     as who contributes them. */
  for (const { name, secret } of [...env].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    lines.push(`env ${name}${secret ? ' secret' : ''}${SEPARATOR}mistri.json`);
  }
  // Authored exposure is checked before connecting to a catalog, just like
  // resource ceilings. Catalog checks may narrow it, never replace this gate.
  for (const { fact: text, path } of apiAuthorityFacts(app.api, app.views)) fact(text, path);
  return `${HEADER.join('\n')}\n\n${lines.join('\n')}\n`;
}

/**
 * What changed from one report (or lock) to another, as `- ` and `+ ` lines:
 * by whole line, or by `facts` alone, which ignores who contributes a fact.
 * Comments and blank lines are never compared, and neither are a command's
 * `contract` lines or a workflow's `workflow` lines: they are the lock's record of
 * its commands' versions and its workflows' steps, judged by mistri check against
 * what depends on them (commandContracts.ts, workflowContracts.ts).
 */
export function authorityDiff(before: string, after: string, compare: 'facts' | 'lines' = 'lines'): string[] {
  const read = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('contract ') && !line.startsWith('workflow '));
  const key =
    compare === 'facts'
      ? (line: string) => (line.includes(SEPARATOR) ? line.slice(0, line.lastIndexOf(SEPARATOR)) : line)
      : (line: string) => line;
  const was = read(before);
  const now = read(after);
  const had = new Set(was.map(key));
  const has = new Set(now.map(key));
  return [
    ...was.filter((line) => !has.has(key(line))).map((line) => `- ${line}`),
    ...now.filter((line) => !had.has(key(line))).map((line) => `+ ${line}`),
  ];
}
