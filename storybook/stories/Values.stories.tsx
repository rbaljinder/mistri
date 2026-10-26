import type { Meta, StoryObj } from '@storybook/react-vite';
import { waitFor } from 'storybook/test';
import { AvatarText, Dressed, Value } from '../../packages/kit/src/client/components/Value.js';
import { LeadMark } from '../../packages/kit/src/client/components/Dressed.js';
import { QrCode } from '../../packages/kit/src/client/components/QrCode.js';
import { dressFor, type DisplayRule } from '../../packages/kit/src/client/components/valueModel.js';

const meta = { title: 'Values/Field display' } satisfies Meta;
export default meta;
export const StatusVocabulary: StoryObj = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
      {(['good', 'warn', 'bad', 'info', 'neutral'] as const).map((tone, index) => (
        <Dressed
          key={tone}
          dress={{ kind: 'tone', tone, text: tone, label: ['Approved', 'Needs review', 'Blocked', 'Scheduled', 'Draft'][index] }}
        />
      ))}
    </div>
  ),
};
export const NumbersAndProgress: StoryObj = {
  render: () => (
    <dl className="page-properties">
      <div className="page-field">
        <dt>Budget</dt>
        <dd>
          <Dressed dress={{ kind: 'money', text: '$124,650.25', title: '124650.25 USD' }} />
        </dd>
      </div>
      <div className="page-field">
        <dt>Complete</dt>
        <dd>
          <Dressed dress={{ kind: 'percent', text: '72%', bar: 72 }} />
        </dd>
      </div>
      <div className="page-field">
        <dt>Large identifier</dt>
        <dd>
          <Value col={{ name: 'id', type: 'BIGINT', primaryKey: true, nullable: false }} value="9007199254740993" />
        </dd>
      </div>
    </dl>
  ),
};
export const LongNames: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 300 }}>
      <AvatarText text="Alexandria Montgomery-Wellington" />
    </div>
  ),
};

/* A display rule's formats, each said as the record page says it. */
const dressed = (rule: DisplayRule, value: unknown) => {
  const dress = dressFor(rule, value);
  return dress ? <Dressed dress={dress} /> : null;
};
const fact = (label: string, value: React.ReactNode) => (
  <div className="page-field">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

/* `format: 'avatars'`: a list of names as overlapping initials, three discs and a count of the rest. */
export const AvatarStack: StoryObj = {
  render: () => (
    <dl className="page-properties">
      {fact('Account team', dressed({ format: 'avatars' }, ['Maya Chen', 'Owen Brooks', 'Priya Shah', 'Noah Williams', 'Elena Rossi']))}
      {fact('Reviewers', dressed({ format: 'avatars' }, ['Maya Chen', 'Owen Brooks']))}
    </dl>
  ),
};

/* `icon: { mark, tone }`: a lead mark in a small square, tinted by the row's tone. */
export const IconMarks: StoryObj = {
  render: () => (
    <div style={{ display: 'grid', gap: 10 }}>
      {(
        [
          ['phone', 'good', 'Call Harborview Health'],
          ['file-text', 'info', 'Send the Summit proposal'],
          ['calendar', 'warn', 'Reschedule the Redwood demo'],
          ['fire', 'bad', 'Escalate the Lakeside outage'],
          ['tag', undefined, 'Tag the Pioneer account'],
        ] as const
      ).map(([mark, tone, text]) => (
        <span key={text} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <LeadMark mark={mark} tone={tone} />
          {text}
        </span>
      ))}
    </div>
  ),
};

/* `ring: true` on a percent: a progress circle beside the figure, held inside 0 to 100. */
export const ProgressRing: StoryObj = {
  render: () => (
    <dl className="page-properties">
      {fact('Onboarding', dressed({ format: 'percent', ring: true }, 72))}
      {fact('Data migration', dressed({ format: 'percent', ring: true }, 18))}
      {fact('Training', dressed({ format: 'percent', ring: true }, 100))}
    </dl>
  ),
};

/* The other formats: stars, a swatch, a time, a month, a year and a JSON document. */
export const MoreFormats: StoryObj = {
  render: () => (
    <dl className="page-properties">
      {fact('Health', dressed({ format: 'rating', outOf: 5 }, 4))}
      {fact('Brand color', dressed({ format: 'color' }, '#1d4ed8'))}
      {fact('Opens', dressed({ format: 'time' }, '08:30:00'))}
      {fact('Renews', dressed({ format: 'month' }, '2027-03'))}
      {fact('Model year', dressed({ format: 'year' }, 2024))}
      {fact('Integration', dressed({ format: 'json' }, JSON.stringify({ provider: 'CDK', sync: { inventory: true, pricing: false } })))}
    </dl>
  ),
  /* The JSON tree is a part on demand. */
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      if (!canvasElement.textContent?.includes('provider')) throw new Error('The JSON tree has not arrived');
    });
  },
};

/* `format: 'qr'`: a code to scan with its text under it. It is near-black on white in every look, whatever the
   ground, since an inverted code is one many scanners refuse. */
export const QrValue: StoryObj = {
  render: () => (
    <dl className="page-properties">
      {fact('Asset tag', dressed({ format: 'qr' }, 'STK-0042'))}
      {fact('Portal link', <QrCode text="https://portal.example.com/orders/2026-1187" />)}
    </dl>
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      if (!canvasElement.querySelector('svg.qr-value-code')) throw new Error('The QR code has not arrived');
    });
  },
};
