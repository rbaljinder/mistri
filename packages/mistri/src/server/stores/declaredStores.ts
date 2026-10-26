/**
 * The stores an App's own declaration asks for, so that provisioning follows
 * the App instead of a list someone keeps beside it: a resource that notifies
 * wants the inbox, one with a history page wants the record history, a
 * `branding` or `assistant` declaration wants theirs. `provisionStores` reads
 * it twice: to derive what to make when it is given the App and no `only`, and
 * to refuse an `only` that names a store the App never declared (a store made
 * for nothing is a store nobody attests, migrates or remembers to drop).
 */
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import type { AppDef } from '../../shared/app.js';
import { capturedJobModule, type JobModule } from '../jobs/jobModule.js';

/** The stores whose need an App's declaration decides. A store not listed (the command journal, the tenant stores) is bound by other means. */
export const DECLARABLE_STORES: readonly string[] = [
  'record-history',
  'inbox',
  'integrations',
  'branding',
  'assistant',
  'decisions',
  'tenant-sandboxes',
  'live-change',
];

/**
 * Which of DECLARABLE_STORES the App declares, in that order. `jobs` is the
 * module the App runs, whose `integrations` and `decisions` declarations are
 * the other reason for those two. The record history reads the pages: a
 * history section is a page's.
 */
export async function declaredStores(app: AppDef, pages: readonly PageDef[] = [], jobs?: JobModule): Promise<string[]> {
  const resources = Object.entries(app.resources ?? {});
  const notifying = resources.filter(([, resource]) => resource.notify?.length);
  const module = jobs === undefined ? undefined : capturedJobModule(jobs);
  const { historyRules } = await import('../recordHistory.js');
  const declared = new Set<string>();
  if (historyRules(app, pages).size) declared.add('record-history');
  if (notifying.length) declared.add('inbox');
  /* A rule that emails an address the record holds queues its mail in the integrations store, in the write's transaction. */
  if (notifying.some(([, resource]) => resource.notify!.some((rule) => rule.send?.channel === 'email')) || module?.integrations)
    declared.add('integrations');
  if (app.branding) declared.add('branding');
  if (app.assistant) declared.add('assistant');
  if (module?.decisions?.size) declared.add('decisions');
  if (resources.some(([, resource]) => resource.clone !== undefined)) declared.add('tenant-sandboxes');
  /* Live sync's change store: a page showing any resource is told of its writes. */
  if (resources.length) declared.add('live-change');
  return DECLARABLE_STORES.filter((id) => declared.has(id));
}
