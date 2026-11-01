/** The real renderer in a separate viewport; no app boot, routes or mutation controls. */
import { ownedBy } from '../requestIdentity.js';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api, findTable, keyOf, labelPath, primaryKey, rowLabel, state } from '../core.js';
import { pathEqualityFilter } from '../resourceRequests.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { PageView } from './Page.js';
import type { SectionPlan } from './pageModel.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { useWalk } from './walk.js';
import { say } from '../copy/workbench/components/PagePreview.js';
import { shellBody, shellRoot } from '../shellHost.js';

export interface PagePreviewContext {
  connection: string;
  recordKey?: Record<string, unknown>;
}
interface PagePreviewProps extends PagePreviewContext {
  draft: PageDef;
  onClose: () => void;
}

export function PagePreview({ onClose, ...props }: PagePreviewProps) {
  const [width, setWidth] = useState(1280);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
  const [density] = useState(() => Number(getComputedStyle(shellRoot()).zoom) || 1);
  useEffect(
    () => () => {
      client.clear();
    },
    [client],
  );
  useEffect(() => {
    if (!target) return;
    // Keyboard events inside a viewport do not bubble to the parent dialog.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const doc = target.ownerDocument;
    doc.addEventListener('keydown', escape);
    return () => doc.removeEventListener('keydown', escape);
  }, [target, onClose]);
  useWalk();
  const current = state.activeConnection === props.connection;
  const prepare = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.head.replaceChildren(
      ...Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'), (node) => node.cloneNode(true)),
    );
    doc.documentElement.className = shellRoot().className;
    doc.documentElement.style.cssText = shellRoot().style.cssText;
    for (const attr of shellRoot().attributes) if (attr.name.startsWith('data-')) doc.documentElement.setAttribute(attr.name, attr.value);
    doc.body.className = shellBody().className;
    doc.body.classList.remove('write-mode', 'editing-layout');
    doc.body.style.cssText = 'display:block;min-width:0;height:auto;overflow:auto';
    setTarget(doc.body);
  };
  return (
    <Modal className="page-preview" ariaLabel={say('unsavedPagePreview')} onClose={onClose}>
      <div className="page-preview-head">
        <h2>{say('pagePreview')}</h2>
        <div className="page-preview-modes" role="group" aria-label={say('previewViewport')}>
          {[
            { width: 1280, label: say('desktop') },
            { width: 390, label: say('mobile') },
          ].map((mode) => (
            <button
              key={mode.width}
              type="button"
              className="ghost"
              aria-pressed={width === mode.width}
              onClick={() => setWidth(mode.width)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <span className="note">{say('pxUnsavedReadOnly', { width })}</span>
        <button type="button" className="ghost" aria-label={say('closePreview')} onClick={onClose}>
          {say('common.close')}
        </button>
      </div>
      {current ? (
        <div className="page-preview-scroll">
          <iframe
            ref={frame}
            title={say('pageLayoutPreview')}
            className="page-preview-frame"
            style={{ width, zoom: 1 / density, height: `calc(100% * ${density})` }}
            onLoad={prepare}
            srcDoc={say('doctypeHtmlHtmlHead')}
          />
        </div>
      ) : (
        <p role="alert">{say('theConnectionChangedClose')}</p>
      )}
      {current &&
        target &&
        createPortal(
          <QueryClientProvider client={client}>
            <PreviewRecord {...props} />
          </QueryClientProvider>,
          target,
        )}
    </Modal>
  );
}

function PreviewRecord({ draft, connection, recordKey }: Omit<PagePreviewProps, 'onClose'>) {
  const base = findTable(draft.base) as TableMeta | undefined;
  const [label, setLabel] = useState('');
  const root = useQuery<{ rows?: Array<Record<string, unknown>> }>({
    queryKey: ['preview-root', connection, draft.base, recordKey],
    enabled: Boolean(base),
    queryFn: () => {
      const keys = primaryKey(base!) as string[];
      const naming = labelPath(base!) as string | undefined;
      return api('/api/view/run', {
        ...ownedBy(connection),
        view: {
          id: 'preview-root',
          name: 'Preview record',
          base: draft.base,
          columns: [...new Set([...keys, ...(naming ? [naming] : [])])].map((path) => ({ path })),
          ...(recordKey ? { filter: pathEqualityFilter(Object.fromEntries(keys.map((path) => [path, recordKey[path]]))) } : {}),
          limit: 1,
        },
      });
    },
  });
  const row = root.data?.rows?.[0];
  const key = row && base ? (keyOf(base, row) as Record<string, unknown> | null) : null;
  const plan = useQuery<{ plans: SectionPlan[] }>({
    queryKey: ['preview-plan', connection, draft, key],
    queryFn: () => api('/api/pages/plan', { ...ownedBy(connection), page: draft, key }),
    enabled: Boolean(key),
  });
  if (!base) return <p role="alert">{say('theBaseTableIsUnavailable')}</p>;
  if (root.isError || plan.isError) return <p role="alert">{(root.error ?? plan.error)?.message}</p>;
  if (root.isPending || (key && plan.isPending)) return <p role="status">{say('loadingPreview')}</p>;
  if (!row || !key) return <p role="status">{say('noRecordIsAvailable')}</p>;
  return (
    <div className="panel-pad">
      <PageView
        page={{ ...draft, source: draft.source ?? 'saved' }}
        base={base}
        plans={plan.data?.plans ?? []}
        entry={{ kind: 'page', pageId: draft.id, table: draft.base, key, label: label || rowLabel(base, row) }}
        others={[]}
        onLabel={setLabel}
        onTab={() => {}}
        onLayout={() => {}}
        preview={{ connection }}
      />
    </div>
  );
}
