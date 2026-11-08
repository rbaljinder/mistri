/** What sdk/steps says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  stepNamed: 'Step {step} of {count}: {label}',
  refusedOnStep: '{problem} Step {step} of {count}: {label}.',
  done: '{label}: done.',
  notSent: 'Nothing was sent.',
  noSuchInput: '<Steps command="{command}"> names "{name}", which is not one of its inputs: each step names inputs the command declares.',
  noSteps: '<Steps command="{command}"> has no steps: give it at least one, each naming the inputs it asks.',
});
