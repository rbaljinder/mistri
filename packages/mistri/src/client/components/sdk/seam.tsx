/**
 * Mistri's `UiSurfaceSeam` adapter for `@mistriwork/ui`: connects shared UI controls, primitives, charts, and views
 * to the App host's in-place SPA navigation, schema column labels and `<Value>` display rules, `SplitListDetail`
 * collection pane, free-form page URL query params, localized catalog words, locale number/money/percent formatters,
 * and default `<h2>` page heading level under the shell's `<h1>`.
 */
import { installSurfaceSeam, type UiSurfaceSeam } from '@mistriwork/ui';
import { formatMoney, formatNumber, formatPercent } from '@mistriwork/kit/client/locale.js';
import { message } from '@mistriwork/kit/client/messages.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';
import { useCallback, useContext, type CSSProperties, type ReactNode, type Ref } from 'react';
import { say as sayHook } from '../../copy/components/components/sdk/hooks.js';
import { say } from '../../copy/components/components/sdk/seam.js';
import { SplitListDetail } from '../SplitListDetail.js';
import { UiPageContext, useFollow, useHostIfAny } from './context.js';
import { Value } from './kit.js';

const noopAddressSet = () => {};

function useOptionalAddressState(name: string | undefined): readonly [string | undefined, (value: string | undefined) => void] {
  const page = useContext(UiPageContext);
  const set = useCallback(
    (value: string | undefined) => {
      if (!page || !name) return;
      page.set(name, value === undefined || value === '' ? undefined : String(value));
    },
    [page, name],
  );
  if (!name) return [undefined, noopAddressSet];
  if (!page) throw new Error(sayHook('useaddressstateKeepsAPages'));
  if (!page.params.includes(name)) {
    throw new Error(
      sayHook('thePageKeepsInItsAddress', {
        label: page.label,
        params: page.params.length ? page.params.map((param) => `"${param}"`).join(', ') : sayHook('noParameters'),
        name,
      }),
    );
  }
  return [page.get(name), set];
}

function given(slot: ReactNode): boolean {
  return slot !== undefined && slot !== null && slot !== false;
}

function RecordFacts({
  resource,
  row,
  fields,
  columns,
  className,
  ref,
}: {
  resource: string;
  row: Readonly<Record<string, unknown>>;
  fields: ReadonlyArray<string | { field: string; label?: ReactNode } | { id?: string; label: ReactNode; value: ReactNode }>;
  columns?: 1 | 2 | 3;
  className?: string;
  ref?: Ref<HTMLDListElement>;
}) {
  const host = useHostIfAny();
  const classes = ['page-field-grid kit-details kit-details-wrap kit-facts nx-dl', className].filter(Boolean).join(' ');
  const style = columns ? ({ '--page-field-columns': `repeat(${columns}, minmax(0, 1fr))` } as CSSProperties) : undefined;
  return (
    <dl ref={ref} className={classes} data-columns={columns} style={style}>
      {fields.map((entry, at) => {
        if (typeof entry === 'string') {
          return (
            <div key={entry} className="page-field nx-dl-item">
              <dt className="nx-dl-term">{host?.column(resource, entry)?.label ?? entry}</dt>
              <dd className="nx-dl-details">
                <Value value={row[entry]} resource={resource} column={entry} />
              </dd>
            </div>
          );
        }
        if ('field' in entry) {
          return (
            <div key={entry.field} className="page-field nx-dl-item">
              <dt className="nx-dl-term">{entry.label ?? host?.column(resource, entry.field)?.label ?? entry.field}</dt>
              <dd className="nx-dl-details">
                <Value value={row[entry.field]} resource={resource} column={entry.field} />
              </dd>
            </div>
          );
        }
        return (
          <div key={entry.id ?? `at-${at}`} className="page-field nx-dl-item">
            <dt className="nx-dl-term">{entry.label}</dt>
            <dd className="nx-dl-details">{given(entry.value) && entry.value !== '' ? entry.value : <span className="null">—</span>}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function PaneSplit(props: Record<string, unknown>) {
  const splitProps = props as unknown as Parameters<typeof SplitListDetail>[0] & {
    listAriaLabel?: string;
    detailAriaLabel?: string;
    detailOpen?: boolean;
  };
  const { listAriaLabel, detailAriaLabel, detailOpen, listLabel, detailLabel, selected, ...rest } = splitProps;
  return (
    <SplitListDetail
      {...rest}
      selected={selected ?? detailOpen}
      listLabel={listAriaLabel ?? listLabel}
      detailLabel={detailAriaLabel ?? detailLabel}
    />
  );
}

export const mistriSurfaceSeam: UiSurfaceSeam = {
  useLinkProps(href, onClick) {
    const handleClick = useFollow(href, onClick);
    return { ...(href === undefined ? {} : { href }), onClick: handleClick };
  },
  renderRecordFacts: (props) => <RecordFacts {...props} />,
  renderPaneSplit: (props) => <PaneSplit {...props} />,
  useUrlParam: (param) => useOptionalAddressState(param),
  aiLabel: () => (shell().app() as { ai?: { label?: string } } | null)?.ai?.label ?? say('ai'),
  defaultWords: () => ({
    select: say('select'),
    close: message('common.close'),
    chooseFile: say('chooseFile'),
    chooseFiles: say('chooseFiles'),
    noFileChosen: say('noFileChosen'),
    backTo: (label) => say('backTo', { label }),
  }),
  formatPreset(value, preset, locale) {
    if (preset === 'money') return formatMoney(value);
    if (preset === 'percent') return formatPercent(value);
    return locale ? new Intl.NumberFormat(locale).format(value) : formatNumber(value);
  },
  defaultPageHeaderLevel: 2,
};

installSurfaceSeam(mistriSurfaceSeam);
