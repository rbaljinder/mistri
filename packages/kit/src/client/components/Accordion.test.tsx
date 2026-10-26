/**
 * The accordion: real disclosure buttons over the regions they open, open
 * and shut at once, and the arrow keys moving between one group's buttons.
 */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Accordion, AccordionItem } from './Accordion.js';

afterEach(cleanup);

function draw() {
  return render(
    <Accordion label="Specification">
      <AccordionItem title="Engine" defaultOpen>
        1.8 Hybrid
      </AccordionItem>
      <AccordionItem title="Dimensions">4.37 m long</AccordionItem>
      <AccordionItem title="Equipment">Heated seats</AccordionItem>
    </Accordion>,
  );
}

test('each title is a button that says whether its region is open, and names the region it controls', () => {
  draw();
  const engine = screen.getByRole('button', { name: 'Engine' });
  const dimensions = screen.getByRole('button', { name: 'Dimensions' });
  expect(engine).toHaveAttribute('aria-expanded', 'true');
  expect(dimensions).toHaveAttribute('aria-expanded', 'false');
  const region = screen.getByRole('region', { name: 'Engine' });
  expect(engine.getAttribute('aria-controls')).toBe(region.id);
  expect(region).toHaveTextContent('1.8 Hybrid');
  // A shut region is out of the page and out of the accessibility tree.
  expect(screen.queryByRole('region', { name: 'Dimensions' })).toBeNull();
  expect(screen.getByText('4.37 m long').closest('[role=region]')).toHaveAttribute('hidden');
  // The button sits in a heading, so the outline reads the titles.
  expect(screen.getByRole('heading', { level: 3, name: 'Engine' })).toBeInTheDocument();
});

test('a press opens and shuts its own region, and leaves the others as they were', async () => {
  draw();
  const user = userEvent.setup();
  const dimensions = screen.getByRole('button', { name: 'Dimensions' });
  await user.click(dimensions);
  expect(dimensions).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('region', { name: 'Dimensions' })).toHaveTextContent('4.37 m long');
  expect(screen.getByRole('button', { name: 'Engine' })).toHaveAttribute('aria-expanded', 'true');
  await user.click(screen.getByRole('button', { name: 'Engine' }));
  expect(screen.getByRole('button', { name: 'Engine' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'Engine' })).toBeNull();
});

test("Enter and Space work the button, and the arrows, Home and End move between the group's buttons", async () => {
  draw();
  const user = userEvent.setup();
  const [engine, dimensions, equipment] = ['Engine', 'Dimensions', 'Equipment'].map((name) => screen.getByRole('button', { name }));
  engine.focus();
  await user.keyboard('{ArrowDown}');
  expect(dimensions).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(dimensions).toHaveAttribute('aria-expanded', 'true');
  await user.keyboard(' ');
  expect(dimensions).toHaveAttribute('aria-expanded', 'false');
  await user.keyboard('{End}');
  expect(equipment).toHaveFocus();
  await user.keyboard('{ArrowDown}');
  expect(engine).toHaveFocus();
  await user.keyboard('{ArrowUp}');
  expect(equipment).toHaveFocus();
  await user.keyboard('{Home}');
  expect(engine).toHaveFocus();
});

test('an item on its own is still a working disclosure at the heading level it is given', async () => {
  render(
    <AccordionItem title="Features" level={2}>
      Tow bar
    </AccordionItem>,
  );
  const button = screen.getByRole('button', { name: 'Features' });
  expect(screen.getByRole('heading', { level: 2, name: 'Features' })).toBeInTheDocument();
  expect(button).toHaveAttribute('aria-expanded', 'false');
  await userEvent.setup().click(button);
  expect(screen.getByRole('region', { name: 'Features' })).toHaveTextContent('Tow bar');
});
