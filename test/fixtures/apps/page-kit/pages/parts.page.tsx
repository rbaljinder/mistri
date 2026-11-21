/** One of each kit part a designed page is built from, over the seeded deals: a counted filter, a table with an identity
    column and a status, a windowed figure, bars, a person, a record's details, and a verb hidden where it is not offered.
    e2e/page-parts-themes.spec.ts reads it in every look, light and dark, at a desk and at a phone. */
import {
  ActionButton,
  Bars,
  Breakdown,
  Card,
  Details,
  Grid,
  Metric,
  Person,
  Stack,
  Table,
  definePage,
  useRows,
} from '@mistriwork/mistri/page';

const STAGES = ['proposal', 'negotiation', 'won', 'lost'] as const;

const page = definePage({
  label: 'Parts',
  reads: ['deal'],
  actions: ['markWon'],
  params: { stage: STAGES, window: ['last-30-days', 'last-90-days'] },
  component: Parts,
});
export default page;

function Parts() {
  const [stage] = page.useParam('stage');
  const deals = page.useRows('deal', {
    show: ['name', 'owner', 'stage', 'amount', 'closed_on'],
    where: stage ? { stage } : undefined,
    sort: 'closed_on desc',
    limit: 10,
  });
  const everyone = useRows('deal', { show: ['owner', 'amount'], limit: 50 });
  const rows = deals.data ?? [];
  const first = rows[0];
  const byOwner = new Map<string, number>();
  for (const row of everyone.data ?? []) byOwner.set(String(row.owner), (byOwner.get(String(row.owner)) ?? 0) + Number(row.amount));

  return (
    <Stack>
      <page.Choose param="stage" count all="All deals" />
      <Card title="Deals">
        <Table
          label="Deals"
          rows={rows}
          rowKey={(row) => String(row.id)}
          columns={[
            { key: 'name', label: 'Deal', secondary: 'owner' },
            { key: 'owner', label: 'Owner', avatar: (row) => ({ name: String(row.owner) }), emphasis: 'normal' },
            { key: 'stage', label: 'Stage', resource: 'deal', column: 'stage' },
            { key: 'amount', label: 'Amount', align: 'right', resource: 'deal', column: 'amount' },
          ]}
        />
      </Card>
      <Grid>
        <Card>
          <Metric title="Won" from="deal" query="stage = won" measure="sum amount" over="closed_on" window="window" previous spark />
        </Card>
        <Card>
          <Breakdown title="Pipeline by stage" from="deal" by="stage" measure="sum amount" shape="bars" also="count" format="money" />
        </Card>
        <Card title="By owner">
          <Bars
            label="Deal value by owner"
            format="money"
            items={[...byOwner].map(([owner, value]) => ({ key: owner, label: owner, value }))}
          />
        </Card>
        <Card title="Latest deal">
          {first ? (
            <Stack>
              <Person name={String(first.owner)} secondary={String(first.name)} size="md" />
              <Details
                resource="deal"
                row={first}
                fields={['stage', 'amount', 'closed_on', { label: 'Owner', value: String(first.owner) }]}
                columns={2}
              />
            </Stack>
          ) : null}
        </Card>
        <Card title="Offered verbs">
          <Stack>
            {rows.slice(0, 4).map((row) => (
              <ActionButton key={String(row.id)} action="markWon" row={row} unavailable="hide" intent="secondary" />
            ))}
          </Stack>
        </Card>
      </Grid>
    </Stack>
  );
}
