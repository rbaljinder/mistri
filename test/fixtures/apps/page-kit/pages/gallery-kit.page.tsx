/** Runtime gallery page for Mistri `/ui` and `/page` kit & DSL blocks (`/gallery-kit`). */
import {
  ActionButton,
  Board,
  Breakdown,
  Calendar,
  Card,
  Chart,
  Columns,
  DescriptionList,
  Loaded,
  Metric,
  PageGrid,
  Panel,
  RecordList,
  RecordSplit,
  Row,
  Rows,
  Stack,
  Table,
  Text,
  Tile,
  Value,
  definePage,
  useState,
} from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Gallery kit',
  nav: false,
  reads: ['deal', 'thing'],
  actions: ['markWon'],
  params: { deal: 'text' },
  component: GalleryKit,
});
export default page;

function GalleryKit() {
  const [selectedTile, setSelectedTile] = useState<'deals' | 'things'>('deals');
  const deals = page.useRows('deal', {
    show: ['name', 'owner', 'stage', 'amount', 'closed_on'],
    sort: 'closed_on desc',
    limit: 6,
  });

  return (
    <Stack>
      <Card title="PageGrid inside Card & interactive Tiles">
        <PageGrid>
          <Panel title="Deals lens" width="half">
            <Tile selected={selectedTile === 'deals'} onClick={() => setSelectedTile('deals')}>
              <Text>Active pipeline deals</Text>
            </Tile>
          </Panel>
          <Panel title="Inventory lens" width="half">
            <Tile selected={selectedTile === 'things'} onClick={() => setSelectedTile('things')}>
              <Text>Workshop equipment</Text>
            </Tile>
          </Panel>
        </PageGrid>
      </Card>

      <PageGrid>
        <Metric title="Won revenue" from="deal" query="stage = won" measure="sum amount" format="money" width="half" />
        <Breakdown title="Deals by stage" from="deal" by="stage" measure="sum amount" shape="bars" format="money" width="half" />
        <Chart title="Closed amounts" from="deal" by="stage" measure="sum amount" shape="bar" format="money" width="half" />
        <Rows
          title="Recent deals"
          from="deal"
          show={['name', 'owner', 'stage', 'amount', 'closed_on']}
          sort="closed_on desc"
          limit={6}
          width="half"
        />
      </PageGrid>

      <Card title="Stacked period Columns & Loaded Table">
        <Columns
          rows={[
            { key: 'W1', values: { won: 42000, open: 18000 } },
            { key: 'W2', values: { won: 27500, open: 9500 } },
            { key: 'W3', values: { won: 31000, open: 15200 } },
          ]}
          series={[
            { key: 'won', label: 'Won' },
            { key: 'open', label: 'Open' },
          ]}
          height={180}
        />
        <Loaded query={deals}>
          {(rows) => (
            <Table
              ariaLabel="Pipeline table"
              rows={rows}
              rowKey={(r) => String(r.id)}
              columns={[
                { key: 'name', label: 'Deal', secondary: 'owner' },
                { key: 'stage', label: 'Stage', resource: 'deal', column: 'stage' },
                { key: 'amount', label: 'Amount', align: 'right', resource: 'deal', column: 'amount' },
              ]}
            />
          )}
        </Loaded>
      </Card>

      <Card title="RecordList with ActionButton & Value">
        <RecordList from="deal" show={['name', 'owner', 'stage', 'amount']} limit={4} ariaLabel="Top deals">
          {(row) => (
            <Row key={String(row.id)} align="center">
              <Value value={row.name} />
              <Value value={row.stage} resource="deal" column="stage" />
              <Value value={row.amount} resource="deal" column="amount" />
              <ActionButton action="markWon" row={row} unavailable="hide" size="sm" />
            </Row>
          )}
        </RecordList>
      </Card>

      <Card title="Board">
        <Board from="deal" by="stage" primary="name" limit={6} ariaLabel="Deals by stage board" />
      </Card>

      <Card title="Calendar">
        <Calendar from="deal" date="closed_on" primary="name" limit={6} ariaLabel="Deal close calendar" />
      </Card>

      <Card title="RecordSplit">
        <RecordSplit
          from="deal"
          param="deal"
          limit={5}
          ariaLabel="Deal split queue"
          row={{ primary: 'name', lines: ['owner', 'stage'] }}
          detail={['name', 'owner', 'stage', 'amount', 'closed_on']}
        />
      </Card>

      {deals.data?.[0] ? (
        <Card title="DescriptionList">
          <DescriptionList resource="deal" row={deals.data[0]} fields={['name', 'owner', 'stage', 'amount']} columns={2} />
        </Card>
      ) : null}
    </Stack>
  );
}
