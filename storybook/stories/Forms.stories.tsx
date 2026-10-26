import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { FormSurface } from '../../packages/mistri/src/client/components/FormSurface.js';

const meta = {
  title: 'Forms/Complete form',
  component: FormSurface,
  args: {
    appName: 'Fieldwork',
    form: {
      id: 'request',
      label: 'Request equipment',
      description: 'Tell your team what you need to do your work.',
      submitLabel: 'Send request',
      input: [
        { name: 'name', label: 'Your name', type: 'text', required: true },
        {
          name: 'equipment',
          label: 'Equipment',
          type: 'choice',
          options: ['Laptop', 'Monitor', 'Keyboard'].map((label) => ({ value: label, label })),
          required: true,
        },
        { name: 'needed', label: 'Needed by', type: 'date', required: true },
        { name: 'note', label: 'Additional details', type: 'textarea' },
      ],
    },
    submit: async () => ({ reference: 'REQ-2041', receipt: { id: 'story-receipt', status: 'applied' } }),
  },
} satisfies Meta<typeof FormSurface>;
export default meta;
export const Request: StoryObj<typeof meta> = {};

/* A refusal and a slow answer only exist after a submission, so these stories
   fill the form and send it: drawn at rest they were the Request story again,
   pixel for pixel, and the matrix reviewed nothing. */
async function sendRequest(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText('Your name (required)'), 'Maya Chen');
  await userEvent.click(canvas.getByRole('radio', { name: 'Monitor' }));
  await userEvent.type(canvas.getByRole('textbox', { name: 'Needed by (required)' }), '2026-10-01');
  await userEvent.click(canvas.getByRole('button', { name: 'Send request' }));
  return canvas;
}
export const ServerRefusal: StoryObj<typeof meta> = {
  args: {
    submit: async () => {
      throw new Error('Equipment requests are temporarily unavailable. Your entries are still here.');
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = await sendRequest(canvasElement);
    await expect(await canvas.findByText(/temporarily unavailable/)).toBeVisible();
    // The refusal keeps what was typed: that is the promise the message makes.
    await expect(canvas.getByLabelText('Your name (required)')).toHaveValue('Maya Chen');
  },
};
export const LongCopy: StoryObj<typeof meta> = {
  args: {
    form: {
      ...meta.args.form,
      label: 'Request equipment for your home office or shared workspace',
      description:
        'Your workplace team will review availability and confirm the delivery details. Required fields are marked; add a note only if there is something else they should know.',
    },
  },
};
export const GuidedRequest: StoryObj<typeof meta> = {
  args: {
    form: {
      ...meta.args.form,
      steps: [
        { id: 'person', label: 'Your details', fields: ['name'] },
        { id: 'equipment', label: 'Equipment and timing', fields: ['equipment', 'needed'] },
        { id: 'context', label: 'Additional context', fields: ['note'] },
      ],
    },
  },
};
/* Long enough that a capture always lands while it is still sending; the
   story is about the wait, not what follows it. */
export const SlowSubmission: StoryObj<typeof meta> = {
  args: {
    submit: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return { reference: 'REQ-2041', receipt: { id: 'story-receipt', status: 'applied' } };
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = await sendRequest(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Submitting…' })).toHaveAttribute('aria-disabled', 'true');
  },
};
