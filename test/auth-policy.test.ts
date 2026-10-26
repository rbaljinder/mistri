import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appAuthProviders, passwordResetDelivery } from '../packages/mistri/src/server/auth/authProviders.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const credentials = {
  GITHUB_CLIENT_ID: 'github-id',
  GITHUB_CLIENT_SECRET: 'github-secret',
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
};
const auth = (spec: object) =>
  parseAppConfig(
    { name: 'Atlas', auth: spec, resources: { service: {} }, views: { services: { kind: 'list', from: 'service' } }, home: 'services' },
    'app.ts',
  ).auth!;

test('invite-only blocks account creation for every configured provider', () => {
  const options = appAuthProviders(auth({ providers: ['email', 'github', 'google'] }), credentials, 'app.ts');
  assert.deepEqual(options.emailAndPassword, { enabled: true, disableSignUp: true });
  assert.equal(options.socialProviders.github.disableSignUp, true);
  assert.equal(options.socialProviders.google.disableSignUp, true);
  assert.equal(options.socialProviders.github.clientId, credentials.GITHUB_CLIENT_ID);
});

test('open signup is explicit and does not enable unconfigured email sign-in', () => {
  const options = appAuthProviders(auth({ providers: ['github'], signUp: 'open' }), credentials, 'app.ts');
  assert.deepEqual(options.emailAndPassword, { enabled: false, disableSignUp: false });
  assert.equal(options.socialProviders.github.disableSignUp, false);
  assert.equal(options.socialProviders.google, undefined);
});

test('missing OAuth settings fail without echoing another credential', () => {
  assert.throws(
    () => appAuthProviders(auth({ providers: ['github'] }), { GITHUB_CLIENT_ID: 'private-client-id' }, 'app.ts'),
    (error) => {
      assert.match((error as Error).message, /GITHUB_CLIENT_SECRET/);
      assert.doesNotMatch((error as Error).message, /private-client-id/);
      return true;
    },
  );
});

test("a password reset link is delivered only when asked for, to the log or by the server's email", () => {
  const email = auth({ providers: ['email'] });
  assert.equal(passwordResetDelivery(email, {}, 'app.ts'), undefined);
  assert.equal('sendResetPassword' in appAuthProviders(email, {}, 'app.ts').emailAndPassword, false);
  const logged = appAuthProviders(email, { MISTRI_AUTH_RESET: 'log' }, 'app.ts').emailAndPassword as Record<string, unknown>;
  assert.equal(typeof logged.sendResetPassword, 'function');
  assert.equal(logged.revokeSessionsOnPasswordReset, true);
  // No email sign-in, no password to reset.
  assert.equal(passwordResetDelivery(auth({ providers: ['github'] }), { MISTRI_AUTH_RESET: 'log' }, 'app.ts'), undefined);
  // A delivery tablewalk does not have is refused at startup rather than silently doing nothing.
  assert.throws(() => passwordResetDelivery(email, { MISTRI_AUTH_RESET: 'smtp' }, 'app.ts'), /"log"/);
});

test("with an email service, reset and verification links go to the account's own address", async () => {
  const email = auth({ providers: ['email'], signUp: 'open' });
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const mail = {
    app: 'Atlas',
    send: async (message: { to: string; subject: string; text: string }) => {
      sent.push(message);
    },
  };
  assert.equal(passwordResetDelivery(email, {}, 'app.ts', true), 'email');
  // The log, asked for, still wins: an operator who wants the links in the log gets them there.
  assert.equal(passwordResetDelivery(email, { MISTRI_AUTH_RESET: 'log' }, 'app.ts', true), 'log');
  const options = appAuthProviders(email, {}, 'app.ts', mail) as Record<string, any>;
  await options.emailAndPassword.sendResetPassword({ user: { email: 'ann@example.test' }, url: 'https://atlas.test/reset?token=t' });
  assert.equal(options.emailVerification.sendOnSignUp, true);
  await options.emailVerification.sendVerificationEmail({ user: { email: 'ann@example.test' }, url: 'https://atlas.test/verify?token=v' });
  assert.deepEqual(
    sent.map((message) => [message.to, /reset\?token=t|verify\?token=v/.exec(message.text)?.[0]]),
    [
      ['ann@example.test', 'reset?token=t'],
      ['ann@example.test', 'verify?token=v'],
    ],
  );
  // Without mail nothing is verified, and there is nothing to send.
  assert.equal((appAuthProviders(email, {}, 'app.ts') as Record<string, unknown>).emailVerification, undefined);
});
