/** Runtime gallery page for display, typography, feedback, navigation, and reduced-motion targets (`/gallery-display`). */
import { Card, Stack, definePage, useState } from '@mistriwork/mistri/page';
import {
  AiBadge,
  Alert,
  Avatar,
  AvatarGroup,
  Badge,
  Beside,
  Breadcrumbs,
  Cluster,
  Code,
  DescriptionList,
  EmptyState,
  FormattedValue,
  Heading,
  ItemList,
  ItemRow,
  JsonView,
  Kbd,
  Meter,
  Pagination,
  Person,
  PhotoTiles,
  Row,
  SegmentedControl,
  Skeleton,
  SkeletonCard,
  StatCard,
  StatusDot,
  Tabs,
  Text,
} from '@mistriwork/mistri/primitives';
import { AiAssistantPanel } from '@mistriwork/mistri/views';

export default definePage({
  label: 'Gallery display',
  nav: false,
  reads: ['deal'],
  component: GalleryDisplay,
});

function GalleryDisplay() {
  const [segment, setSegment] = useState<'all' | 'open' | 'won'>('open');
  const [pageIndex, setPageIndex] = useState(2);

  return (
    <Stack>
      <Card title="Motion-sensitive live status indicators">
        <Row>
          <StatusDot tone="good" pulse>
            Telemetry online
          </StatusDot>
          <AiBadge>Suggested</AiBadge>
          <AiBadge quiet>Suggested</AiBadge>
        </Row>
        <Meter label="Background sync" value={45} indeterminate />
        <AiAssistantPanel
          title="Dispatch assistant"
          isGenerating
          messages={[
            { id: 'm1', role: 'user', content: 'Summarize open pump inspections.' },
            { id: 'm2', role: 'assistant', content: 'Checking active work orders across Zone North…', streaming: true },
          ]}
        />
      </Card>

      <Card title="Typography, badges, avatars, and truncation">
        <Breadcrumbs
          ariaLabel="Facility path"
          items={[
            { label: 'Operations', href: '/parts' },
            { label: 'North Campus', href: '/parts' },
            { label: 'Boiler House Inspection Schedule' },
          ]}
        />
        <Heading level={3}>Quarterly reliability summary</Heading>
        <Text muted size="sm">
          Press <Kbd>T</Kbd> to jump to today or filter by <Code>stage = won</Code>.
        </Text>
        <Row>
          <Badge tone="neutral">Neutral</Badge>
          <Badge tone="info">Info</Badge>
          <Badge tone="good">Good</Badge>
          <Badge tone="warning">Warning</Badge>
          <Badge tone="critical">Critical</Badge>
          <Badge tone="accent">Accent</Badge>
        </Row>
        <Row>
          <Avatar name="Ana Ruiz" status="online" />
          <AvatarGroup items={[{ name: 'Ana Ruiz' }, { name: 'Ben Okafor' }, { name: 'Cy Marlow' }, { name: 'Devon Patel' }]} max={3} />
          <Person
            name="Alexandrina-Bartholomew-Featherstonehaugh-Worcestershire-Smythe"
            secondary="Principal Reliability Engineer · North Sector"
          />
        </Row>
      </Card>

      <Cluster min="15rem">
        <StatCard
          label="Completed visits"
          value="1,284"
          delta={{ value: '+8.4%', tone: 'good', against: 'vs last month' }}
          trend={[18, 22, 21, 26, 29, 34]}
        />
        <StatCard
          label="Exact ledger sequence"
          value={<FormattedValue value="9007199254740993" format="number" />}
          delta={{ value: '0.0%', tone: 'neutral' }}
        />
        <StatCard
          label="Archive volume"
          value={<FormattedValue value={9007199254740992} format="bytes" />}
          delta={{ value: '+1.2%', tone: 'info' }}
        />
      </Cluster>

      <Beside
        rail={
          <Card title="Loading & feedback">
            <Alert tone="warning" title="Calibration due" description="Torque wrench #14 expires in 3 days." />
            <Skeleton height={20} />
            <SkeletonCard lines={2} showAvatar />
            <EmptyState title="No overdue calibrations" description="Every assigned tool is within spec." />
          </Card>
        }
      >
        <Card title="Structured items, tabs, JSON, and media">
          <SegmentedControl
            ariaLabel="Deal filter"
            value={segment}
            onValueChange={setSegment}
            options={[
              { value: 'all', label: 'All', count: 10 },
              { value: 'open', label: 'Open', count: 6 },
              { value: 'won', label: 'Won', count: 4 },
            ]}
          />
          <Tabs
            ariaLabel="Inspection sections"
            items={[
              {
                value: 'details',
                label: 'Details',
                count: 4,
                content: (
                  <DescriptionList
                    columns={2}
                    items={[
                      { label: 'Asset ID', value: 'PUMP-9007199254740993' },
                      { label: 'Location', value: 'North Boiler House' },
                      { label: 'Interval', value: '90 days' },
                      { label: 'Status', value: 'Operational' },
                    ]}
                  />
                ),
              },
              {
                value: 'tasks',
                label: 'Checklist',
                count: 12,
                content: (
                  <ItemList ariaLabel="Checklist rows">
                    <ItemRow title="Isolate feed valve" description="Verify zero line pressure" tone="good" />
                    <ItemRow title="Inspect mechanical seal" description="Record runout in mm" tone="info" />
                  </ItemList>
                ),
              },
            ]}
          />
          <JsonView
            ariaLabel="Diagnostic payload"
            data={{
              traceId: 'trc_9007199254740993_extremely_long_unbroken_identifier_segment_for_card_wrap_verification_0123456789',
              readings: [-5, 0, 10],
            }}
          />
          <PhotoTiles
            tiles={[
              { src: '', alt: 'Placeholder empty address guard' },
              {
                src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="%23cbd5e1"/></svg>',
                alt: 'Pump housing',
              },
            ]}
          />
          <Pagination page={pageIndex} pages={6} onPageChange={setPageIndex} />
        </Card>
      </Beside>
    </Stack>
  );
}
