/** One of each piece of the page kit's layout vocabulary: e2e/page-kit.spec.ts measures them in a browser. */
import {
  Beside,
  Button,
  Card,
  FileField,
  ItemRow,
  ItemList,
  Loaded,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  definePage,
  useRows,
} from '@mistriwork/mistri/page';
import { useState } from '@mistriwork/mistri/ui';

const page = definePage({ label: 'Vocabulary', reads: ['thing'], component: Vocabulary });
export default page;

function Vocabulary() {
  const things = useRows('thing');
  const [range, setRange] = useState('week');
  const [stage, setStage] = useState('all');
  const [file, setFile] = useState<File | null>(null);
  return (
    <Beside
      railWidth="14rem"
      rail={
        <Card title="Rail" description="What goes with the column">
          <Text muted>A note in the rail.</Text>
        </Card>
      }
    >
      <Stack>
        <Card title="Things" description="Everything we hold" tone="warning">
          <Loaded query={things} loading={<Skeleton lines={3} />} empty={null}>
            {(rows) => (
              <ItemList ariaLabel="Things">
                {rows.map((row, at) => (
                  <ItemRow
                    key={String(row.id)}
                    title={String(row.name)}
                    description="Held in the yard"
                    leading={at === 0 ? '09:30' : undefined}
                    tone={at === 1 ? 'critical' : undefined}
                    href="/vocabulary?seen=1"
                    actions={
                      at === 2 ? (
                        <>
                          <Button href="/vocabulary?accept=1">Accept the delivery</Button>
                          <Button href="/vocabulary?hold=1">Hold it at the gate</Button>
                          <Button href="/vocabulary?return=1">Send it back</Button>
                        </>
                      ) : undefined
                    }
                  />
                ))}
              </ItemList>
            )}
          </Loaded>
        </Card>
        <Card title="Controls">
          <SegmentedControl
            ariaLabel="Range"
            value={range}
            onValueChange={setRange}
            options={[
              { value: 'week', label: 'Week', count: 3 },
              { value: 'month', label: 'Month', count: 12 },
            ]}
          />
          <SegmentedControl
            ariaLabel="Stage"
            className="vocabulary-stage"
            value={stage}
            onValueChange={setStage}
            options={[
              { value: 'all', label: 'All stages' },
              { value: 'new', label: 'New enquiries', count: 4 },
              { value: 'working', label: 'Working' },
              { value: 'quoted', label: 'Quoted' },
              { value: 'won', label: 'Won and closed' },
            ]}
          />
          <Button href="/vocabulary?opened=1">Open</Button>
          <Button href="/vocabulary?intent=primary" variant="primary">
            Go primary
          </Button>
          <Button href="/vocabulary?intent=secondary" variant="secondary">
            Go secondary
          </Button>
          <Button href="/vocabulary?intent=quiet" variant="ghost">
            Go quiet
          </Button>
          <Button href="/vocabulary?intent=danger" variant="danger">
            Go danger
          </Button>
          <Button href="/vocabulary?intent=held" variant="primary" aria-disabled="true">
            Go held
          </Button>
          <FileField label="Attachment" value={file} onValueChange={setFile} />
          <Skeleton height={24} width={160} />
        </Card>
      </Stack>
    </Beside>
  );
}
