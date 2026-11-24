/** Runtime gallery page for all 8 headless behavior primitives (`/gallery-behaviors`). */
import {
  Days,
  DaysDay,
  Editable,
  EditableInput,
  EditableValue,
  Pick,
  PickList,
  PickOption,
  PickPane,
  Scrub,
  ScrubTrack,
  Sortable,
  SortableHandle,
  SortableItem,
  Spans,
  SpansAxis,
  SpansSpan,
  SpansTrack,
  Transfer,
  TransferHandle,
  TransferItem,
  TransferList,
  Turns,
  TurnsName,
  TurnsSkip,
  Widths,
  WidthsColumn,
  WidthsHandle,
} from '@mistriwork/mistri/behaviors';
import { Button, Card, Row, Stack, Text, definePage, useState } from '@mistriwork/mistri/page';
import { FormColumns } from '@mistriwork/mistri/primitives';

export default definePage({
  label: 'Gallery behaviors',
  nav: false,
  reads: ['deal'],
  component: GalleryBehaviors,
});

function GalleryBehaviors() {
  const [order, setOrder] = useState([' check-seal ', ' test-valve ', ' log-reading '].map((s) => s.trim()));
  const [lanes, setLanes] = useState<Record<string, string[]>>({
    queued: ['task-a', 'task-b'],
    assigned: ['task-c'],
  });
  const [activeDay, setActiveDay] = useState('2026-09-04');
  const [spans, setSpans] = useState([{ id: 'sp-1', track: 'bay-1', start: 2, end: 6 }]);
  const [scrubAt, setScrubAt] = useState<number | null>(2);
  const [picked, setPicked] = useState<string | null>('item-1');
  const [handled, setHandled] = useState<string[]>([]);
  const [colWidths, setColWidths] = useState<Record<string, number>>({ asset: 180, status: 120 });
  const [labels, setLabels] = useState<Record<string, string>>({ title: 'Boiler Feed Pump A' });

  return (
    <Stack>
      <FormColumns columns={2}>
        <Card title="Sortable (keyed render)">
          <Sortable value={order} onValueChange={setOrder} by="handle" ariaLabel="Checklist order">
            {(key, index) => (
              <SortableItem value={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }}>
                <SortableHandle ariaLabel={`Reorder ${key}`}>⋮⋮</SortableHandle>
                <Text>{`${index + 1}. ${key}`}</Text>
              </SortableItem>
            )}
          </Sortable>
        </Card>

        <Card title="Transfer (keyed render)">
          <Transfer value={lanes} onValueChange={setLanes} order={['queued', 'assigned']} ariaLabel="Lane transfer">
            <Row>
              {(['queued', 'assigned'] as const).map((lane) => (
                <TransferList
                  key={lane}
                  value={lane}
                  ariaLabel={lane}
                  style={{ listStyle: 'none', padding: 0, margin: 0, minWidth: '120px' }}
                >
                  {(key) => (
                    <TransferItem value={key} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 0' }}>
                      <TransferHandle ariaLabel={`Move ${key}`}>⇄</TransferHandle>
                      <Text>{key}</Text>
                    </TransferItem>
                  )}
                </TransferList>
              ))}
            </Row>
          </Transfer>
        </Card>
      </FormColumns>

      <FormColumns columns={2}>
        <Card title="Widths (focusable keyboard handle)">
          <Widths value={colWidths} onValueChange={setColWidths}>
            {(widths) => (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <WidthsColumn value="asset" label="Asset" style={{ textAlign: 'left', position: 'relative', paddingRight: '16px' }}>
                      Asset
                      <WidthsHandle />
                    </WidthsColumn>
                    <WidthsColumn value="status" label="Status" style={{ textAlign: 'left', position: 'relative', paddingRight: '16px' }}>
                      Status
                      <WidthsHandle />
                    </WidthsColumn>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={widths.asset ? { width: `${widths.asset}px` } : undefined}>Pump A</td>
                    <td style={widths.status ? { width: `${widths.status}px` } : undefined}>Ready</td>
                  </tr>
                </tbody>
              </table>
            )}
          </Widths>
        </Card>

        <Card title="Editable">
          <Editable
            text={(id) => labels[id] ?? ''}
            onCommit={(id, next) => {
              setLabels((prev) => ({ ...prev, [id]: next }));
            }}
          >
            {(editing) =>
              editing === 'title' ? (
                <EditableInput ariaLabel="Edit asset title" />
              ) : (
                <EditableValue value="title" press>
                  {labels.title}
                </EditableValue>
              )
            }
          </Editable>
        </Card>
      </FormColumns>

      <FormColumns columns={2}>
        <Card title="Days">
          <Days value={activeDay} onValueChange={setActiveDay} defaultMonth="2026-09" today="2026-09-04" ariaLabel="Month grid">
            {({ weeks }) => (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '4px' }}>
                {weeks.flat().map((d) => (
                  <DaysDay key={d} value={d} style={{ padding: '4px', textAlign: 'center' }}>
                    {Number(d.slice(-2))}
                  </DaysDay>
                ))}
              </div>
            )}
          </Days>
        </Card>

        <Card title="Spans & Scrub">
          <Spans value={spans} onValueChange={setSpans} min={0} max={10} step={1} label={(s) => `Bay window ${s.start} to ${s.end}`}>
            <div style={{ position: 'relative', height: '44px' }}>
              <SpansAxis step={2} formatValue={(v) => `${v}h`} />
              <SpansTrack value="bay-1" style={{ position: 'relative', height: '28px' }}>
                {(items) =>
                  items.map((span) => (
                    <SpansSpan
                      key={span.id}
                      value={span.id}
                      style={{
                        position: 'absolute',
                        left: `${span.start * 10}%`,
                        width: `${(span.end - span.start) * 10}%`,
                        height: '24px',
                      }}
                    >
                      Bay 1
                    </SpansSpan>
                  ))
                }
              </SpansTrack>
            </div>
          </Spans>

          <Scrub count={5} value={scrubAt} onValueChange={setScrubAt} text={(i) => `Step ${i + 1}`}>
            {(at) => (
              <ScrubTrack ariaLabel="Timeline scrub" style={{ padding: '8px 0' }}>
                <Text size="sm">{`Active sample: ${(at ?? 0) + 1} of 5`}</Text>
              </ScrubTrack>
            )}
          </Scrub>
        </Card>
      </FormColumns>

      <FormColumns columns={2}>
        <Card title="Pick">
          <Pick keys={['item-1', 'item-2']} value={picked} onValueChange={setPicked}>
            <Row>
              <PickList ariaLabel="Pick list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                <PickOption value="item-1">Valve 1</PickOption>
                <PickOption value="item-2">Valve 2</PickOption>
              </PickList>
              <PickPane ariaLabel="Picked detail">
                <Text size="sm">{`Selected: ${picked ?? 'none'}`}</Text>
              </PickPane>
            </Row>
          </Pick>
        </Card>

        <Card title="Turns">
          <Turns keys={['req-1', 'req-2']} value={handled} onValueChange={setHandled}>
            {(state) => (
              <Stack gap="tight">
                <TurnsName>{state.current ?? 'All reviewed'}</TurnsName>
                <Row>
                  <Button
                    size="sm"
                    disabled={!state.current}
                    onClick={() => state.current && setHandled((prev) => [...prev, state.current!])}
                  >
                    Approve
                  </Button>
                  <TurnsSkip>Skip</TurnsSkip>
                </Row>
              </Stack>
            )}
          </Turns>
        </Card>
      </FormColumns>
    </Stack>
  );
}
