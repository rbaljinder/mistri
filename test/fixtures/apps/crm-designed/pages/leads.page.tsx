/** The leads list as a page, on the kit's parts: figures, a counted filter, a search and a table whose first cell is the person. */
import {
  Button,
  Card,
  Cluster,
  Metric,
  PageGrid,
  PageHeader,
  Stack,
  Table,
  definePage,
  useHref,
  useNavigate,
} from '@mistriwork/mistri/page';

const STATUSES = ['new', 'working', 'qualified', 'converted', 'lost'] as const;

const page = definePage({
  label: 'Leads',
  icon: 'address-book',
  nav: { group: 'sales', position: 1 },
  head: false,
  reads: ['lead', 'sales_rep'],
  params: { status: STATUSES, q: 'text' },
  component: Leads,
});
export default page;

function Leads() {
  const href = useHref();
  const navigate = useNavigate();
  const [status] = page.useParam('status');
  const [q] = page.useParam('q');
  const phrase = q?.replace(/"/g, '').trim();
  const leads = page.useRows('lead', {
    show: ['name', 'company', 'status', 'source', 'owner_id.name', 'created_on'],
    where: status ? { status } : undefined,
    query: phrase ? `(name contains "${phrase}" or company contains "${phrase}")` : undefined,
    sort: 'created_on desc',
    limit: 25,
  });

  return (
    <Stack>
      <PageHeader
        title="Leads"
        description="Everyone who might buy, from first touch to converted."
        actions={
          <Button variant="primary" href={`${href.view('lead-records')}/new`}>
            New lead
          </Button>
        }
      />
      <PageGrid>
        <Metric title="Open leads" from="lead" query="status = new or status = working or status = qualified" width="third" />
        <Metric title="New this week" from="lead" query="created_on = last 7 days" over="created_on" previous spark width="third" />
        <Metric title="Qualified" from="lead" query="status = qualified" width="third" />
      </PageGrid>
      <Card>
        <Stack>
          <Cluster min="16rem">
            <page.Choose param="status" count={{ of: 'lead', by: 'status' }} all="All" />
            <page.Search param="q" placeholder="Search name or company" />
          </Cluster>
          <Table
            ariaLabel="Leads"
            rows={leads.data ?? []}
            rowKey={(row) => String(row.id)}
            columns={[
              { key: 'name', label: 'Lead', avatar: (row) => ({ name: String(row.name) }), secondary: 'company' },
              { key: 'status', label: 'Status', resource: 'lead', column: 'status' },
              { key: 'owner_id.name', label: 'Owner' },
              { key: 'source', label: 'Source', resource: 'lead', column: 'source' },
              { key: 'created_on', label: 'Added', align: 'right', resource: 'lead', column: 'created_on' },
            ]}
            onRowClick={(row) => navigate.openPage('lead', { id: String(row.id) })}
            empty={leads.isPending ? null : phrase ? `No leads match “${phrase}”.` : 'No leads here yet.'}
          />
          {leads.page.hasMore ? (
            <Button variant="secondary" size="sm" loading={leads.isFetching} onClick={() => leads.more()}>
              Show more
            </Button>
          ) : null}
        </Stack>
      </Card>
    </Stack>
  );
}
