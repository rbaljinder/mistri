import '@mistriwork/ui/hero.css';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge, IconRows, PhotoTiles } from '@mistriwork/ui/HeroBlocks.js';

/* The landing hero's blocks (Preview): props only, so each story is the block with words, icons and images written
   here. Photos are small drawn pictures: the blocks size their box before any picture arrives, whatever it is. */
const meta = { title: 'Hero blocks', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const swatch = (hue: number, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="hsl(${hue} 45% 62%)"/><circle cx="300" cy="90" r="46" fill="hsl(${hue} 60% 85%)"/><path d="M0 300 L120 150 L220 250 L290 190 L400 300Z" fill="hsl(${hue} 40% 38%)"/><title>${label}</title></svg>`,
  )}`;
const tile = (n: number) => ({ src: swatch(n * 70, `Tile ${n}`), alt: `A sample picture, number ${n}` });
/* A plain drawn mark stands in for an App icon, which the kit registers and this package does not know. */
const Dot = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="8" cy="8" r="6" />
    <path d="M5.5 8.2l1.8 1.8 3.2-3.6" />
  </svg>
);
const frame = { maxWidth: 480 } as const;

export const ABadge: Story = {
  name: 'Badge',
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--space-5)', maxWidth: 480 }}>
      <Badge icon={<Dot size={14} />}>Licensed and insured</Badge>
      <Badge>Now booking spring visits</Badge>
      <h1 style={{ margin: 0 }}>A heading under its badge</h1>
    </div>
  ),
};

export const TwoTiles: Story = {
  name: 'Photo tiles, two',
  render: () => (
    <div style={frame}>
      <PhotoTiles tiles={[1, 2].map(tile)} />
    </div>
  ),
};
export const ThreeTiles: Story = {
  name: 'Photo tiles, three',
  render: () => (
    <div style={frame}>
      <PhotoTiles tiles={[1, 2, 3].map(tile)} />
    </div>
  ),
};
export const FourTiles: Story = {
  name: 'Photo tiles, four',
  render: () => (
    <div style={frame}>
      <PhotoTiles tiles={[1, 2, 3, 4].map(tile)} />
    </div>
  ),
};

export const Rows: Story = {
  name: 'Icon rows',
  render: () => (
    <div style={frame}>
      <IconRows
        rows={[
          { icon: <Dot size={18} />, text: 'Every job is covered by a written guarantee.' },
          { icon: <Dot size={18} />, text: 'Same-week appointments, most weeks.' },
          { icon: <Dot size={18} />, text: 'Serving the whole county.' },
          { icon: <Dot size={18} />, text: 'A person answers the phone.' },
        ]}
      />
    </div>
  ),
};
