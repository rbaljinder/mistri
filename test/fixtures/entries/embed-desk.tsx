/**
 * Headless Mistri operations desk fixture typechecking `@mistriwork/mistri/react/headless`
 * alongside `@mistriwork/mistri/{ui,charts,primitives,views}`.
 */
import { type ReactNode, useMemo, useState } from 'react';
import { Provider, useCommand, useRows } from '@mistriwork/mistri/react/headless';
import { AiBadge, Button, EmptyState, Row, SegmentedControl, Stack, StatCard, StatusDot } from '@mistriwork/mistri/ui';
import { BarChart, DonutChart, Sparkline } from '@mistriwork/mistri/charts';
import { Card, CardBody, CardHeader, CardTitle, CommandPalette, Grid } from '@mistriwork/mistri/primitives';
import { AppShell, DataTable, FilterBar, KanbanBoard, PageHeader, ReviewQueueView, type DataTableColumn } from '@mistriwork/mistri/views';

interface ApplicationRow {
  id: string;
  reference: string;
  status: string;
  reviewer: string;
  rawId: unknown;
}

export function UnderwritingApplications(): ReactNode {
  const rows = useRows('loan_application', { show: ['id', 'reference', 'status', 'assigned'] });
  const assign = useCommand('assignReviewer');
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [view, setView] = useState('table');
  const [search, setSearch] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const items = useMemo<ApplicationRow[]>(() => {
    return (rows.data ?? []).map((row) => ({
      id: String(row.id),
      rawId: row.id,
      reference: String(row.reference ?? ''),
      status: String(row.status ?? 'pending'),
      reviewer: row.assigned == null ? 'Unassigned' : `Reviewer #${String(row.assigned)}`,
    }));
  }, [rows.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.reference.toLowerCase().includes(q) || item.status.toLowerCase().includes(q));
  }, [items, search]);

  const unassignedCount = items.filter((r) => r.reviewer === 'Unassigned').length;

  const telemetry = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of items) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    const entries = [...counts.entries()].map(([status, total]) => ({ status, total }));
    return {
      barRows: entries.length ? entries : [{ status: 'pending', total: 0 }],
      donut: entries.map(({ status, total }) => ({ label: status, value: total })),
      spark: items.map((_, idx) => idx + 1),
    };
  }, [items]);

  const assignRow = async (target?: ApplicationRow) => {
    const row = target ?? items[0];
    if (!row) return;
    const outcome = await assign.run({ id: row.rawId }, { reviewer: 3, reason: 'Assigned from Precision desk.' });
    setNotice(`${outcome.status}: ${'message' in outcome ? outcome.message : `Assigned ${row.reference}`}`);
    void rows.refetch();
  };

  const columns: DataTableColumn<ApplicationRow>[] = [
    { id: 'reference', header: 'Application', accessor: 'reference', sortable: true },
    {
      id: 'status',
      header: 'Status',
      accessor: 'status',
      cell: (row) => <StatusDot tone={row.reviewer === 'Unassigned' ? 'warning' : 'good'}>{row.status}</StatusDot>,
    },
    { id: 'reviewer', header: 'Reviewer', accessor: 'reviewer' },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (row) => (
        <Button variant="secondary" size="sm" disabled={!assign.granted} onClick={() => void assignRow(row)}>
          Assign Robin
        </Button>
      ),
    },
  ];

  return (
    <div data-theme={mode}>
      <AppShell
        sidebarProps={{
          workspaces: [{ id: 'north', name: 'North Desk', plan: 'Operations' }],
          activeWorkspaceId: 'north',
          onSearchTrigger: () => setPaletteOpen(true),
          activeItemId: view,
          onSelectItem: (id) => setView(id),
          items: [
            { id: 'table', label: 'Applications' },
            { id: 'board', label: 'Kanban Board' },
            { id: 'triage', label: 'Review Queue' },
            { id: 'telemetry', label: 'Telemetry' },
          ],
        }}
        breadcrumbs={[{ label: 'Command Desk' }, { label: 'Underwriting' }]}
        topBarActions={
          <Button variant="secondary" size="sm" onClick={() => setMode((prev) => (prev === 'light' ? 'dark' : 'light'))}>
            {mode === 'light' ? 'Dark' : 'Light'}
          </Button>
        }
        header={
          <PageHeader title="Loan Applications" description="Real-time underwriting queue backed by Mistri commands" badge={<AiBadge />} />
        }
      >
        <Stack>
          <Grid columns={3} gap="sm">
            <StatCard label="Applications" value={String(items.length)} delta={{ value: 12, good: 'up' }} />
            <StatCard label="Unassigned" value={String(unassignedCount)} />
            <StatCard label="Command gate" value={assign.granted ? 'Granted' : 'Restricted'} />
          </Grid>

          <FilterBar
            facets={[]}
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Filter applications…"
            actions={
              <SegmentedControl
                ariaLabel="View"
                size="sm"
                value={view}
                onValueChange={(next) => setView(next)}
                options={[
                  { value: 'table', label: 'Table' },
                  { value: 'board', label: 'Board' },
                  { value: 'triage', label: 'Triage' },
                  { value: 'telemetry', label: 'Charts' },
                ]}
              />
            }
          />

          {view === 'telemetry' ? (
            <Grid columns={2} gap="md">
              <Card>
                <CardHeader>
                  <CardTitle>Applications by status</CardTitle>
                  <Sparkline data={telemetry.spark.length ? telemetry.spark : [1, 2, 3]} />
                </CardHeader>
                <CardBody>
                  <BarChart data={telemetry.barRows} xKey="status" series={[{ key: 'total', label: 'Applications' }]} height={180} />
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <DonutChart
                    data={telemetry.donut.length ? telemetry.donut : [{ label: 'Queue', value: 1 }]}
                    centerLabel="Total"
                    centerValue={String(items.length)}
                  />
                </CardBody>
              </Card>
            </Grid>
          ) : view === 'board' ? (
            <KanbanBoard
              columns={[
                { id: 'unassigned', title: 'Unassigned', tone: 'warning' },
                { id: 'assigned', title: 'Assigned', tone: 'good' },
              ]}
              cards={filtered.map((r) => ({ id: r.id, code: r.reference, title: r.reference, description: r.status }))}
              defaultValue={{
                unassigned: filtered.filter((r) => r.reviewer === 'Unassigned').map((r) => r.id),
                assigned: filtered.filter((r) => r.reviewer !== 'Unassigned').map((r) => r.id),
              }}
            />
          ) : view === 'triage' ? (
            <ReviewQueueView
              items={filtered.map((r) => ({
                id: r.id,
                code: r.reference,
                title: `Application ${r.reference}`,
                requester: { name: 'Applicant' },
                summary: `Current status: ${r.status} (${r.reviewer})`,
                raw: r,
              }))}
              onApprove={(item) => {
                const target = items.find((r) => r.id === item.id);
                if (target) void assignRow(target);
              }}
            />
          ) : filtered.length === 0 ? (
            <EmptyState title="No matching applications" description="Clear the filter or seed the Command desk fixture database." />
          ) : (
            <DataTable data={filtered} columns={columns} getRowId={(row) => row.id} selectable />
          )}

          <div
            data-theme="dark"
            style={{
              padding: 12,
              borderRadius: 'var(--radius)',
              background: 'var(--surface)',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
            }}
          >
            <Row>
              <span>Quick dispatch ({assign.granted ? 'ready' : 'locked'})</span>
              <Button variant="primary" size="sm" disabled={!assign.granted} onClick={() => void assignRow()}>
                Assign Robin Bell
              </Button>
            </Row>
            {notice && <output style={{ display: 'block', marginTop: 8 }}>{notice}</output>}
          </div>

          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            groups={[
              {
                heading: 'Underwriting',
                items: [
                  {
                    id: 'assign-first',
                    label: 'Assign Robin Bell to first application',
                    onSelect: () => {
                      setPaletteOpen(false);
                      void assignRow();
                    },
                  },
                ],
              },
            ]}
          />
        </Stack>
      </AppShell>
    </div>
  );
}

export function CommandDeskHost(): ReactNode {
  return (
    <Provider endpoint="/api/mistri" app="command-desk" surface="applications" fallback={<p>Signing in…</p>}>
      <UnderwritingApplications />
    </Provider>
  );
}
