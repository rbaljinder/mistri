import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Segmented } from '../../packages/mistri/src/client/components/sdk/kit.js';
import { LayoutSwitch } from '../../packages/kit/src/client/components/LayoutSwitch.js';
import { PresentationSwitch } from '../../packages/kit/src/client/components/PresentationSwitch.js';

const meta = { title: 'Controls/Segmented switch', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/* Every switch beside a field-height control, in every look: the visual matrix draws this once a look, so a tray whose
   corner is not its key's, or that wears a field's edge, is seen on the look that shows it (Bloom's pills). */
function Switches() {
  const [range, setRange] = useState('30d');
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [mode, setMode] = useState('records');
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 520 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Segmented
          label="Range"
          value={range}
          onChange={setRange}
          options={[
            { value: '7d', label: '7 d' },
            { value: '30d', label: '30 d', count: 12 },
            { value: '90d', label: '90 d' },
          ]}
        />
        <input className="insert-input" aria-label="Search" placeholder="Search" style={{ width: 160 }} />
      </div>
      <Segmented
        label="Status"
        size="compact"
        value="all"
        onChange={() => {}}
        options={[
          { value: 'all', label: 'All' },
          { value: 'attention', label: 'Needs attention' },
        ]}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <LayoutSwitch layout={layout} onChange={setLayout} label="Layout" />
        <input className="insert-input" aria-label="Filter" placeholder="Filter" style={{ width: 160 }} />
      </div>
      <PresentationSwitch layout={mode} onChange={setMode} label="Read as" records="Records" table="Table" />
    </div>
  );
}

export const Switches_: Story = { name: 'Switches', render: () => <Switches /> };
