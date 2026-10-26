import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The public example Apps (examples/apps), as the schema tests walk them. */
export const EXAMPLES = new URL('../../examples/apps/', import.meta.url).pathname;
export const FIXTURES = new URL('../fixtures/apps/', import.meta.url).pathname;
export const publicExamples = () =>
  readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
/* The fixtures that were public examples until 0.9.2. The walkers go on reading them, so the breadth the old
   catalog held (a suite, a marketplace, a forum, a warehouse) stays checked now that only Tick, Lintel and Ladle ship. */
export const formerExamples = ['atelier', 'commons', 'crm', 'depot', 'forecourt-market', 'keystone', 'loaner-desk', 'payday', 'thread'];
export const keystoneApps = ['lender', 'leads', 'dealer', 'site', 'marketplace', 'customer'];
/** Every App the walkers read, by name; each Keystone App is `keystone/<name>`. */
export const walkedApps = () =>
  [...publicExamples(), ...formerExamples].flatMap((app) => (app === 'keystone' ? keystoneApps.map((name) => `keystone/${name}`) : [app]));
/** The directory a walked App lives in. */
export const appDirectory = (app: string) => join(publicExamples().includes(app) ? EXAMPLES : FIXTURES, app);
