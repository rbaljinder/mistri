/**
 * A tenant App's `api`, judged by `mistri check` as its export and its serving judge it (tenantApiExport.ts): a sort
 * by a column the API cannot order, a command that names no record, a command no API role holds whole. An ordinary
 * App's check has rendered its document since it learned to (cli/oneShot.ts apiExportProblems); a tenant App's was
 * passed over, so each refusal surfaced from `--export openapi`, one export at a time.
 *
 * Only under `mistri check`: a start that does not serve the API has never been refused for it, and serving it
 * (`--api-reads`) judges the same catalogs when its owner opens.
 */
import type { TenantStartupCheck } from './tenantFeatureContract.js';
import { tenantApiProblems } from './tenantApiExport.js';
import { TenantAuthoringStartupError } from './tenantStartupError.js';

export const apiCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  catalog: true,
  stage: 'the API declarations',
  run: ({ loaded, owned, registry, checking }) => {
    if (!checking || !loaded.app.api) return;
    const problems = tenantApiProblems(loaded.app, owned, registry);
    if (problems.length)
      throw new TenantAuthoringStartupError(
        `Tenant startup could not validate the API declarations:\n${problems.map((line) => `  ${line}`).join('\n')}`,
      );
  },
});
