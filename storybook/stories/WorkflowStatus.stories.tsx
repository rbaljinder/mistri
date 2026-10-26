import type { ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { WorkflowStatus } from '../../packages/kit/src/client/components/WorkflowStatus.js';

const definition = {
  steps: [
    { value: 'submitted', label: 'Submitted' },
    { value: 'review', label: 'In review' },
    { value: 'approved', label: 'Approved' },
    { value: 'issued', label: 'Issued' },
  ],
} as ComponentProps<typeof WorkflowStatus>['definition'];

const meta = { title: 'Records/Workflow status', component: WorkflowStatus, args: { definition } } satisfies Meta<typeof WorkflowStatus>;
export default meta;

/* An ordered workflow: the step passed is filled, the steps ahead hollow, a line between them. */
export const InReview: StoryObj<typeof meta> = { args: { value: 'review', definition: { ...definition, ordered: true } } };
/* A state the workflow does not name is said plainly, never guessed at. */
export const UnmappedState: StoryObj<typeof meta> = { args: { value: 'on_hold' } };
