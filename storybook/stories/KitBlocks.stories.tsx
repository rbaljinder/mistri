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
  Empty,
  Item,
  Items,
  Meter,
  Segmented,
  Stack,
  Stat,
  Table,
  Tone,
  Value,
} from '../../packages/mistri/src/client/components/sdk/kit.js';

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
  <Items label="Open work" empty={<span>Nothing open.</span>}>
    <Item
      lead={<Tone tone="warn">Late</Tone>}
      title="Call Ana Ruiz about the renewal"
      note="Due yesterday. She asked for a quote with the longer term and the two extra seats, so it needs the new price list."
      onClick={() => undefined}
      action={
        <Button intent="quiet" size="compact">
          Done
        </Button>
      }
    />
    <Item
      lead={<Tone tone="good">On time</Tone>}
      title="Send the signed lease"
      note="Due Friday"
      href="#lease"
      action={<Value value={1250} display={{ format: 'money', currency: 'USD' }} compact />}
    />
    <Item title="Order more keys" />
  </Items>
);

export const ItemsList: StoryObj = { render: () => frame(720, <Work />) };
export const ItemsPhone: StoryObj = { render: () => frame(360, <Work />) };
export const ItemsEmpty: StoryObj = { render: () => frame(480, <Items label="Open work" empty={<Empty title="Nothing open." />} />) };

export const CardHeader: StoryObj = {
  render: () =>
    frame(
      720,
      <Cluster min="20rem">
        <Card
          title="Open work"
          count={3}
          action={
            <Button intent="quiet" size="compact">
              Add
            </Button>
          }
        >
          <Work />
        </Card>
        <Card title="Quiet" count={0}>
          <Items label="None" empty="Nothing here." />
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
          <Button intent="quiet" size="compact">
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
          <Stat label="Open" value="12" />
          <Stat label="Late" value="3" change={{ text: '↑ 2 vs last week', tone: 'bad' }} />
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
        <Button intent="quiet" size="compact">
          Open
        </Button>
      }
    >
      <Stack>
        <Segmented
          label="Range"
          value={range}
          onChange={setRange}
          options={[
            { value: '7', label: '7 d' },
            { value: '30', label: '30 d', count: 4 },
          ]}
        />
        <Cluster min="9rem">
          <Stat label="Leads" value="128" change={{ text: '↑ 12% vs prior', tone: 'good' }} trend={[3, 5, 4, 8, 7, 9]} />
          <Stat label="Overdue" value="9" change={{ text: '↑ 3 vs prior', tone: 'bad' }} />
        </Cluster>
        <Meter value={64} label="64%" tone="good" />
        <Value value="open" display={{ tone: { open: 'info' } }} />
        <Work />
        <Table
          label="Leads"
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
        <Empty title="Nothing else here." />
      </Stack>
    </Card>
  );
}
export const NavGround: StoryObj = { render: () => frame(720, <Dark />) };
export const NavGroundPhone: StoryObj = { render: () => frame(360, <Dark />) };
