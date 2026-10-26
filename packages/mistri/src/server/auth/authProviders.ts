/** The sign-in methods an App's auth spec turns on, as Better Auth's options: email and password (with the reset
 * and verification links, where they are sent), and the OAuth providers whose credentials the environment holds.
 * Split from auth.ts, which owns the runtimes; nothing here holds or registers one. */
import type { AppSignIn } from '../../shared/app.js';
import type { EmailTransport } from '../email/email.js';
import { signUpShut } from './identityRoles.js';

/**
 * How a reset link for a forgotten password reaches its reader: by email,
 * where the config names an email service (email/email.ts), or the server's
 * own log (`MISTRI_AUTH_RESET=log`), where the link is written for an
 * operator to pass on — an administrator's reset with the typing taken out of
 * it; turn that on only where the log is as private as the session secret.
 * Either way the link is never in an HTTP answer: whoever asks for a reset
 * learns only that a link is on its way, whether or not the address has an
 * account. Neither, there is no reset route, and the sign-in screen says to
 * ask an administrator.
 */
export function passwordResetDelivery(spec: AppSignIn, env: NodeJS.ProcessEnv, where: string, mail = false): 'log' | 'email' | undefined {
  const asked = env.MISTRI_AUTH_RESET?.trim();
  if (asked && asked !== 'log') {
    throw new Error(
      `${where}: MISTRI_AUTH_RESET is "${asked}", and the one it takes is "log", which writes each reset link to the server's log. ` +
        'Name an email service in the config file to send them by email, or unset it to leave resets to an administrator.',
    );
  }
  if (!spec.providers.includes('email')) return undefined;
  return asked === 'log' ? 'log' : mail ? 'email' : undefined;
}

/** Keep invite policy identical for email and OAuth; credentials remain server-side. `mail` sends the
    verification and reset links, where the server has an email service. */
export function appAuthProviders(
  spec: AppSignIn,
  env: NodeJS.ProcessEnv,
  where: string,
  mail?: { send: EmailTransport['send']; app: string },
) {
  const socialProviders: Record<string, { clientId: string; clientSecret: string; disableSignUp: boolean }> = {};
  for (const provider of spec.providers) {
    // An OpenID Connect or SAML provider is the config file's (identityConfig.ts), not the environment's.
    if (provider === 'email' || provider.startsWith('oidc:') || provider.startsWith('saml:')) continue;
    const key = provider.toUpperCase();
    const clientId = env[`${key}_CLIENT_ID`];
    const clientSecret = env[`${key}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) {
      throw new Error(`${where}: "auth" lists ${provider}, which needs ${key}_CLIENT_ID and ${key}_CLIENT_SECRET in the environment.`);
    }
    socialProviders[provider] = { clientId, clientSecret, disableSignUp: signUpShut(spec.signUp, provider) };
  }
  const reset = passwordResetDelivery(spec, env, where, Boolean(mail));
  return {
    emailAndPassword: {
      enabled: spec.providers.includes('email'),
      disableSignUp: spec.signUp !== 'open',
      ...(reset
        ? {
            /* Better Auth mints the one-time token (an hour) and its link; the link
           goes to the account's address or the log and nowhere else. A reset
           ends the account's other sessions, since whoever held the old
           password may hold one. A send that fails is the log's to say. */
            sendResetPassword: async ({ user, url }: { user: { email?: string }; url: string }) => {
              if (reset === 'email' && mail && user.email) {
                await mail
                  .send({
                    to: user.email,
                    subject: `Reset your ${mail.app} password`,
                    text:
                      `Someone asked to reset the password of your ${mail.app} account. The link works once, for an hour:\n\n${url}\n\n` +
                      'If it was not you, ignore this email: the password stays as it is.',
                  })
                  .catch(() => console.error(`mistri: a password reset link could not be emailed.`));
                return;
              }
              console.log(`mistri: password reset link for ${user.email ?? 'an account'} (works once, for an hour): ${url}`);
            },
            resetPasswordTokenExpiresIn: 3600,
            revokeSessionsOnPasswordReset: true,
          }
        : {}),
    },
    /* A verified email is what a link by email trusts (forms/formLink.ts):
       with mail, sign-up sends the link that proves it, and a signed-in
       person may ask for it again. Without mail nothing is verified. */
    ...(mail && spec.providers.includes('email')
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            expiresIn: 3600,
            sendVerificationEmail: async ({ user, url }: { user: { email?: string }; url: string }) => {
              if (!user.email) return;
              await mail
                .send({
                  to: user.email,
                  subject: `Confirm your email for ${mail.app}`,
                  text:
                    `Confirm this is the address of your ${mail.app} account. The link works for an hour:\n\n${url}\n\n` +
                    'If you did not make an account, ignore this email.',
                })
                .catch(() => console.error('mistri: a verification link could not be emailed.'));
            },
          },
        }
      : {}),
    /* Changing the address is a link sent to the new one, so it is offered only where mail is sent (the profile says so).
       A verified address is asked first: the old one is mailed a notice with the link that approves the change, then the
       new one the link that proves it is theirs. The change lands only when both are followed. */
    ...(mail && spec.providers.includes('email')
      ? {
          user: {
            changeEmail: {
              enabled: true,
              sendChangeEmailConfirmation: async ({ user, newEmail, url }: { user: { email?: string }; newEmail: string; url: string }) => {
                if (!user.email) return;
                await mail
                  .send({
                    to: user.email,
                    subject: `Your ${mail.app} email address is being changed`,
                    text:
                      `Someone asked to change the email address of your ${mail.app} account to ${newEmail}. To go ahead, follow this link within the hour:\n\n${url}\n\n` +
                      'If it was not you, ignore this email: the address stays as it is, and consider changing your password.',
                  })
                  .catch(() => console.error('mistri: an email change notice could not be emailed.'));
              },
            },
          },
        }
      : {}),
    socialProviders,
  };
}
