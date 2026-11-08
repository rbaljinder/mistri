import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SavedFormSurface, type SavedFormPresentation } from './SavedFormSurface.js';
import { draftTransport, type DraftTransport } from './draftFormApi.js';

/* A signed-in form saved on every step: the person's own draft, found by who they are (draftFormApi.ts), reopened
   straight at its step, started over in one click, and submitted only as reviewed. */
const form: SavedFormPresentation = {
  id: 'join',
  label: 'Join the club',
  submitLabel: 'Submit application',
  done: { title: 'Application received' },
  input: [
    { name: 'full_name', label: 'Full name', type: 'text', required: true },
    { name: 'tier', label: 'Tier', type: 'text', required: true },
    { name: 'consent', label: 'These details are true', type: 'boolean' },
  ],
  steps: [
    { id: 'you', label: 'You', fields: ['full_name'] },
    { id: 'tier', label: 'Tier', fields: ['tier'] },
  ],
  save: { submit: ['consent'] },
};

const VERSION = 'a'.repeat(64);
function transport(overrides: Partial<DraftTransport> = {}): DraftTransport {
  const keys = new Map<string, string>();
  return {
    resume: vi.fn(async () => null),
    step: vi.fn(async () => undefined),
    review: vi.fn(async () => VERSION),
    submit: vi.fn(async () => ({ reference: 'MEM-0001', receipt: { id: 'r1', status: 'applied' } })),
    discard: vi.fn(async () => undefined),
    keyFor: (step) => keys.get(step) ?? (keys.set(step, `key-${step}`), `key-${step}`),
    clearKey: (step) => void keys.delete(step),
    clearKeys: () => keys.clear(),
    holds: (step) => keys.has(step),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

test('an open draft reopens at the step after the ones saved, with a Start over link', async () => {
  const draft = transport({ resume: vi.fn(async () => ({ saved: ['you'], reopen: null, values: {} })) });
  render(<SavedFormSurface form={form} appName="Club" draft={draft} />);
  await waitFor(() => expect(screen.getByLabelText('Tier (required)')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument();
  expect(screen.getByText(/Your draft is saved/)).toBeInTheDocument();
});

test('a step today rules refuse reopens there, even when later steps are saved', async () => {
  render(
    <SavedFormSurface
      form={form}
      appName="Club"
      draft={transport({ resume: async () => ({ saved: ['you', 'tier'], reopen: 'you', values: {} }) })}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText('Full name (required)')).toBeInTheDocument());
});

test('no draft opens at the first step with no Start over', async () => {
  render(<SavedFormSurface form={form} appName="Club" draft={transport()} />);
  await waitFor(() => expect(screen.getByLabelText('Full name (required)')).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Start over' })).toBeNull();
});

test('Start over discards the draft in one click and begins again at the first step', async () => {
  const draft = transport({ resume: vi.fn(async () => ({ saved: ['you'], reopen: null, values: {} })) });
  render(<SavedFormSurface form={form} appName="Club" draft={draft} />);
  await waitFor(() => expect(screen.getByLabelText('Tier (required)')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  await waitFor(() => expect(screen.getByLabelText('Full name (required)')).toBeInTheDocument());
  expect(draft.discard).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Start over' })).toBeNull();
});

test('a page that asks for a step the draft has reached opens there; one past the first not saved opens at that', async () => {
  const draft = () => transport({ resume: async () => ({ saved: ['you'], reopen: null, values: {} }) });
  const { unmount } = render(<SavedFormSurface form={form} appName="Club" draft={draft()} at="you" />);
  await waitFor(() => expect(screen.getByLabelText('Full name (required)')).toBeInTheDocument());
  unmount();
  render(<SavedFormSurface form={form} appName="Club" draft={transport()} at="tier" />);
  await waitFor(() => expect(screen.getByLabelText('Full name (required)')).toBeInTheDocument());
});

test('Start over is refused while a submit was sent and its result is not known, and nothing is discarded', async () => {
  const draft = transport({
    resume: vi.fn(async () => ({ saved: ['you'], reopen: null, values: {} })),
    holds: (step) => step === '#review',
  });
  render(<SavedFormSurface form={form} appName="Club" draft={draft} />);
  await waitFor(() => expect(screen.getByLabelText('Tier (required)')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  await waitFor(() => expect(screen.getByText(/result is not known yet/)).toBeInTheDocument());
  expect(draft.discard).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Tier (required)')).toBeInTheDocument();
});

async function toReview(draft: DraftTransport, onDismiss?: () => void) {
  render(<SavedFormSurface form={form} appName="Club" draft={draft} {...(onDismiss ? { onDismiss } : {})} />);
  await waitFor(() => expect(screen.getByLabelText('Full name (required)')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Full name (required)'), { target: { value: 'Ann Lee' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('Tier (required)')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Tier (required)'), { target: { value: 'team' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument());
  await waitFor(() => expect(draft.review).toHaveBeenCalledTimes(1));
}

test('each step posts under its own key, the review holds the version, and the submit carries both', async () => {
  const draft = transport();
  await toReview(draft);
  expect(draft.step).toHaveBeenNthCalledWith(1, 'you', 'key-you', { full_name: 'Ann Lee' });
  expect(draft.step).toHaveBeenNthCalledWith(2, 'tier', 'key-tier', { tier: 'team' });
  fireEvent.click(screen.getByLabelText('These details are true'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Application received' })).toBeInTheDocument());
  expect(draft.submit).toHaveBeenCalledWith('key-#review', { consent: true }, VERSION);
});

test('a submit refused as stale reads the review again, says so, and the draft is not submitted', async () => {
  const stale = Object.assign(new Error('This application changed since you reviewed it.'), { status: 409, code: 'stale_record' });
  const draft = transport({ submit: vi.fn(async () => Promise.reject(stale)) });
  await toReview(draft);
  fireEvent.click(screen.getByLabelText('These details are true'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByText(/changed somewhere else/)).toBeInTheDocument());
  expect(screen.queryByRole('heading', { name: 'Application received' })).toBeNull();
  await waitFor(() => expect(draft.review).toHaveBeenCalledTimes(2));
});

test('a review that cannot be read says so, and Submit sends nothing on a guess', async () => {
  const draft = transport({ review: vi.fn(async () => Promise.reject(Object.assign(new Error('boom'), { status: 500 }))) });
  await toReview(draft);
  await waitFor(() => expect(screen.getByText(/could not be read back for review/)).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText('These details are true'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByText(/still being read back for review/)).toBeInTheDocument());
  expect(draft.submit).not.toHaveBeenCalled();
  await waitFor(() => expect(draft.review).toHaveBeenCalledTimes(2));
});

test('in a dialog, Cancel closes it with the draft kept, and the receipt ends in Done', async () => {
  const onDismiss = vi.fn();
  const draft = transport();
  await toReview(draft, onDismiss);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(draft.discard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('These details are true'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Application received' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(onDismiss).toHaveBeenCalledTimes(2);
});

test('the key in flight survives a reload in sessionStorage by command, and is cleared on success', async () => {
  const first = draftTransport('crm', { id: 'join', command: { id: 'submitMembership', version: 1 }, steps: [{ id: 'you' }] });
  const key = first.keyFor('you');
  // A new page (a reload) reads the same key, so the server is asked about it rather than written to twice.
  const reloaded = draftTransport('crm', { id: 'join', command: { id: 'submitMembership', version: 1 }, steps: [{ id: 'you' }] });
  expect(reloaded.keyFor('you')).toBe(key);
  expect(Object.keys(sessionStorage)).toEqual(['mistri:draft-key:crm:submitMembership:you']);
  reloaded.clearKey('you');
  expect(Object.keys(sessionStorage)).toEqual([]);
  expect(draftTransport('crm', { id: 'join', command: { id: 'submitMembership', version: 1 } }).keyFor('you')).not.toBe(key);
});

test('a refused sessionStorage leaves the key in memory for the page', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied');
  });
  const transportOf = draftTransport(null, { id: 'join', command: { id: 'submitMembership', version: 1 } });
  expect(transportOf.keyFor('you')).toBe(transportOf.keyFor('you'));
});

test('a resumed draft shows the answers it holds: the saved step is prefilled and the review lists them', async () => {
  const draft = transport({
    resume: vi.fn(async () => ({ saved: ['you', 'tier'], reopen: null, values: { full_name: 'Ann Lee', tier: 'team' } })),
  });
  render(<SavedFormSurface form={form} appName="Club" draft={draft} />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument());
  expect(screen.getByText('Ann Lee')).toBeInTheDocument();
  expect(screen.getByText('team')).toBeInTheDocument();
  expect(screen.queryByText('Saved earlier')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Change You' }));
  await waitFor(() => expect(screen.getByLabelText('Full name (required)')).toHaveValue('Ann Lee'));
});

test('a draft with no answers to show keeps saying a step was saved earlier', async () => {
  const draft = transport({ resume: vi.fn(async () => ({ saved: ['you', 'tier'], reopen: null, values: {} })) });
  render(<SavedFormSurface form={form} appName="Club" draft={draft} />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument());
  expect(screen.getAllByText(/Saved earlier/i).length).toBeGreaterThan(0);
});

test('the transport reads the resume answer with its values, and none when the server sends none', async () => {
  const send = (answer: unknown) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } }),
    );
    return draftTransport('crm', { id: 'join', command: { id: 'submitMembership', version: 1 } }).resume();
  };
  expect(await send({ draft: { saved: ['you'], reopen: null, values: { full_name: 'Ann' } } })).toEqual({
    saved: ['you'],
    reopen: null,
    values: { full_name: 'Ann' },
  });
  expect((await send({ draft: { saved: [] } }))?.values).toEqual({});
});

/* A narrow screen gives the note one compact line with Start over beside it; a desk keeps the whole sentence. */
const widths = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 600px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
const resumedDraft = () => transport({ resume: vi.fn(async () => ({ saved: ['you'], reopen: null, values: {} })) });

test('on a phone the resumed draft is one compact line, and Start over is still there by its name', async () => {
  widths(true);
  try {
    render(<SavedFormSurface form={form} appName="Club" draft={resumedDraft()} />);
    await waitFor(() => expect(screen.getByLabelText('Tier (required)')).toBeInTheDocument());
    const start = screen.getByRole('button', { name: 'Start over' });
    const note = start.closest('p')!;
    expect(note).toHaveClass('form-note', 'form-note-compact');
    expect(note).toHaveTextContent('Your draft is saved. Start over');
    expect(note).not.toHaveTextContent('Carry on');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('at a desk the resumed draft keeps its whole sentence', async () => {
  widths(false);
  try {
    render(<SavedFormSurface form={form} appName="Club" draft={resumedDraft()} />);
    await waitFor(() => expect(screen.getByLabelText('Tier (required)')).toBeInTheDocument());
    const note = screen.getByRole('button', { name: 'Start over' }).closest('p')!;
    expect(note).not.toHaveClass('form-note-compact');
    expect(note).toHaveTextContent('Your draft is saved. Carry on where you left off, or start over.');
  } finally {
    vi.unstubAllGlobals();
  }
});
