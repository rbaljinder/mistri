/**
 * Questions defined in rows (`field.defined`), drawn and judged: a
 * part loaded on demand. A command asks them only of a signed-in reader's
 * record, once prepare has read the rows, and never on a public form, so a
 * first page carries none of it; CommandFields draws them through `onDemand`
 * and judges the answers once this has arrived. The server judges them again
 * against the rows as they stand when it runs.
 */
import { useState } from 'react';
import type { AppCommandField } from '../../shared/command.js';
import type { CommandValue } from '../commandState.js';
import type { DefinedField } from '@mistriwork/engine/shared/definedFields.js';
import { definedBreaks, definedFromInput } from '@mistriwork/engine/shared/definedValues.js';
import { Field } from '@mistriwork/ui/Field.js';
import { say } from '../copy/forms/components/CommandFields.js';
/* Types only: CommandFields loads this file on demand and hands its control in (`Control`), so neither reaches the
   other at run time. */
import type { CommandFieldControl, CommandFieldsShared, CommandQuestions, CommandValues, ValueField } from './CommandFields.js';

type DefinedInput = Extract<AppCommandField, { type: 'defined' }>;
type Entry = CommandValues[string];

const isValues = (value: unknown): value is CommandValues => !!value && typeof value === 'object' && !Array.isArray(value);

/* What an answer breaks, said as a field's own problem is, under the question's label. */
function answerSentence(question: DefinedField, reason: ReturnType<typeof definedBreaks>[number]['reason']): string {
  const label = question.label;
  switch (reason) {
    case 'required':
      return say('isRequired', { label });
    case 'number':
      return say('mustBeANumber', { label });
    case 'date':
      return say('mustBeADate', { label });
    case 'datetime':
      return say('mustBeADateAndTime', { label });
    case 'bool':
      return say('mustBeYes', { label });
    case 'choice':
      return say('chooseLabel', { label });
    case 'text':
      return say('hasCharactersAForm', { label });
    case 'unknown':
      return say('theFormHasAnInput');
  }
}

/* The answers to questions defined in rows, judged against the questions prepare read, by path (`answers.os`):
   the server judges them again against the rows as they stand when it runs. */
export function answerProblems(
  fields: readonly AppCommandField[],
  values: CommandValues,
  questions?: CommandQuestions,
): [string, string][] {
  if (!questions) return [];
  return fields.flatMap((field) => {
    const asked = field.type === 'defined' ? questions[field.name] : undefined;
    if (!asked) return [];
    const value = values[field.name];
    const answers = isValues(value) ? value : {};
    return definedBreaks(asked, answers, { extras: false }).map(({ key, reason }): [string, string] => [
      `${field.name}.${key}`,
      answerSentence(
        asked.find((question) => question.key === key)!,
        reason,
      ),
    ]);
  });
}

/* A question as the control it is asked with: the command's own controls, so a question reads as any field does. */
function questionControl(question: DefinedField): Exclude<ValueField, { type: 'reference' | 'defined' }> {
  const base = { name: question.key, label: question.label, ...(question.required ? { required: true } : {}) };
  switch (question.type) {
    case 'number':
      return { ...base, type: 'number' };
    case 'money':
      return { ...base, type: 'number', step: 0.01 };
    case 'date':
    case 'datetime':
      return { ...base, type: question.type };
    case 'bool':
      return { ...base, type: 'boolean' };
    case 'choice':
      return { ...base, type: 'choice', options: question.options.map((option) => ({ value: option, label: option })) };
    case 'textarea':
      return { ...base, type: 'textarea' };
    default:
      return { ...base, type: 'text' };
  }
}

/**
 * Questions defined in rows: one control per question prepare
 * read, under the input's label, each answer kept by the question's key. A box
 * keeps what was typed, so a number half-typed stays as typed; the answers
 * hold each one read as its question's kind, which is what is sent.
 */
export function DefinedAnswers({
  field,
  id,
  path,
  value,
  shared,
  onChange,
  Control,
}: {
  field: DefinedInput;
  id: string;
  path: string;
  value: Entry;
  shared: CommandFieldsShared;
  onChange: (value: Entry, path: string) => void;
  Control: typeof CommandFieldControl;
}) {
  const [boxes, setBoxes] = useState<Record<string, CommandValue | string[]>>({});
  const asked = shared.questions?.[field.name];
  if (!asked?.length) return null;
  const answers = (isValues(value) ? value : {}) as Record<string, unknown>;
  const helpId = field.help ? `${id}-help` : undefined;
  return (
    <fieldset className="command-group" aria-describedby={helpId}>
      <legend>{field.label}</legend>
      <div className="command-group-body">
        {field.help && (
          <span id={helpId} className="command-help">
            {field.help}
          </span>
        )}
        <div className="command-fields">
          {asked.map((question) => {
            const at = `${path}.${question.key}`;
            const questionId = `${id}-${question.key}`;
            const problem = shared.problems?.[at];
            const answer = answers[question.key];
            const shown = Object.hasOwn(boxes, question.key) ? boxes[question.key] : answer;
            const set = (next: CommandValue | string[]) => {
              setBoxes((previous) => ({ ...previous, [question.key]: next }));
              const typed = definedFromInput(question, next);
              const following: Record<string, unknown> = { ...answers };
              if (typed === undefined) delete following[question.key];
              else following[question.key] = typed;
              onChange(following as CommandValues, at);
            };
            const control = questionControl(question);
            const label = `${question.label}${question.required && question.type !== 'bool' ? ' (required)' : ''}`;
            return (
              <Field
                key={question.key}
                label={label}
                id={questionId}
                hint={question.help}
                problem={problem}
                group={control.type === 'choice' || question.type === 'choices'}
                check={question.type === 'bool'}
                className="command-field"
              >
                {(slot) =>
                  question.type === 'choices' ? (
                    <div className="command-choices" role="group" id={questionId} aria-labelledby={`${questionId}-label`}>
                      {question.options.map((option) => {
                        const chosen = Array.isArray(shown) ? shown : [];
                        return (
                          <label className="command-choice" key={option}>
                            <input
                              type="checkbox"
                              checked={chosen.includes(option)}
                              disabled={shared.disabled}
                              onChange={(event) =>
                                set(question.options.filter((item) => (item === option ? event.target.checked : chosen.includes(item))))
                              }
                            />
                            {option}
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <Control
                      field={control}
                      id={questionId}
                      describedBy={slot['aria-describedby']}
                      invalid={Boolean(problem)}
                      value={typeof shown === 'string' || typeof shown === 'number' || typeof shown === 'boolean' ? shown : undefined}
                      disabled={shared.disabled}
                      onChange={set}
                    />
                  )
                }
              </Field>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}
