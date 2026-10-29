/**
 * Where a password-reset link may be written. With no mail transport the only other delivery is the log
 * (`MISTRI_AUTH_RESET=log`), and a live token in a log is a sign-in for whoever reads it: so the link is printed
 * under `mistri dev` alone, and a served App writes one line that names neither the link nor the address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appAuthProviders } from '../packages/mistri/src/server/auth/authProviders.js';
import { RESET_WITHOUT_MAIL_WARNING } from '../packages/engine/src/server/startupWarnings.js';

const spec = { providers: ['email'], signUp: 'closed' } as unknown as Parameters<typeof appAuthProviders>[0];
const url = 'http://127.0.0.1:1/api/auth/reset-password/SECRET-TOKEN?callbackURL=/';

async function ask(development: boolean, mail?: Parameters<typeof appAuthProviders>[3]) {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    const { emailAndPassword } = appAuthProviders(spec, { MISTRI_AUTH_RESET: 'log' }, 'test', mail, development);
    await (emailAndPassword as { sendResetPassword: (a: unknown) => Promise<void> }).sendResetPassword({
      user: { email: 'ada@example.org' },
      url,
    });
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

test('under dev the reset link is written to the log', async () => {
  const lines = await ask(true);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('SECRET-TOKEN'));
});

test('served, with no mail, one line says a reset was asked and carries no link, token or address', async () => {
  const lines = await ask(false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /password reset was requested but no mail transport is configured/);
  assert.doesNotMatch(lines[0], /SECRET-TOKEN|http|ada@example\.org/);
});

test('with mail the link is sent, and nothing is logged in either mode', async () => {
  for (const development of [true, false]) {
    const sent: string[] = [];
    const lines = await ask(development, {
      app: 'Desk',
      send: async (message: { text?: string }) => void sent.push(message.text ?? ''),
    } as never);
    assert.deepEqual(lines, []);
    assert.ok(sent[0].includes('SECRET-TOKEN'));
  }
});

test('the startup warning says the offer cannot be kept and what to do', () => {
  assert.match(RESET_WITHOUT_MAIL_WARNING, /no email service is configured/);
  assert.match(RESET_WITHOUT_MAIL_WARNING, /never written to the log outside `mistri dev`/);
});
