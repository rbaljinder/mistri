/** Explicit operator maintenance for one App's suite grant. Local CLI authority
 * is never inferred from an email address or a different App's administrator. */
import { userInfo } from 'node:os';
import { suiteAppRoles } from '../auth/suiteAppRoles.js';
import { appHome, appMounts } from '@mistriwork/engine/shared/mount.js';
import { loadApp } from '../app/apps.js';
import { captureAppAuthRuntime } from '../auth/auth.js';
import { openSuiteIdentity } from '../auth/suiteIdentity.js';
import { loadConfig } from '@mistriwork/engine/server/connections.js';
import { readSuiteConfiguration } from './suiteConfig.js';
import { consoleIdentityRegistration } from '../console/host.js';
import { CONSOLE_APP_ID } from '../console/app.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';

/** The audit actor for an operator grant. `userInfo()` throws ENOENT when a container
 * runs an arbitrary UID with no passwd entry, so a missing name must never fail the grant. */
export function operatorActor(
  explicit?: string,
  environment: NodeJS.ProcessEnv = process.env,
  lookup: () => string = () => userInfo().username,
): string {
  const named = (value: string | undefined) => value?.trim() || undefined;
  let account: string | undefined;
  try {
    account = named(lookup());
  } catch {
    /* no passwd entry */
  }
  const name =
    named(explicit) ??
    account ??
    named(environment.USER) ??
    named(environment.LOGNAME) ??
    `uid-${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}`;
  return `operator:${name}`;
}

export async function changeSuiteGrant(
  file: string,
  input: {
    appId: string;
    subjectId: string;
    roles: readonly string[];
    expectedRevision: number;
    actor?: string;
  },
  environment: NodeJS.ProcessEnv = process.env,
) {
  const { actor, ...change } = input;
  const config = await readSuiteConfiguration(file, environment);
  if (!config.identity) throw new Error('Grant maintenance requires a shared suite identity.');
  if (!config.apps.some((app) => app.id === input.appId) && !(config.console?.enabled && input.appId === CONSOLE_APP_ID))
    throw new Error('The App is not in this suite.');
  const mount = appMounts(
    config.apps.map((app) => app.id),
    { base: config.basePath, mounts: Object.fromEntries(config.apps.map((app) => [app.id, app.mount])) },
  );
  const deployments = [];
  for (const deployment of config.apps) {
    const app = await loadApp(deployment.directory, { lock: 'enforce' });
    if (app.app.id !== deployment.id) throw new Error('Suite App id does not match its declaration.');
    const connections = await loadConfig(deployment.config, CONFIG_SECTIONS);
    if (!connections) throw new Error('Missing suite connection configuration.');
    deployments.push({
      app,
      connections: connections.connections,
      environment: deployment.environment,
      basePath: appHome(mount, app.app.id).replace(/\/$/, ''),
    });
  }
  if (config.console?.enabled) deployments.push(consoleIdentityRegistration(config.basePath));
  const target = deployments.find((item) => item.app.app.id === input.appId)!;
  const declaredRoles = suiteAppRoles(target.app.app);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !input.subjectId ||
    !Array.isArray(input.roles) ||
    input.roles.some((role) => !declaredRoles.includes(role))
  ) {
    throw new Error('Invalid App grant subject, revision or role.');
  }
  const identity = await openSuiteIdentity(config, deployments);
  try {
    if (!(await captureAppAuthRuntime(identity.native).lookupEligibleAccountCurrent(input.subjectId))) {
      throw new Error('The suite account does not exist or is unavailable. Use its stable account id, not an email address.');
    }
    return await identity.grants.change({ ...change, declaredRoles, actorId: operatorActor(actor, environment) });
  } finally {
    identity.close();
  }
}

export async function runSuiteGrantCommand(args: string[]): Promise<void> {
  const [command, file, ...allFlags] = args;
  const actorAt = allFlags.indexOf('--actor');
  const actor = actorAt < 0 ? undefined : allFlags[actorAt + 1];
  if (actorAt >= 0 && (!actor || actor.startsWith('--') || allFlags.indexOf('--actor', actorAt + 1) >= 0))
    throw new Error('Invalid suite grant arguments.');
  const flags = actorAt < 0 ? allFlags : allFlags.filter((_, index) => index !== actorAt && index !== actorAt + 1);
  const required = command === 'grant' ? ['--app', '--subject', '--roles', '--revision'] : ['--app', '--subject', '--revision'];
  const values = new Map<string, string>();
  if (!file || flags.length !== required.length * 2)
    throw new Error(
      'Expected suite grant|revoke <suite.json> --app <id> --subject <id> --revision <number>, and --roles <comma-separated roles> for grant.',
    );
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index],
      value = flags[index + 1];
    if (!required.includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('Invalid suite grant arguments.');
    values.set(key, value);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(values.get('--revision')!)) throw new Error('The grant revision must be a nonnegative integer.');
  const result = await changeSuiteGrant(file, {
    appId: values.get('--app')!,
    subjectId: values.get('--subject')!,
    expectedRevision: Number(values.get('--revision')),
    roles: command === 'grant' ? values.get('--roles')!.split(',') : [],
    actor,
  });
  console.log(JSON.stringify(result));
}
