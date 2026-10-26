/**
 * `/api/integrations` and `/api/integrations/save`: the integrations'
 * settings screen on an App without tenants (a tenant App's are tenantHttp.ts's,
 * one tenant's each). Which secrets are set, never a value; saved only by a
 * signed-in person holding a role the jobs module names in
 * `integrations.editors`, and sealed before it reaches a row
 * (integrations/integrationSecrets.ts).
 */
import { sessionRoles } from '../../shared/appViewRoles.js';
import { appForConnection } from '../app/apps.js';
import {
  integrationRuntimeOf,
  IntegrationSettingsRefusal,
  readIntegrationSettings,
  saveIntegrationSettings,
} from '../integrations/integrationRuntime.js';
import { HttpError, send } from '@mistriwork/engine/server/http/reply.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';

const READ_PATH = '/api/integrations';
const SAVE_PATH = '/api/integrations/save';

export async function integrationRoutes(post: PostContext): Promise<boolean> {
  const { res, path, body, registry, connection, appHosts, principal, role } = post;
  if (path !== READ_PATH && path !== SAVE_PATH) return false;
  const host = appHosts?.length ? appForConnection(appHosts, connection, registry.configOf(connection)?.name) : undefined;
  const runtime = host ? integrationRuntimeOf(host.app.app.id) : undefined;
  if (!host?.auth || !runtime) {
    send(res, 404, { error: 'Not found.' });
    return true;
  }
  if (!principal) throw new HttpError(401, 'Sign in to see the integrations.');
  if (Object.keys(body).some((key) => !['app', 'integration', 'secrets'].includes(key)))
    throw new HttpError(400, 'Invalid integrations request.');
  res.setHeader('cache-control', 'no-store');
  const editor = sessionRoles(role).some((held) => runtime.declared.editors.includes(held));
  const settings = async () => ({ ...(await readIntegrationSettings(runtime, '', (name) => `/api/inbound/${name}`)), editor });
  if (path === READ_PATH) {
    send(res, 200, await settings());
    return true;
  }
  if (!editor) throw new HttpError(403, "Only this App's admins may change its integrations.");
  try {
    const { app: _app, ...saved } = body;
    await saveIntegrationSettings(runtime, '', principal, saved);
  } catch (error) {
    if (error instanceof IntegrationSettingsRefusal) {
      send(res, 422, { error: error.message, code: 'integration_refused', outcome: 'not_applied' });
      return true;
    }
    throw error;
  }
  send(res, 200, await settings());
  return true;
}
