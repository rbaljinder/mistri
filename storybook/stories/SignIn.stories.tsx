import type { Meta, StoryObj } from '@storybook/react-vite';
import { SignIn, type SignInInfo } from '../../packages/mistri/src/client/components/SignIn.js';

/* The door of an App that signs people in, in each of its states. The screen
   talks to Better Auth's routes with fetch; a story answers them itself. */
const meta = { title: 'Accounts/Sign in', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;

const payday: SignInInfo = { app: 'Payday', providers: ['email'], signUp: 'invite', reset: 'link' };
const HOME = { href: '#payday' };

/** Answer every auth request with this, until the story is left. */
function answering(reply: () => Promise<Response>) {
  return () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => reply()) as typeof fetch;
    return () => {
      globalThis.fetch = real;
    };
  };
}
const never = answering(() => new Promise<Response>(() => {}));
const refused = answering(
  async () => new Response(JSON.stringify({ message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }), { status: 401 }),
);
const sent = answering(async () => new Response(JSON.stringify({ status: true }), { status: 200 }));

/** Type into the form and send it, as a reader would. */
function fill(values: Record<string, string>, then: 'submit' | 'none' = 'submit') {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const [name, value] of Object.entries(values)) {
      const input = canvasElement.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (input) input.value = value;
    }
    if (then === 'submit') canvasElement.querySelector<HTMLFormElement>('form.signin-form')?.requestSubmit();
  };
}
/** Press the button that says this. */
function press(name: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    [...canvasElement.querySelectorAll('button')].find((button) => button.textContent === name)?.click();
  };
}

export const AtRest: StoryObj = { render: () => <SignIn info={payday} home={HOME} /> };
export const FieldProblems: StoryObj = { render: () => <SignIn info={payday} home={HOME} />, play: fill({ email: 'ada@', password: '' }) };
export const Refused: StoryObj = {
  render: () => <SignIn info={payday} />,
  beforeEach: refused,
  play: fill({ email: 'ada@example.org', password: 'wrong-horse' }),
};
export const Busy: StoryObj = {
  render: () => <SignIn info={payday} />,
  beforeEach: never,
  play: fill({ email: 'ada@example.org', password: 'correct-horse' }),
};
export const Providers: StoryObj = {
  render: () => <SignIn info={{ app: 'Compass', providers: ['email', 'github', 'google'], signUp: 'open', reset: 'link' }} />,
};
export const SignUp: StoryObj = {
  render: () => <SignIn info={{ app: 'Compass', providers: ['email'], signUp: 'open' }} />,
  play: press('New here? Create an account'),
};
export const Invitation: StoryObj = {
  render: () => <SignIn info={{ app: 'Ignition', providers: ['email'], signUp: 'invite', invitationClaim: 'ignition' }} />,
  play: press('Have an invitation? Create your account'),
};
export const ForgotPassword: StoryObj = { render: () => <SignIn info={payday} home={HOME} />, play: press('Forgot password?') };
export const ResetLinkSent: StoryObj = {
  render: () => <SignIn info={payday} />,
  beforeEach: sent,
  play: async (context) => {
    await press('Forgot password?')(context);
    await fill({ email: 'ada@example.org' })(context);
  },
};
/* Without a delivery for reset links, the screen says who resets a password. */
export const ForgotWithoutLinks: StoryObj = {
  render: () => <SignIn info={{ ...payday, reset: undefined }} />,
  play: press('Forgot password?'),
};
/* Where a reset link lands: the address carries its token, and the screen asks for the new password. */
export const ChooseNewPassword: StoryObj = {
  beforeEach: () => {
    const url = new URL(window.location.href);
    url.searchParams.set('reset', '1');
    url.searchParams.set('token', 'story-token');
    window.history.replaceState(window.history.state, '', url);
  },
  render: () => <SignIn info={payday} />,
};
