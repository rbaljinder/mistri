/** What builtInInputs says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  stars: '{stars} of {outOf} stars',
  pickColor: 'Pick {label}',
  jsonProblem: 'Not valid JSON: {problem}',
  formatJson: 'Format',
  scan: 'Scan',
  stopScanning: 'Stop scanning',
  cameraView: 'Camera: hold the code in view',
  cameraRefused: 'The camera could not be opened. Type the code instead.',
  signHere: 'Sign here: {label}',
  typedSignature: '{label}, typed',
  typeYourName: 'Type your full name',
  keptSignature: '{label}: the kept signature',
  undoStroke: 'Undo',
  clearSignature: 'Clear',
  typeInstead: 'Type instead',
  drawInstead: 'Draw instead',
  useSignature: 'Use this signature',
  keepingSignature: 'Keeping…',
  keepPrevious: 'Keep the previous one',
  signAgain: 'Sign again',
  removeSignature: 'Remove',
  signatureUnread: 'The signature could not be kept. Try again.',
});
