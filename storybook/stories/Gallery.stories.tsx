import type { Meta, StoryObj } from '@storybook/react-vite';
import { Gallery } from '../../packages/kit/src/client/components/Gallery.js';
import { photo } from './photos.js';

// In the order scripts/photos.mjs renders the angles.
const captions = ['Front three-quarter', 'Driver-side profile', 'Rear three-quarter', 'Passenger-side profile'];
const items = captions.map((caption, i) => ({ id: String(i + 1), src: photo(`gallery-${i}`), alt: caption, caption }));

const meta = {
  title: 'Records/Gallery',
  component: Gallery,
  args: { items, label: 'Photos of the 2025 Honda Civic', emptyText: 'No photos yet.' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Gallery>;
export default meta;

/* The lead opens the lightbox: Previous and Next, the arrow keys, a swipe, Escape. */
export const Photos: StoryObj<typeof meta> = {};
export const OnePhoto: StoryObj<typeof meta> = { args: { items: items.slice(0, 1) } };
export const Empty: StoryObj<typeof meta> = { args: { items: [] } };
