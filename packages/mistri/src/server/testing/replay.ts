/**
 * `replay`: an App's assistant answered from a cassette (assistant/assistantCassette.ts), so a test of an AI
 * command or an Ask asserts on its proposal and evidence offline and the same every run. Preview.
 */
import { resolve } from 'node:path';
import { recordingKeyMissing } from '../assistant/assistantCassette.js';

/**
 * A cassette for `startTestApp({ assistant })`.
 *
 * @preview
 */
export interface TestReplay {
  /** The cassette's absolute path. */
  readonly cassette: string;
  /** True under `MISTRI_REPLAY=record`: the real model answers and the cassette is written. */
  readonly recording: boolean;
}

/**
 * The assistant's model for a test, read from a cassette: `startTestApp({ assistant: replay('ask.cassette.json') })`.
 * Replay never reaches the network and fails a request the cassette does not hold, naming it. `MISTRI_REPLAY=record`
 * asks the operator's model instead (ANTHROPIC_API_KEY or OPENAI_API_KEY) and writes the cassette, with every key
 * and auth header redacted; without a key it throws here, before anything starts.
 *
 * @preview
 */
export function replay(cassette: string): TestReplay {
  const recording = process.env.MISTRI_REPLAY === 'record';
  if (recording) {
    const missing = recordingKeyMissing();
    if (missing) throw new Error(`replay: ${missing}`);
  }
  return Object.freeze({ cassette: resolve(cassette), recording });
}

export const isReplay = (value: unknown): value is TestReplay =>
  !!value && typeof value === 'object' && typeof (value as TestReplay).cassette === 'string';

/** What the App's process is given for a replay: the cassette, and only when recording, the key and the provider's host. */
export function replayEnvironment(replayed: TestReplay): { environment: Record<string, string>; hosts: string[] } {
  if (!replayed.recording) return { environment: { MISTRI_ASSISTANT_CASSETTE: replayed.cassette }, hosts: [] };
  const environment: Record<string, string> = { MISTRI_ASSISTANT_CASSETTE: replayed.cassette, MISTRI_REPLAY: 'record' };
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MISTRI_ASSISTANT_PROVIDER'] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return { environment, hosts: ['api.anthropic.com', 'api.openai.com'] };
}
