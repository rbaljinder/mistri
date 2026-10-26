/** The suite's bare address is an entry point, not an implicit grant to its
 * root App. Normal App dispatch still owns authorization after this choice. */
import type { IncomingMessage } from 'node:http';
import { publicHome } from '../../shared/appHome.js';
import type { LoadedApp } from '../app/apps.js';
import { captureAppAuthRuntime, captureNativeStepUpProvider, type AppAuthRuntime } from './auth.js';
import { grantAdmits, landingFor, type SuiteLandingRule } from './suiteLanding.js';
import type { SuiteGrants, SuitePreferences } from './suiteStores.js';

/** Returns a local entry destination, or undefined to continue normal
 * dispatch. `basePath` is the suite's configured canonical mount. Store and
 * session failures propagate so the HTTP owner can answer unavailable. */
export async function suiteRootDestination(
  req: IncomingMessage,
  options: {
    native: AppAuthRuntime;
    /** Read as the session may use them (readForSession): a grant derived from claims counts only for its provider's sessions. */
    grants: Pick<SuiteGrants, 'readForSession'>;
    rootApp: LoadedApp | undefined;
    basePath: string;
    preferences?: Pick<SuitePreferences, 'read'>;
    deployments?: readonly { app: LoadedApp; href: string }[];
    /** The operator's `identity.landing`, consulted only while the account has saved no default of its own. */
    landing?: readonly SuiteLandingRule[];
    /** How many active memberships the account holds in a tenant App, from that App's own owner. */
    memberships?: (appId: string, accountId: string) => Promise<number>;
  },
): Promise<string | undefined> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return undefined;
  // Compare the actual path, without Host, returnTo or URL normalization that
  // would turn a deep link such as /notes/.. into a root request.
  const path = req.url?.split('?')[0];
  const { basePath, rootApp } = options;
  if (path !== basePath && path !== `${basePath}/`) return undefined;
  const chooser = `${basePath}/_mistri/apps`;
  const selectors = new URLSearchParams(req.url?.split('?').slice(1).join('?') ?? '').getAll('app');
  if (selectors.length > 1 || (selectors.length === 1 && selectors[0] !== rootApp?.app.id)) return chooser;
  const explicitRoot = selectors.length === 1;
  if (!rootApp && !options.preferences) return chooser;
  if (!explicitRoot && rootApp && (!rootApp.app.auth || rootApp.app.auth.public || publicHome(rootApp.app) !== undefined)) return undefined;

  const auth = captureAppAuthRuntime(options.native);
  const proof = await auth.sessionInstance(req);
  if (!proof) return `${chooser}?entry=1${explicitRoot ? `&app=${encodeURIComponent(rootApp!.app.id)}` : ''}`;
  await auth.observeSession(proof);
  auth.assertSessionCurrent(proof);
  const provider = captureNativeStepUpProvider(options.native).provider(proof);
  const grant = (app: LoadedApp['app']) => options.grants.readForSession(proof.identity.id, app.id, { provider });
  /* Navigation only, so a grant from either store is awaited alike: the App chosen checks its own grant again on
     arrival, and the session is checked after every read here. */
  const admitted = async (app: LoadedApp['app']) => grantAdmits(app, await grant(app));
  // The root is dispatched in place; naming it as a redirect would loop.
  const at = (item: { app: LoadedApp; href: string }) => (item.app.app.id === rootApp?.app.id ? undefined : item.href);
  // The explicit root App is a checked destination, not preference navigation.
  // It still needs its own current grant, even if a different App is default.
  if (explicitRoot) {
    const destination = rootApp && (await admitted(rootApp.app)) ? undefined : chooser;
    auth.assertSessionCurrent(proof);
    return destination;
  }
  const deployments = options.deployments ?? [];
  const preference = await options.preferences?.read(proof.identity.id);
  let destination: string | undefined;
  if (preference && preference.revision > 0) {
    const selected = deployments.find((item) => item.app.app.id === preference.defaultApp);
    destination = selected && (await admitted(selected.app.app)) ? at(selected) : chooser;
  } else {
    // The account's own saved choice outranks the operator's rules; without
    // one, the rules, then the root App, then the only App the account has.
    const ruled =
      options.landing &&
      (await landingFor(
        options.landing,
        deployments,
        grant,
        options.memberships && ((appId) => options.memberships!(appId, proof.identity.id)),
      ));
    auth.assertSessionCurrent(proof);
    if (ruled) destination = at(ruled);
    else if (rootApp && (await admitted(rootApp.app))) destination = undefined;
    else {
      const open = [];
      for (const item of deployments) if (await admitted(item.app.app)) open.push(item);
      destination = open.length === 1 ? at(open[0]) : chooser;
    }
  }
  auth.assertSessionCurrent(proof);
  return destination;
}
