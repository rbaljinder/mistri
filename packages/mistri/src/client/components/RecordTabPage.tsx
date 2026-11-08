/**
 * A free-form page placed as a record's tab (pages/<list view>/[id]/<tab>.page.tsx), as the record page's tab strip
 * draws it (PageSections.tsx, through the shell's rooms slot `RecordTab`): the page's one component on the record's
 * page, with no head of its own, since the record's head is above it.
 */
import { ErrorBoundary } from '@mistriwork/kit/client/components/ErrorBoundary.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import type { DashboardDef } from '@mistriwork/kit/client/components/dashboardModel.js';
import { wholeColumn } from '@mistriwork/kit/client/components/placeOrder.js';
import { findTable } from '@mistriwork/kit/client/core.js';
import { UiPageContext, type UiPageFrame } from './sdk/context.js';

/* The page's component, and the page's side of @mistriwork/mistri/ui with it: fetched the first time a tab is opened. */
const CustomPage = onDemand(() => import('./sdk/CustomPage.js'), 'CustomPageBody');

/**
 * The key as the record's row holds it. A key read from an address is text (`/compass/accounts/13/pipeline` arrives
 * as `{ id: '13' }`), while the page's types promise the stored value (`{ id: number }`), so a whole-number column
 * becomes a number where it is one exactly; past 2^53 it stays its digits, as the adapters hand such a value back.
 */
export function storedKey(table: string, key: Record<string, unknown>): Record<string, unknown> {
  const columns = findTable(table)?.columns ?? [];
  return Object.fromEntries(
    Object.entries(key).map(([name, value]) => {
      const whole = wholeColumn(columns.find((column) => column.name === name)?.type);
      const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : undefined;
      return [name, whole && number !== undefined && Number.isSafeInteger(number) ? number : value];
    }),
  );
}

/**
 * The frame says which record the tab is on (`page.useRecordKey`). A tab
 * keeps no place in the address of its own: the record's address is its
 * place, so it has no params and no loader (the parser refuses both).
 */
export function RecordTabPage({ dashboard, recordKey }: { dashboard: DashboardDef; recordKey: Record<string, unknown> }) {
  const page = dashboard.page;
  const section = dashboard.sections[0];
  if (!page?.record || !section) return null;
  const frame: UiPageFrame = {
    view: dashboard.id,
    label: dashboard.label,
    reads: page.reads,
    commands: page.commands,
    ...(page.actions ? { actions: page.actions } : {}),
    params: [],
    get: () => undefined,
    set: () => {},
    record: { table: page.record.table, key: storedKey(page.record.table, recordKey) },
  };
  return (
    <div className="free-page-body record-tab-page">
      <ErrorBoundary>
        <UiPageContext.Provider value={frame}>
          <CustomPage frame={frame} section={section} />
        </UiPageContext.Provider>
      </ErrorBoundary>
    </div>
  );
}
