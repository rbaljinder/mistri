/**
 * What this schema will cost you.
 *
 * The `lint` tool answers it for an agent and `--lint` answers it for CI;
 * this is the same tool through the same endpoint, for the person who can
 * actually fix the unindexed key. Every finding is a fact already on screen
 * somewhere — the keys in the diagram, the types in the table view — and
 * what the check adds is the consequence, which nobody reads a catalog to
 * work out. Findings are grouped by table, then by rule with the cost said
 * once: four findings of one rule are four columns and one consequence.
 */
import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, findTable, go, state, tableView } from '@mistriwork/kit/client/core.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { say } from '../copy/workbench/components/ShapeCheck.js';

interface Finding {
  table: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
  why?: string;
}
interface Result {
  findings?: Finding[];
  rules?: Record<string, { why?: string }>;
  counts?: { high: number; medium: number; low: number };
}

export function ShapeCheckDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<ModalHandle>(null);
  /* `all: true` because this is the panel, not an agent's first orientation:
     the tool samples five findings per rule by default, right for an agent
     spending context, wrong for a person who opened a list to read it. */
  const lint = useQuery<{ structuredContent?: Result }>({
    queryKey: ['lint', (state as { activeConnection?: string }).activeConnection ?? ''],
    queryFn: () => api('/api/agent/call', { name: 'lint', arguments: { all: true } }),
    staleTime: 0,
  });
  const close = () => dialog.current?.close();
  const result = lint.data?.structuredContent ?? {};
  const findings = result.findings ?? [];
  const rules = result.rules ?? {};
  const counts = result.counts ?? { high: 0, medium: 0, low: 0 };
  const byTable = new Map<string, Finding[]>();
  for (const finding of findings) byTable.set(finding.table, [...(byTable.get(finding.table) ?? []), finding]);
  const byRule = (list: Finding[]) => {
    const groups = new Map<string, Finding[]>();
    for (const f of list) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f]);
    return [...groups];
  };
  return (
    <Modal className="conn-manager shape-check" ref={dialog} onClose={onClose} ariaLabel={say('checkTheShape')} plain backdrop={false}>
      <div className="conn-inner">
        {lint.isPending ? (
          <p className="loading">{say('readingTheCatalog')}</p>
        ) : lint.isError ? (
          <p className="note">{(lint.error as Error).message}</p>
        ) : (
          <>
            <div className="conn-head">
              <h2>{say('checkTheShape')}</h2>
              <button type="button" className="ghost" aria-label={say('common.close')} onClick={close}>
                ×
              </button>
            </div>
            <p className="find-note">
              <span>
                {findings.length
                  ? say('highMediumLowRead', { high: counts.high, medium: counts.medium, low: counts.low })
                  : say('nothingToReportNoMissing')}
              </span>
            </p>
            {[...byTable].map(([table, list]) => (
              <div key={table} className="shape-check-group">
                {/* Every finding is about a table, and the useful next move is looking at it. */}
                <button
                  type="button"
                  className="shape-check-table"
                  title={say('openTable', { table })}
                  onClick={() => {
                    close();
                    go(tableView((findTable(table) as TableMeta | undefined)?.id ?? table), 'reset');
                  }}
                >
                  <span>{(findTable(table) as TableMeta | undefined)?.name ?? table}</span>
                  <span className="shape-check-count">{`${list.length}`}</span>
                </button>
                {byRule(list).map(([rule, found]) => (
                  <div key={rule} className={`shape-check-rule-group tone-${found[0].severity ?? 'low'}`}>
                    <p className="shape-check-why">
                      <span className="shape-check-rule">{rule}</span>
                      <span>{rules[rule]?.why ?? found[0].why ?? ''}</span>
                    </p>
                    {found.map((finding, i) => (
                      <p key={i} className="shape-check-item">
                        {finding.message}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
