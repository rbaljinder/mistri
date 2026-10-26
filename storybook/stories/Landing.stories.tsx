import type { ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { AppLanding } from '../../packages/mistri/src/shared/appModel.js';
import { LandingSurface } from '../../packages/kit/src/client/components/LandingSurface.js';
import { photo } from './photos.js';

type Host = ComponentProps<typeof LandingSurface>;

/* Forecourt's front page, without its live cards and search: those read the
   App's own rows, which a story does not have. */
const landing: AppLanding = {
  label: 'Forecourt',
  hero: {
    heading: 'Find a car you will love driving',
    description: 'Sixty used cars from six independent dealers, each photographed in the studio, inspected and priced up front.',
    actions: [
      { label: 'Browse all vehicles', view: 'vehicles' },
      { label: 'Ask a dealer', view: 'inquire', kind: 'secondary' },
    ],
    image: { from: 'site_image', key: 1, alt: 'Three cars side by side in a photo studio' },
    layout: 'overlay',
    highlights: ['60 cars', '6 independent dealers', 'Every car inspected'],
  },
  sections: [
    {
      kind: 'features',
      title: 'Why buy here',
      items: [
        { title: 'Priced up front', description: 'The price on the card is the price. No admin fee at the end.' },
        { title: 'Inspected', description: 'Every car passes a 150-point check before it is listed.' },
        { title: 'Independent dealers', description: 'Six local dealers, each answering their own inquiries.' },
      ],
    },
    {
      kind: 'faq',
      title: 'Questions',
      items: [
        { question: 'Can I reserve a car?', answer: 'Send an inquiry and the dealer holds it for 48 hours while you set up a test drive.' },
        { question: 'Do you take trade-ins?', answer: 'Most dealers do; say what you are driving in your inquiry.' },
      ],
    },
  ],
  footer: { text: 'Forecourt is a sample App. The dealers are made up; the makes are real.' },
};

const meta = {
  title: 'Public site/Landing',
  component: LandingSurface,
  args: {
    landing,
    app: { id: 'forecourt', name: 'Forecourt' },
    imageSrc: () => photo('scene'),
    openView: ((view: string) => ({ href: `/forecourt/${view}` })) as Host['openView'],
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof LandingSurface>;
export default meta;

/* The photo behind the words under a scrim; on a phone it sits above them. */
export const HeroOverlay: StoryObj<typeof meta> = {};
/* The words beside the photo. */
export const HeroSplit: StoryObj<typeof meta> = { args: { landing: { ...landing, hero: { ...landing.hero, layout: 'split' } } } };
/* No photo: the plain hero every App's landing starts from. */
export const HeroWithoutPhoto: StoryObj<typeof meta> = {
  args: { landing: { ...landing, hero: { ...landing.hero, image: undefined, layout: undefined } } },
};
