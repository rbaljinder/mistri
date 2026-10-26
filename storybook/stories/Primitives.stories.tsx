import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, type ButtonIntent, type ButtonSize } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { Dropdown } from '../../packages/kit/src/client/components/Dropdown.js';
import { DateField } from '../../packages/kit/src/client/components/DateField.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';

/* The two primitives every form, dialog and the sign-in card are built from,
   each state in one grid so the visual matrix sees all of them in every look. */
const meta = { title: 'Primitives', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;

const INTENTS: ButtonIntent[] = ['primary', 'secondary', 'quiet', 'danger'];
const SIZES: ButtonSize[] = ['compact', 'default', 'large'];
const STATES = ['Rest', 'Pressed', 'Busy', 'Disabled'] as const;
const WORDS: Record<ButtonIntent, string> = {
  primary: 'Save changes',
  secondary: 'Cancel',
  quiet: 'Forgot password?',
  danger: 'Archive project',
};

const grid = { display: 'grid', gap: '12px 16px', alignItems: 'center', justifyItems: 'start' } as const;
const caption = { font: '12px var(--sans)', color: 'var(--ink-muted)' } as const;

function ButtonGrid({ size }: { size: ButtonSize }) {
  return (
    /* Five columns of buttons are wider than a phone: the sheet scrolls in its own box, not the page. */
    <div style={{ overflowX: 'auto' }}>
      <div style={{ ...grid, gridTemplateColumns: `7rem repeat(${STATES.length}, auto)` }}>
        <span />
        {STATES.map((state) => (
          <span key={state} style={caption}>
            {state}
          </span>
        ))}
        {INTENTS.map((intent) => (
          <div key={intent} style={{ display: 'contents' }}>
            <span style={caption}>{intent}</span>
            <Button intent={intent} size={size}>
              {WORDS[intent]}
            </Button>
            {/* Pressed is a toggle's "on", which only the secondary intent is. */}
            {intent === 'secondary' ? (
              <Button intent={intent} size={size} aria-pressed="true">
                Show archived
              </Button>
            ) : (
              <span style={caption}>—</span>
            )}
            <Button intent={intent} size={size} busy busyLabel="Saving…">
              {WORDS[intent]}
            </Button>
            <Button intent={intent} size={size} disabled>
              {WORDS[intent]}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export const Buttons: StoryObj = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 32 }}>
      {SIZES.map((size) => (
        <section key={size} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
          <h2 style={{ margin: 0, font: '600 14px var(--sans)' }}>{size[0].toUpperCase() + size.slice(1)}</h2>
          <ButtonGrid size={size} />
        </section>
      ))}
      <section style={{ display: 'grid', gap: 12, maxWidth: 360 }}>
        <h2 style={{ margin: 0, font: '600 14px var(--sans)' }}>Full width</h2>
        <Button intent="primary" size="large" block>
          Sign in
        </Button>
        <Button intent="secondary" size="large" block>
          Continue with GitHub
        </Button>
      </section>
    </div>
  ),
};

/* Focus is drawn by the browser, so it is reviewed here, one control at a time. */
export const ButtonFocus: StoryObj = {
  render: function Focused() {
    const first = useRef<HTMLButtonElement>(null);
    useEffect(() => {
      first.current?.focus();
    }, []);
    return (
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Button ref={first} intent="primary">
          Save changes
        </Button>
        <Button intent="secondary">Cancel</Button>
        <Button intent="quiet">Forgot password?</Button>
        <Button intent="danger">Archive project</Button>
      </div>
    );
  },
};

const TEAMS = [
  { value: 'design', label: 'Design' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'people', label: 'People' },
];
const PEOPLE = ['Maya Chen', 'Owen Brooks', 'Priya Shah', 'Noah Williams'];

type FieldState = 'rest' | 'hint' | 'problem' | 'disabled';
const SAID: Record<FieldState, { hint?: string; problem?: string }> = {
  rest: {},
  hint: { hint: 'Shown on the invoice.' },
  problem: { problem: 'Enter a name of 1 to 120 characters.' },
  disabled: {},
};

function Fields({ state, size = 'default' }: { state: FieldState; size?: 'compact' | 'default' }) {
  const [team, setTeam] = useState('design');
  const [date, setDate] = useState('2026-09-22');
  const [text, setText] = useState(state === 'rest' ? '' : 'Maya');
  const [open, setOpen] = useState(false);
  const disabled = state === 'disabled';
  const said = SAID[state];
  const control = 'field-control';
  return (
    <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))' }}>
      <Field label="Name" required {...said} size={size}>
        <input className={control} defaultValue="Maya Chen" disabled={disabled} />
      </Field>
      <Field label="Password" {...said} size={size}>
        <input className={control} type="password" defaultValue="correct-horse" disabled={disabled} />
      </Field>
      <Field label="Team" {...said} size={size}>
        {(c) => (
          <Dropdown
            id={c.id}
            ariaLabel="Team"
            ariaInvalid={c['aria-invalid']}
            ariaDescribedBy={c['aria-describedby']}
            value={team}
            onChange={setTeam}
            disabled={disabled}
            items={TEAMS}
          />
        )}
      </Field>
      <Field label="Start date" {...said} size={size}>
        {(c) => (
          <DateField
            id={c.id}
            value={date}
            onChange={setDate}
            disabled={disabled}
            className="field-control"
            aria-invalid={c['aria-invalid']}
            aria-describedby={c['aria-describedby']}
          />
        )}
      </Field>
      <Field label="Manager" {...said} size={size}>
        {(c) => (
          <div className="picker">
            <Typeahead
              text={text}
              onText={setText}
              items={PEOPLE.filter((name) => name.toLowerCase().includes(text.toLowerCase()))}
              itemKey={(name) => name}
              itemLabel={(name) => name}
              itemClassName={(_name, lit) => `picker-option${lit ? ' active' : ''}`}
              renderItem={(name) => name}
              onPick={(name) => {
                setText(name);
                setOpen(false);
              }}
              open={open}
              onOpenChange={setOpen}
              inputProps={{ ...c, className: 'picker-input', disabled, placeholder: 'Find a teammate' }}
              popupClassName="picker-popup"
              listClassName="picker-list"
              empty="No matching teammates"
            />
          </div>
        )}
      </Field>
      <Field label="Note" {...said} size={size}>
        <textarea className={control} rows={3} placeholder="Add useful context" disabled={disabled} />
      </Field>
    </div>
  );
}

export const FieldsAtRest: StoryObj = { render: () => <Fields state="rest" /> };
export const FieldsWithHint: StoryObj = { render: () => <Fields state="hint" /> };
export const FieldsWithProblem: StoryObj = { render: () => <Fields state="problem" /> };
export const FieldsDisabled: StoryObj = { render: () => <Fields state="disabled" /> };
export const FieldsCompact: StoryObj = { render: () => <Fields state="rest" size="compact" /> };

/* A field and its actions, as a form closes: the actions 24px under the last
   field, and on a phone the width of the form. */
export const FieldsWithActions: StoryObj = {
  render: () => (
    <form style={{ maxWidth: 420 }} onSubmit={(event) => event.preventDefault()}>
      <Field label="Project name" required hint="Shown to everyone on the team.">
        <input className="field-control" defaultValue="Customer onboarding" />
      </Field>
      <div className="form-actions">
        <Button intent="secondary">Cancel</Button>
        <Button intent="primary" type="submit">
          Save
        </Button>
      </div>
    </form>
  ),
};
