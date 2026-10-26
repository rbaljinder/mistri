import type { Meta, StoryObj } from '@storybook/react-vite';
import { Accordion, AccordionItem } from '../../packages/kit/src/client/components/Accordion.js';

const facts = (pairs: Array<[string, string]>) => (
  <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 24px', margin: 0 }}>
    {pairs.map(([term, value]) => [
      <dt key={`${term}-t`} style={{ color: 'var(--ink-muted)' }}>
        {term}
      </dt>,
      <dd key={`${term}-d`} style={{ margin: 0 }}>
        {value}
      </dd>,
    ])}
  </dl>
);

function Specification() {
  return (
    <div style={{ maxWidth: 640 }}>
      <Accordion label="Specification">
        <AccordionItem title="Engine and drivetrain" defaultOpen>
          {facts([
            ['Engine', '2.0 Hybrid, 200 hp'],
            ['Gearbox', 'Automatic'],
            ['Drivetrain', 'Front-wheel drive'],
            ['0–60 mph', '7.6 s'],
          ])}
        </AccordionItem>
        <AccordionItem title="Features">
          {facts([
            ['Comfort', 'Heated seats, dual-zone climate'],
            ['Safety', 'Adaptive cruise, lane keeping'],
            ['Media', 'Wireless CarPlay and Android Auto'],
          ])}
        </AccordionItem>
        <AccordionItem title="History and inspection">
          {facts([
            ['Owners', '1'],
            ['Service history', 'Full, main dealer'],
            ['Inspection', '150 points, passed Aug 2026'],
          ])}
        </AccordionItem>
      </Accordion>
    </div>
  );
}

const meta = { title: 'Records/Accordion', component: Specification } satisfies Meta<typeof Specification>;
export default meta;

/* Opening is instant; only the chevron turns. */
export const Sections: StoryObj<typeof meta> = {};
