import type { Meta, StoryObj } from '@storybook/react-vite';
import { fixtureHost, SectionFrame } from '../../packages/mistri/src/client/components/sdk/fixture.js';
import { fixtures } from '../../packages/mistri/src/client/components/sdk/testing.js';
import '../../packages/mistri/src/client/components/sdk/kit.css';
import { Cluster, MiniBars, Sparkline, Stat, Tile } from '../../packages/mistri/src/client/components/sdk/kit.js';

/* The parts a field report asked for, drawn by the SDK's fixture host as an App's page draws them: a Stat with a delta
   and a link, a sparkline and mini bars in the look's chart ink, and tiles (a card that is one control). */
const meta = { title: 'Kit/Parts', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;

const frame = (width: number, children: React.ReactNode) => (
  <SectionFrame host={fixtureHost(fixtures({}), {}, [])} id="kit-parts" width={width}>
    {children}
  </SectionFrame>
);

const Parts = () => (
  <Cluster min="12rem">
    <Stat label="Revenue" value="$48,200" delta={{ value: 12, good: 'up' }} trend={[3, 5, 4, 8, 7, 9]} href="/revenue" />
    <Stat label="Wait" value="4 min" delta={{ value: -1, good: 'down' }} />
    <Tile selected onPress={() => undefined}>
      <Sparkline values={[2, 4, 3, 6, 5, 8]} label="Orders" />
    </Tile>
    <Tile onPress={() => undefined}>
      <MiniBars
        values={[2, 5, 3, 8, 6, 4, 7]}
        labels={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']}
        highlight={3}
        label="Orders by day"
      />
    </Tile>
    <Tile disabled>Closed</Tile>
  </Cluster>
);
export const Parts_: StoryObj = { name: 'Parts', render: () => frame(960, <Parts />) };
export const PartsPhone: StoryObj = { render: () => frame(360, <Parts />) };
