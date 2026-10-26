/*
 * The door fixture's commands, its human check and its `--commands` entry.
 * Server-only.
 *
 * The human check is Turnstile's local stand-in, started in this process: its
 * widget hands the form a fresh token of the person's on each render and reset,
 * its siteverify says yes to each once, and no call leaves the machine. The
 * lobby page passes a token of its own (`lobby-person`), and a spec posting by
 * hand uses `spec-person`; both were issued on 127.0.0.1, the door's host.
 */
import {
  defineChallenges,
  defineCommand,
  defineCommands,
  defineSource,
  field,
  publicReference,
  publicReferencePattern,
  shape,
  text,
} from '@mistriwork/mistri/commands';
import { turnstile, turnstileStub } from '../../../../packs/challenge-turnstile/src/index.ts';

const shop = defineSource('shop');

const stub = await turnstileStub({ people: ['person', 'lobby-person', 'spec-person'], hostname: '127.0.0.1' });
export const challenges = defineChallenges({
  verifyHuman: turnstile({ siteKey: 'door-site-key', secret: 'stub-secret', verifyUrl: stub.verifyUrl, scriptUrl: stub.scriptUrl }),
});

export const ask = defineCommand({
  source: shop,
  target: 'inquiry',
  targets: 'none',
  public: true,
  read: ['make'],
  write: ['inquiry'],
  input: {
    make: field.choice({ from: 'make', label: 'name' }),
    color: field.text({ max: 20, label: 'Color' }),
  },
  output: shape({ reference: text({ pattern: publicReferencePattern('ASK') }) }),
  async handle({ db, now }, input) {
    const reference = publicReference('ASK');
    await db.inquiry.insert({ reference, make_id: input.make, color: input.color, received_at: now().toISOString() });
    return { reference };
  },
});

export const enrol = defineCommand({
  source: shop,
  target: 'enrolment',
  targets: 'none',
  public: true,
  read: ['make'],
  write: ['enrolment'],
  // The page draws its own select of the makes, from the rows served with this command (useCommand(...).choices).
  input: { name: field.text({ max: 40 }), make: field.choice({ from: 'make', label: 'name' }) },
  output: shape({ reference: text({ pattern: publicReferencePattern('ENR') }) }),
  async handle({ db }, input) {
    const reference = publicReference('ENR');
    await db.enrolment.insert({ name: input.name, make_id: input.make, reference });
    return { reference };
  },
});

export default defineCommands({ ask, enrol });
