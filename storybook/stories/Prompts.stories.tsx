import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConfirmDialog, PromptDialog, RangeDialog } from '../../packages/kit/src/client/components/Prompt.js';

const meta = { title: 'Dialogs/Questions' } satisfies Meta;
export default meta;
function Question({ kind }: { kind: 'text' | 'note' | 'date' | 'range' | 'confirm' }) {
  const [open, setOpen] = useState(true);
  const [answer, setAnswer] = useState('');
  const done = (value: unknown) => {
    setOpen(false);
    setAnswer(value === null || value === false ? 'Cancelled' : 'Saved');
  };
  return (
    <>
      <button onClick={() => setOpen(true)}>Open question</button>
      <p role="status">{answer}</p>
      {open &&
        (kind === 'confirm' ? (
          <ConfirmDialog
            title="Archive this project?"
            body="The project stays available in the archive. You can restore it later."
            confirmLabel="Archive project"
            onDone={done}
          />
        ) : kind === 'range' ? (
          <RangeDialog title="Choose a reporting period" fromLabel="Starts on" toLabel="Ends on" type="date" onDone={done} />
        ) : (
          <PromptDialog
            title={kind === 'note' ? 'Add a handover note' : kind === 'date' ? 'Choose a due date' : 'Rename project'}
            label={kind === 'note' ? 'Note' : kind === 'date' ? 'Due date' : 'Project name'}
            multiline={kind === 'note'}
            type={kind === 'date' ? 'date' : 'text'}
            value={kind === 'text' ? 'Customer onboarding' : ''}
            onDone={done}
          />
        ))}
    </>
  );
}
export const Rename: StoryObj = { render: () => <Question kind="text" /> };
export const Note: StoryObj = { render: () => <Question kind="note" /> };
export const DueDate: StoryObj = { render: () => <Question kind="date" /> };
export const DateRange: StoryObj = { render: () => <Question kind="range" /> };
export const Confirmation: StoryObj = { render: () => <Question kind="confirm" /> };
