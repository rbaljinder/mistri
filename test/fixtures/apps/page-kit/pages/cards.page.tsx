/** Parts inside Cards: a chart in a Card with no title of its own, beside a titled Card, so e2e/page-kit.spec.ts can see
    the chart's title become the Card's head and line up with the titled Card's, with no second box inside the first. A
    third holds a Metric and a kit Stat whose change says what it is against. */
import { Breakdown, Card, Chart, Metric, PageGrid, StatCard, definePage } from '@mistriwork/mistri/page';

const page = definePage({ label: 'Cards', reads: ['thing'], component: Cards });
export default page;

function Cards() {
  return (
    <PageGrid>
      <Card title="Held">
        <Breakdown title="Held by name" from="thing" by="name" shape="bars" />
      </Card>
      <Card>
        <Chart title="Things by name" from="thing" by="name" shape="bar" />
      </Card>
      <Card title="Counted">
        <Metric title="Things" from="thing" />
        <StatCard label="Added" value="3" delta={{ value: 1, good: 'up', against: 'vs last week' }} />
      </Card>
    </PageGrid>
  );
}
