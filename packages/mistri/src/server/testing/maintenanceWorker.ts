/** Private subprocess owner for validation and test suite account/grant maintenance. */
import { loadApp } from '../app/apps.js';
import { changeSuiteGrant } from '../cli/suiteGrant.js';
import { createTestSuiteAccount } from './accounts.js';
import type { TestMaintenanceRequest } from './worker.js';

process.once('message', async (request: TestMaintenanceRequest) => {
  try {
    let value: unknown;
    if (request.kind === 'validate') {
      const loaded = await loadApp(request.directory, { lock: 'enforce' });
      value = { id: loaded.app.id, name: loaded.app.name };
    } else if (request.kind === 'account') {
      value = await createTestSuiteAccount(request.file, process.env as Record<string, string>, request.input);
    } else if (request.kind === 'grant') {
      await changeSuiteGrant(request.file, request.input, process.env);
    } else throw new Error('Unknown test maintenance request.');
    process.send?.({ ok: true, value }, () => process.exit(0));
  } catch (error) {
    process.send?.({ ok: false, error: error instanceof Error ? error.message : 'Test maintenance failed.' }, () => process.exit(1));
  }
});
