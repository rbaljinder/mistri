/* The field's behaviour is @mistriwork/ui's (packages/ui/src/DateField.test.tsx); here, what the kit lends it. */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setMessageLanguage } from '../messages.js';
import { DateField } from './DateField.js';

afterEach(async () => {
  cleanup();
  await setMessageLanguage('en');
});

test("the field says the catalog's words and draws the kit's calendar icon", async () => {
  render(<DateField id="due" ariaLabel="Due" value="2026-09-13" onValueChange={() => {}} locale="en-US" />);
  const trigger = screen.getByRole('button', { name: 'Choose date for Due' });
  expect(trigger.querySelector('svg.mistri-icon path')).not.toBeNull();
  expect(screen.getByRole('textbox', { name: 'Due' })).toHaveAccessibleDescription(
    'Date format: MM/DD/YYYY. Alt and Down arrow opens the calendar.',
  );
  await userEvent.setup().click(trigger);
  expect(await screen.findByRole('dialog', { name: 'Calendar for Due' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previous month' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
});

test('the field speaks Spanish when the catalog language is Spanish', async () => {
  await setMessageLanguage('es');
  render(<DateField id="fecha" ariaLabel="Fecha de nacimiento" value="2026-09-13" onValueChange={() => {}} locale="es-MX" />);
  const trigger = screen.getByRole('button', { name: 'Elegir fecha para Fecha de nacimiento' });
  expect(screen.getByRole('textbox', { name: 'Fecha de nacimiento' })).toHaveAccessibleDescription(
    'Formato de fecha: DD/MM/YYYY. Alt y flecha abajo abren el calendario.',
  );
  await userEvent.setup().click(trigger);
  expect(await screen.findByRole('dialog', { name: 'Calendario para Fecha de nacimiento' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Mes anterior' })).toBeInTheDocument();
});
