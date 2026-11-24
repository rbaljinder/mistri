/** One lead as a page, on the kit's parts: who it is and what to do next on top, the facts and the person it became
    beside, and what has happened with them as the lead page's own timeline, with the deals of the account it became. */
import {
  ActionButton,
  Beside,
  Button,
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Person,
  Skeleton,
  Stack,
  Table,
  Timeline,
} from '@mistriwork/mistri/page';
import { definePage, useHref } from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Lead',
  icon: 'address-book',
  nav: false,
  head: false,
  reads: ['lead', 'sales_rep', 'campaign_member', 'campaign', 'contact', 'account', 'activity', 'opportunity'],
  actions: ['startWorking', 'markQualified', 'markLost'],
  params: { id: 'id' },
  component: Lead,
});
export default page;

function Lead() {
  const [id] = page.useParam('id');
  const href = useHref();
  const lead = page.useRecord('lead', id === undefined ? undefined : { id }, [
    'id',
    'name',
    'company',
    'email',
    'phone',
    'status',
    'source',
    'created_on',
    'owner_id.name',
    'converted_contact_id',
    'converted_contact_id.name',
    'converted_contact_id.title',
    'converted_contact_id.account_id',
  ]);
  const row = lead.data;
  const contact = row?.converted_contact_id ?? undefined;
  const account = row?.['converted_contact_id.account_id'] ?? undefined;
  const deals = page.useRows('opportunity', {
    show: ['name', 'stage', 'amount', 'close_date'],
    where: { account_id: account ?? -1 },
    sort: 'close_date desc',
    enabled: account !== undefined,
    limit: 5,
  });

  if (lead.isPending || id === undefined) return <Skeleton lines={10} />;
  if (!row) return <EmptyState title="No such lead" description="It may have been removed, or the link is from somewhere else." />;

  return (
    <Stack>
      <PageHeader
        title={row.name}
        description={[row.company, row['owner_id.name'] && `Owned by ${row['owner_id.name']}`].filter(Boolean).join(' · ')}
        back={{ label: 'Leads', href: href.page('leads') }}
        actions={
          <>
            {row.email ? (
              <Button variant="secondary" href={`mailto:${row.email}`}>
                Email
              </Button>
            ) : null}
            <ActionButton action="markLost" row={row} variant="secondary" label="Mark lost" unavailable="hide" />
            <ActionButton action="startWorking" row={row} variant="primary" label="Start working" unavailable="hide" />
            <ActionButton action="markQualified" row={row} variant="primary" label="Mark qualified" unavailable="hide" />
            <Button variant="ghost" href={href.record('lead-records', { id: row.id })}>
              Edit
            </Button>
          </>
        }
      />
      <Beside
        side="start"
        railWidth="20rem"
        rail={
          <Stack>
            <Card title="Details">
              <DescriptionList
                resource="lead"
                row={row}
                fields={[
                  'status',
                  'company',
                  'email',
                  'phone',
                  'source',
                  { label: 'Owner', value: row['owner_id.name'] ?? 'Unassigned' },
                  'created_on',
                ]}
              />
            </Card>
            {contact === undefined ? null : (
              <Card title="Converted to">
                <Person
                  name={String(row['converted_contact_id.name'])}
                  secondary={String(row['converted_contact_id.title'] ?? '')}
                  href={href.record('contacts', { id: contact })}
                />
              </Card>
            )}
          </Stack>
        }
      >
        <Stack>
          <Card title="Activity">
            <Timeline from="lead" record={row} />
          </Card>
          {account === undefined ? null : (
            <Card title="Opportunities" count={deals.data?.length}>
              <Table
                ariaLabel="Opportunities"
                rows={deals.data ?? []}
                rowKey={(deal) => String(deal.id)}
                columns={[
                  { key: 'name', label: 'Deal' },
                  { key: 'stage', label: 'Stage', resource: 'opportunity', column: 'stage' },
                  { key: 'amount', label: 'Amount', align: 'right', resource: 'opportunity', column: 'amount' },
                ]}
                empty="No opportunities on this account yet."
              />
            </Card>
          )}
        </Stack>
      </Beside>
    </Stack>
  );
}
