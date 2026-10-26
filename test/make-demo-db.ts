/**
 * The demo generator now lives in `packages/engine/src/server/demo.ts` so it ships with the
 * package and backs `tablewalk --demo`. This file stays as the path the test
 * suite and `npm run demo` import, re-exporting the library and keeping the
 * runnable entry point.
 */
export * from '../packages/engine/src/server/demo.js';
import { makeDemoDatabase, seedDemoDatabase } from '../packages/engine/src/server/demo.js';

/* Runnable directly, so `npm run demo` can build it before starting.

     tsx test/make-demo-db.ts .demo/demo.db            small, the test fixture
     tsx test/make-demo-db.ts .demo/demo.db --scale 2000   ~130k rows
*/
const invokedDirectly = process.argv[1]?.endsWith('make-demo-db.ts');
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--')) ?? '.demo/demo.db';
  const scaleFlag = args.indexOf('--scale');
  makeDemoDatabase(target);
  if (scaleFlag !== -1) {
    const scale = Number(args[scaleFlag + 1] ?? 1000);
    const started = Date.now();
    seedDemoDatabase(target, { scale });
    console.log(`Seeded ${target} at scale ${scale} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } else {
    console.log(`Wrote ${target}`);
  }
}
