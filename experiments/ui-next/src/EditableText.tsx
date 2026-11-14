import { breakable } from './breaks';
import { PencilSimple } from '@phosphor-icons/react';
import { announce } from '@ui-sdk/core';
import { type ReactNode, useId, useState } from 'react';
import { Editable, EditableInput, EditableValue } from './behaviors/Editable';
import { words } from './words';

export type EditableTextProps = {
  /* What the value is: the box's name, and what is said about it. */
  label: string;
  /* The value as text, as it is kept. */
  value: string;
  /* Asked to keep what was typed. What it throws is said beside the value, which keeps what was typed. */
  onSave: (text: string) => void | Promise<void>;
  /* What is wrong with what was typed, if anything: the box stays open and says it. */
  check?: (text: string) => string | undefined;
  /* The value as it is read, where that is more than its text: money as money. */
  display?: (text: string) => ReactNode;
  /* What stands in an empty value's place. */
  placeholder?: string;
  inputMode?: 'text' | 'decimal' | 'numeric' | 'email' | 'tel' | 'url';
  disabled?: boolean;
};

/* One value of a record, changed where it is read. A press, Enter or simply typing opens a box in its place;
   Enter keeps, Escape puts it back, and leaving the box keeps too, so a reader who clicks away has not lost
   what they typed. What is kept shows at once and is marked as on its way; if the save is refused the value
   says so and holds on to what was typed, and the next press takes up from there rather than from the old
   value. A value that fails its own check never leaves the box. */
export function EditableText({ label, value, onSave, check, display, placeholder, inputMode, disabled }: EditableTextProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ text: string; why: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const said = useId();
  // What was typed stands until it is kept or given up: on its way, or refused and waiting to be put right.
  const shown = pending ?? failed?.text ?? value;
  const read = display ? display(shown) : shown;

  const save = async (text: string) => {
    setPending(text);
    setFailed(null);
    try {
      await onSave(text);
      announce(words.saved(label));
    } catch (error) {
      const why = error instanceof Error && error.message ? error.message : words.notSaved;
      setFailed({ text, why });
      announce(`${label}: ${why}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <Editable
      data-kind="editable-text"
      text={() => failed?.text ?? value}
      locked={() => Boolean(disabled) || pending !== null}
      onCancel={() => {
        setProblem(null);
        setFailed(null);
      }}
      onCommit={(_id, typed) => {
        const text = typed.trim();
        const wrong = check?.(text);
        if (wrong) {
          setProblem(wrong);
          return false;
        }
        setProblem(null);
        if (text === value) setFailed(null);
        else void save(text);
        return true;
      }}
    >
      {(editing) => (
        <EditableValue
          value="value"
          press
          role={editing ? undefined : 'button'}
          tabIndex={editing || disabled ? undefined : 0}
          aria-label={editing ? undefined : `${label}: ${shown || words.empty}. ${words.pressToEdit}`}
          aria-describedby={failed || problem ? said : undefined}
          aria-busy={pending !== null || undefined}
          data-failed={failed && !editing ? '' : undefined}
          data-pending={pending !== null ? '' : undefined}
        >
          {/* What the value shows stays under its box while it is edited, unseen, so the line keeps its height
              and what is under it stays where it is. */}
          <span data-slot="editable-shown" data-empty={shown ? undefined : ''} data-under={editing ? '' : undefined}>
            {shown ? (typeof read === 'string' ? breakable(read) : read) : (placeholder ?? words.addValue)}
          </span>
          {!disabled && <PencilSimple aria-hidden="true" data-slot="editable-pencil" data-under={editing ? '' : undefined} />}
          {editing && (
            <EditableInput
              aria-label={label}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? said : undefined}
              inputMode={inputMode}
            />
          )}
          {(problem && editing) || (failed && !editing) ? (
            <span id={said} data-slot="editable-problem" role={problem ? 'alert' : undefined}>
              {problem && editing ? problem : failed?.why}
            </span>
          ) : null}
        </EditableValue>
      )}
    </Editable>
  );
}
