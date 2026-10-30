/**
 * The process the store-upgrade rehearsal kills: `upgradeStores` over one database with the v2 record-history layout
 * (storeUpgradeRehearsal.ts). Given a pause file, the step writes it once its data is changed and then waits for
 * ever, which is the moment the test sends SIGKILL; without one the upgrade runs through. Prints the result as JSON.
 *
 *   node --import tsx test/support/storeUpgradeChild.ts <database> [pause-file]
 */
import { writeFileSync } from 'node:fs';
import { openMigrationDb } from '../../packages/engine/src/server/migrate/database.js';
import { upgradeStores } from '../../packages/mistri/src/server/storeLayouts.js';
import { historyV2 } from './storeUpgradeRehearsal.js';

const [url, pauseFile] = process.argv.slice(2);
const db = await openMigrationDb(url, [], false);
const pause = pauseFile
  ? async () => {
      writeFileSync(pauseFile, 'paused');
      // A live handle, or Node would end the process as an unsettled await instead of waiting to be killed.
      setInterval(() => {}, 1000);
      await new Promise<void>(() => {});
    }
  : undefined;
const result = await upgradeStores(db, url, [historyV2(pause)]);
await db.close();
console.log(JSON.stringify(result));
