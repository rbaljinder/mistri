/** One of each piece of the page kit's layout vocabulary: e2e/page-kit.spec.ts measures them in a browser. */
import {
  Beside,
  Button,
  Card,
  FileField,
  Item,
  Items,
  Loaded,
  Segmented,
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
  const [file, setFile] = useState<File | null>(null);
  return (
    <Beside
      railWidth="14rem"
      rail={
        <Card title="Rail" description="What goes with the column">
          <Text tone="muted">A note in the rail.</Text>
        </Card>
      }
    >
      <Stack>
        <Card title="Things" description="Everything we hold" tone="warn">
          <Loaded query={things} loading={<Skeleton lines={3} />} empty={null}>
            {(rows) => (
              <Items label="Things">
                {rows.map((row, at) => (
                  <Item
                    key={String(row.id)}
                    title={String(row.name)}
                    note="Held in the yard"
                    lead={at === 0 ? '09:30' : undefined}
                    tone={at === 1 ? 'bad' : undefined}
                    href="/vocabulary?seen=1"
                  />
                ))}
              </Items>
            )}
          </Loaded>
        </Card>
        <Card title="Controls">
          <Segmented
            label="Range"
            value={range}
            onChange={setRange}
            options={[
              { value: 'week', label: 'Week', count: 3 },
              { value: 'month', label: 'Month', count: 12 },
            ]}
          />
          <Button href="/vocabulary?opened=1">Open</Button>
          <FileField label="Attachment" value={file} onChange={setFile} />
          <Skeleton height={24} width={160} />
        </Card>
      </Stack>
    </Beside>
  );
}
