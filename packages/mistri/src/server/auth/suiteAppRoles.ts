/** The reserved Console has one explicit admission grant. Ordinary App account
 * administration may synthesize admin; the internal Console never does. */
import { assignableRoles } from '../../shared/accountAdministration.js';
import type { AppDef } from '../../shared/app.js';
import { CONSOLE_APP_ID } from '../console/app.js';

export function suiteAppRoles(app: Pick<AppDef, 'id' | 'auth'>): string[] {
  return app.id === CONSOLE_APP_ID ? ['admitted'] : assignableRoles(app.auth);
}
