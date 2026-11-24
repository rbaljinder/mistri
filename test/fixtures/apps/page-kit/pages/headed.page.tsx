/** A page that draws its own head (`head: false`): a title, an intro and a picker, which e2e/page-kit.spec.ts lays out at a phone and at a desk. */
import { PageHeader, SegmentedControl, definePage } from '@mistriwork/mistri/page';
import { useState } from '@mistriwork/mistri/ui';

const page = definePage({ label: 'Headed', head: false, reads: ['thing'], component: Headed });
export default page;

function Headed() {
  const [range, setRange] = useState('week');
  return (
    <PageHeader
      title="Floor"
      description="What stands on the floor, by bay."
      actions={
        <SegmentedControl
          ariaLabel="Range"
          value={range}
          onValueChange={setRange}
          options={[
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
          ]}
        />
      }
    />
  );
}
