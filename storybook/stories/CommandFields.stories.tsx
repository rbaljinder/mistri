import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { AppCommandField } from '../../packages/mistri/src/shared/command.js';
import { blankCommandValues, CommandFields } from '../../packages/mistri/src/client/components/CommandFields.js';
import { applicationFixture } from '../mocks/core.js';

const fields: AppCommandField[] = [
  {
    name: 'email',
    label: 'Work email',
    type: 'text',
    format: 'email',
    required: true,
    help: 'Use the address where you receive team updates.',
  },
  { name: 'started', label: 'Start date', type: 'date', required: true },
  {
    name: 'team',
    label: 'Team',
    type: 'choice',
    required: true,
    options: ['Design', 'Engineering', 'Operations', 'People', 'Support'].map((label) => ({ label, value: label })),
  },
];
const repeated: AppCommandField[] = [
  {
    name: 'attendees',
    label: 'Attendees',
    type: 'group',
    fields: [
      { name: 'name', label: 'Full name', type: 'text', required: true },
      { name: 'email', label: 'Email address', type: 'text', format: 'email', required: true },
    ],
    repeat: { min: 1, max: 4 },
  },
];

/* Inputs asked the way a column's format is edited: stars, a code the camera reads (its Scan button only where the
   browser reads codes), a color in the system's picker, and a time in the browser's own. */
const formatted: AppCommandField[] = [
  { name: 'score', label: 'How was the visit?', type: 'number', as: 'rating', integer: true, min: 1, max: 5, outOf: 5, required: true },
  { name: 'asset', label: 'Asset tag', type: 'text', as: 'scan', required: true, help: 'Scan the label, or type it.' },
  { name: 'shade', label: 'Paint color', type: 'text', as: 'color' },
  { name: 'arrives', label: 'Arrives at', type: 'time', min: '07:00', max: '19:00', required: true },
];

function Fields({ input = fields, invalid = false }: { input?: AppCommandField[]; invalid?: boolean }) {
  const [values, setValues] = useState(() => blankCommandValues(input));
  const [problems, setProblems] = useState<Record<string, string>>(
    invalid
      ? {
          email: 'Enter a complete work email address.',
          started: 'Choose the first day your teammate will be working.',
          team: 'Choose the team responsible for onboarding.',
        }
      : {},
  );
  return (
    <div className="command-fields" style={{ maxWidth: 520 }}>
      <CommandFields
        fields={input}
        values={values}
        idPrefix="story-command"
        identityEpoch={0}
        isCurrent={() => true}
        problems={problems}
        onChange={(next, path) => {
          setValues(next);
          setProblems((current) => ({ ...current, [path]: '' }));
        }}
      />
    </div>
  );
}
const meta = { title: 'Forms/Command fields' } satisfies Meta;
export default meta;
export const Default: StoryObj = { render: () => <Fields /> };
export const Validation: StoryObj = { render: () => <Fields invalid /> };
export const RepeatedGroup: StoryObj = { render: () => <Fields input={repeated} /> };
/* The built-in inputs arrive through the App's input slot, which an App's shell installs. */
export const FormatInputs: StoryObj = {
  beforeEach: async () => {
    await applicationFixture({ tables: [], app: { id: 'visits', name: 'Visits', ui: {}, nav: [], views: {}, resources: {} } });
  },
  render: () => <Fields input={formatted} />,
};
