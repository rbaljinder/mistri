/** The sales dashboard on the kit's parts: windowed figures against the window before, the open pipeline as bars, won
    revenue over the window and the largest open deals. The window is the page's one control, in its address. */
import { Breakdown, Card, Chart, Grid, Metric, PageHeader, Scope, Stack, Table, definePage, useNavigate } from '@mistriwork/mistri/page';

const OPEN = 'stage != closed_won and stage != closed_lost';
const WON = { query: 'stage = closed_won', over: 'close_date', window: 'window', previous: true, spark: true, width: 'third' } as const;

const page = definePage({
  label: 'Sales dashboard',
  icon: 'chart-line',
  nav: { group: 'sales', position: 0 },
  head: false,
  reads: ['opportunity', 'account', 'sales_rep'],
  params: { window: ['last-90-days', 'last-30-days', 'last-365-days'] },
  component: SalesDashboard,
});
export default page;

function SalesDashboard() {
  const navigate = useNavigate();
  const [window = 'last-90-days'] = page.useParam('window');
  const by = window === 'last-365-days' ? 'month close_date' : 'week close_date';
  const deals = page.useRows('opportunity', {
    show: ['name', 'account_id.name', 'owner_id.name', 'stage', 'amount', 'close_date'],
    query: OPEN,
    sort: 'amount desc',
    limit: 8,
  });

  return (
    <Stack>
      <PageHeader title="Sales" description="Won revenue, against the window before." actions={<page.Choose param="window" />} />
      <Scope from="opportunity">
        <Grid>
          <Metric {...WON} title="Won revenue" measure="sum amount" />
          <Metric {...WON} title="Deals won" />
          <Metric {...WON} title="Average deal" measure="avg amount" />
          <Breakdown title="Open pipeline" by="stage" query={OPEN} measure="sum amount" also="count" shape="bars" width="half" />
          <Chart
            title="Won revenue"
            by={by}
            query={`stage = closed_won and close_date = ${window.replace(/-/g, ' ')}`}
            measure="sum amount"
            fill="window"
            width="half"
          />
        </Grid>
      </Scope>
      <Card title="Largest open deals">
        <Table
          label="Largest open deals"
          rows={deals.data ?? []}
          rowKey={(row) => String(row.id)}
          columns={[
            { key: 'name', label: 'Deal', secondary: 'account_id.name' },
            { key: 'stage', label: 'Stage', resource: 'opportunity', column: 'stage' },
            { key: 'owner_id.name', label: 'Owner' },
            { key: 'close_date', label: 'Closes', align: 'right', resource: 'opportunity', column: 'close_date' },
            { key: 'amount', label: 'Amount', align: 'right', resource: 'opportunity', column: 'amount' },
          ]}
          onRowClick={(row) => navigate.openRecord('opportunity', { id: row.id })}
          empty={deals.isPending ? null : 'No open deals.'}
        />
      </Card>
    </Stack>
  );
}
