import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fixtureHost, SectionFrame } from '../../packages/mistri/src/client/components/sdk/fixture.js';
import { fixtures } from '../../packages/mistri/src/client/components/sdk/testing.js';
import '../../packages/mistri/src/client/components/sdk/kit.css';
import {
  Beside,
  Button,
  Card,
  Cluster,
  EmptyState,
  ItemRow,
  ItemList,
  Meter,
  SegmentedControl,
  Stack,
  StatCard,
  Table,
  StatusDot,
  Value,
} from '../../packages/mistri/src/client/components/sdk/index.js';

/* The page kit's row list, header row, main-beside-rail and nav-ground scope, drawn by the SDK's fixture host as an
   App's page draws them, so the visual matrix sees each in every look, light and dark, at a desk and a phone's width. */
const meta = { title: 'Kit/Blocks', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;

const frame = (width: number, children: React.ReactNode) => (
  <SectionFrame host={fixtureHost(fixtures({}), {}, [])} id="kit-blocks" width={width}>
    {children}
  </SectionFrame>
);

const Work = () => (
  <ItemList ariaLabel="Open work" empty={<span>Nothing open.</span>}>
    <ItemRow
      leading={<StatusDot tone="warning">Late</StatusDot>}
      title="Call Ana Ruiz about the renewal"
      description="Due yesterday. She asked for a quote with the longer term and the two extra seats, so it needs the new price list."
      onClick={() => undefined}
      actions={
        <Button variant="ghost" size="sm">
          Done
        </Button>
      }
    />
    <ItemRow
      leading={<StatusDot tone="good">On time</StatusDot>}
      title="Send the signed lease"
      description="Due Friday"
      href="#lease"
      actions={<Value value={1250} display={{ format: 'money', currency: 'USD' }} compact />}
    />
    <ItemRow title="Order more keys" />
  </ItemList>
);

export const ItemsList: StoryObj = { render: () => frame(720, <Work />) };
export const ItemsPhone: StoryObj = { render: () => frame(360, <Work />) };
export const ItemsEmpty: StoryObj = {
  render: () => frame(480, <ItemList ariaLabel="Open work" empty={<EmptyState title="Nothing open." />} />),
};

export const CardHeader: StoryObj = {
  render: () =>
    frame(
      720,
      <Cluster min="20rem">
        <Card
          title="Open work"
          count={3}
          action={
            <Button variant="ghost" size="sm">
              Add
            </Button>
          }
        >
          <Work />
        </Card>
        <Card title="Quiet" count={0}>
          <ItemList ariaLabel="None" empty="Nothing here." />
        </Card>
      </Cluster>,
    ),
};
export const CardHeaderPhone: StoryObj = {
  render: () =>
    frame(
      360,
      <Card
        title="A long title that wraps on a phone"
        count={12}
        action={
          <Button variant="ghost" size="sm">
            Add
          </Button>
        }
      >
        <Work />
      </Card>,
    ),
};

const Page = ({ side }: { side: 'start' | 'end' }) => (
  <Beside
    side={side}
    rail={
      <Card title="Facts">
        <Stack gap="tight">
          <StatCard label="Open" value="12" />
          <StatCard label="Late" value="3" delta={{ value: '↑ 2', tone: 'critical', against: 'vs last week' }} />
        </Stack>
      </Card>
    }
  >
    <Card title="Work" count={3}>
      <Work />
    </Card>
  </Beside>
);
export const BesideRail: StoryObj = { render: () => frame(960, <Page side="end" />) };
export const BesideRailStart: StoryObj = { render: () => frame(960, <Page side="start" />) };
export const BesideStacked: StoryObj = { render: () => frame(360, <Page side="end" />) };

function Dark() {
  const [range, setRange] = useState('30');
  return (
    <Card
      ground="nav"
      title="On the nav ground"
      count={4}
      action={
        <Button variant="ghost" size="sm">
          Open
        </Button>
      }
    >
      <Stack>
        <SegmentedControl
          ariaLabel="Range"
          value={range}
          onValueChange={setRange}
          options={[
            { value: '7', label: '7 d' },
            { value: '30', label: '30 d', count: 4 },
          ]}
        />
        <Cluster min="9rem">
          <StatCard label="Leads" value="128" delta={{ value: '↑ 12%', tone: 'good', against: 'vs prior' }} trend={[3, 5, 4, 8, 7, 9]} />
          <StatCard label="Overdue" value="9" delta={{ value: '↑ 3', tone: 'critical', against: 'vs prior' }} />
        </Cluster>
        <Meter value={64} label="64%" tone="good" />
        <Value value="open" display={{ tone: { open: 'info' } }} />
        <Work />
        <Table
          ariaLabel="Leads"
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'total', label: 'Total', align: 'right', display: { format: 'money', currency: 'USD' } },
          ]}
          rows={[
            { id: 1, name: 'Ana Ruiz', total: 1250 },
            { id: 2, name: 'Morgan Lee', total: 480 },
          ]}
          onRowClick={() => undefined}
        />
        <EmptyState title="Nothing else here." />
      </Stack>
    </Card>
  );
}
export const NavGround: StoryObj = { render: () => frame(720, <Dark />) };
export const NavGroundPhone: StoryObj = { render: () => frame(360, <Dark />) };
