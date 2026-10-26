import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { AppCommandField } from '../../shared/command.js';
import { CommandLive, liveFigures } from './CommandLive.js';

const gross = {
  name: 'biweekly_gross',
  label: 'Biweekly gross',
  type: 'money',
  live: { monthly: 'biweekly_gross * 26 / 12', annually: 'biweekly_gross * 26' },
} as AppCommandField & { type: 'money' };

test('live lines are worked out over the answers, in the field format, and say nothing until their numbers are given', () => {
  expect(liveFigures(gross, [gross], {})).toEqual([]);
  expect(liveFigures(gross, [gross], { biweekly_gross: '25,000' })).toEqual([
    ['monthly', (25_000 * 26) / 12],
    ['annually', 650_000],
  ]);
  render(<CommandLive field={gross} fields={[gross]} values={{ biweekly_gross: '25000' }} id="l" />);
  expect(screen.getByText(/monthly/).closest('p')).toHaveTextContent('$54,167 monthly · $650,000 annually');
});
