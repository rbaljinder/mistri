/** A page that asks nineteen lists on entry, as a field report's did: e2e/page-kit.spec.ts counts the requests they
    make, which the client batches into one (kit breakdownBatch.ts), each list still drawing its own rows. */
import { Card, PageGrid, Text, definePage, useRows } from '@mistriwork/mistri/page';

const page = definePage({ label: 'Many reads', reads: ['thing', 'part', 'note', 'deal'], component: Many });
export default page;

const ASKED = [
  { resource: 'thing', query: '' },
  { resource: 'thing', query: 'name = "Anvil"' },
  { resource: 'thing', query: 'name = "Bellows"' },
  { resource: 'thing', query: 'name = "Chisel"' },
  { resource: 'part', query: '' },
  { resource: 'part', query: 'name = "Horn"' },
  { resource: 'part', query: 'name = "Heel"' },
  { resource: 'note', query: '' },
  { resource: 'deal', query: '' },
  { resource: 'deal', query: 'stage = won' },
  { resource: 'deal', query: 'stage = lost' },
  { resource: 'deal', query: 'stage = proposal' },
  { resource: 'deal', query: 'stage = negotiation' },
  { resource: 'deal', query: 'owner = "Ana Ruiz"' },
  { resource: 'deal', query: 'owner = "Ben Okafor"' },
  { resource: 'deal', query: 'owner = "Cy Marlow"' },
  { resource: 'deal', query: 'amount > 20000' },
  { resource: 'deal', query: 'amount < 10000' },
  { resource: 'deal', query: 'amount >= 10000 and amount <= 20000' },
] as const;

function Many() {
  return (
    <PageGrid>
      {ASKED.map((asked, at) => (
        <List key={at} at={at} resource={asked.resource} query={asked.query} />
      ))}
    </PageGrid>
  );
}

function List({ at, resource, query }: { at: number; resource: string; query: string }) {
  const rows = useRows(resource, { show: [resource === 'note' ? 'body' : 'name'], ...(query ? { query } : {}) });
  return (
    <Card title={`${resource} ${at + 1}`}>
      <Text>{rows.isPending ? 'Reading' : rows.isError ? 'Refused' : `${rows.data?.length ?? 0} rows`}</Text>
    </Card>
  );
}
