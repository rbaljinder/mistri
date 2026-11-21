/**
 * What a request to keep a pick says (`/api/choose`, a single App's and a tenant App's alike): one declared choice's
 * name, and the row's key as text or null to clear it. Anything else is refused as a request confused about whose pick
 * it is, as the inbox's bodies are.
 */
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import type { AppDef } from '../../shared/appModel.js';

export const CHOOSE_PATH = '/api/choose';
/** The longest key a pick keeps (appChoices.ts KEY_MAX). */
const KEY_MAX = 128;

export function chooseBody(app: AppDef, body: Record<string, unknown>): { name: string; value: string | null } {
  if (Object.keys(body).some((key) => key !== 'app' && key !== 'name' && key !== 'value')) throw new HttpError(400, 'Invalid choice.');
  const { name, value } = body;
  if (typeof name !== 'string' || !app.choose || !Object.hasOwn(app.choose, name))
    throw new HttpError(400, 'That is not a choice this App has.');
  if (value === null) return { name, value: null };
  if (typeof value !== 'string' || !value || value.length > KEY_MAX)
    throw new HttpError(400, 'A choice is a row key, or null to clear it.');
  return { name, value };
}
