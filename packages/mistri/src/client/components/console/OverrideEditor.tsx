/**
 * The flag sheet's editor: its rules as an ordered list of one-line cards,
 * each opened to edit (one at a time, so the sheet stays a page long), and
 * what everyone else gets as one line — a value, a share, and the bar that
 * draws the share. Nothing here is sent: the sheet stages the draft, shows
 * what it changes, and submits one complete override at the revision read.
 */
import { useId, useState, type ReactNode } from 'react';
import { Button, Dropdown, Stack } from '@mistriwork/mistri/ui';
import { Field } from '@mistriwork/ui/Field.js';
import type { FlagOverride, FlagTarget } from '../../../shared/appFlags.js';
import { editedValue, type FlagDetail } from './model.js';
import { RolloutBar, RuleLine, audienceWords, type DraftRule } from './flagWords.js';
import { say } from '../../copy/console/components/console/OverrideEditor.js';

export interface OverrideDraft {
  rollout: string;
  disabled: boolean;
  rules: readonly DraftRule[];
}
export function controlDraft(detail: FlagDetail): OverrideDraft {
  return {
    rollout: detail.control?.rollout === undefined ? '' : String(detail.control.rollout),
    disabled: detail.control?.disabled ?? false,
    rules: detail.control?.rules ?? [],
  };
}
export function editedOverride(detail: FlagDetail, text: string, draft: OverrideDraft): FlagOverride {
  const rollout = draft.rollout.trim() === '' ? undefined : Number(draft.rollout);
  if (rollout !== undefined && (!Number.isFinite(rollout) || rollout < 0 || rollout > 100)) throw new Error(say('invalidRollout'));
  const rules = draft.rules.map(({ draftValue, audiences, ...rule }, index): FlagTarget => {
    if (!audiences?.length) throw new Error(say('ruleNeedsAudience', { number: index + 1 }));
    return {
      ...rule,
      audiences,
      ...(draftValue === undefined ? {} : { value: editedValue(detail, draftValue) as FlagTarget['value'] }),
    };
  });
  return {
    value: editedValue(detail, text) as FlagTarget['value'],
    ...(rollout === undefined ? {} : { rollout }),
    ...(draft.disabled ? { disabled: true } : {}),
    ...(rules.length ? { rules } : {}),
  };
}
/** A value as its editor holds it: a plain string as itself, anything else as JSON. */
export const valueText = (detail: FlagDetail, value: unknown) =>
  value === undefined ? '' : detail.type === 'string' && !detail.variants ? String(value ?? '') : (JSON.stringify(value) ?? '');

function ValueEditor({
  detail,
  text,
  setText,
  disabled,
  label,
}: {
  detail: FlagDetail;
  text: string;
  setText(value: string): void;
  disabled: boolean;
  label: string;
}) {
  return detail.variants || detail.type === 'boolean' ? (
    <Field size="compact" label={label}>
      {(control) => (
        <Dropdown
          id={control.id}
          ariaLabel={label}
          ariaDescribedBy={control['aria-describedby']}
          value={text}
          disabled={disabled}
          onChange={setText}
          items={[
            { value: '', label: say('chooseValue') },
            ...(detail.variants ?? [true, false]).map((value) => ({
              value: JSON.stringify(value),
              label: JSON.stringify(value),
            })),
          ]}
        />
      )}
    </Field>
  ) : detail.type === 'object' ? (
    <Field label={label} hint={say('objectHint')}>
      <textarea
        className="json-raw"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        rows={5}
        spellCheck={false}
      />
    </Field>
  ) : (
    <Field size="compact" label={label}>
      <input
        type={detail.type === 'number' ? 'number' : 'text'}
        step="any"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
      />
    </Field>
  );
}

/** A rule's conditions as fields: the App's audiences by name, each with what it holds. */
function RuleFields({
  detail,
  rule,
  number,
  disabled,
  update,
}: {
  detail: FlagDetail;
  rule: DraftRule;
  number: number;
  disabled: boolean;
  update(rule: DraftRule): void;
}) {
  const audiences = Object.entries(detail.audiences ?? {});
  return (
    <fieldset className="console-rule-fields" disabled={disabled} aria-label={say('ruleNumber', { number })}>
      {audiences.length ? (
        <fieldset className="console-segment">
          <legend>{say('audiences')}</legend>
          <p className="console-caption">{say('audiencesHint')}</p>
          {audiences.map(([name, audience]) => (
            <span key={name}>
              <label>
                <input
                  type="checkbox"
                  checked={rule.audiences?.includes(name) ?? false}
                  onChange={(event) => {
                    const chosen = new Set(rule.audiences ?? []);
                    if (event.target.checked) chosen.add(name);
                    else chosen.delete(name);
                    const { audiences: _old, ...rest } = rule;
                    const kept = audiences.map(([item]) => item).filter((item) => chosen.has(item));
                    update(kept.length ? { ...rest, audiences: kept } : rest);
                  }}
                />{' '}
                {name}
              </label>{' '}
              <span className="console-caption">{audienceWords(audience)}</span>
            </span>
          ))}
        </fieldset>
      ) : null}
      <ValueEditor
        detail={detail}
        label={say('ruleValue')}
        text={rule.draftValue ?? valueText(detail, rule.value)}
        disabled={disabled}
        setText={(draftValue) => update({ ...rule, draftValue })}
      />
    </fieldset>
  );
}

export function OverrideEditor({
  detail,
  draft,
  onChange,
  disabled,
  text,
  setText,
  serving,
}: {
  detail: FlagDetail;
  draft: OverrideDraft;
  onChange(value: OverrideDraft): void;
  disabled: boolean;
  text: string;
  setText(value: string): void;
  /** The draft said back as the Serving sentence, drawn above the rules. */
  serving?: ReactNode;
}) {
  const [open, setOpen] = useState<number>();
  const id = useId();
  const update = (index: number, rule: DraftRule) =>
    onChange({
      ...draft,
      rules: draft.rules.map((old, at) => (at === index ? rule : old)),
    });
  const move = (index: number, step: -1 | 1) => {
    const rules = [...draft.rules];
    [rules[index], rules[index + step]] = [rules[index + step], rules[index]];
    onChange({ ...draft, rules });
    if (open === index) setOpen(index + step);
    else if (open === index + step) setOpen(index);
  };
  const rollout = draft.rollout.trim() === '' ? undefined : Number(draft.rollout);
  // A rule says who only through the App's audiences, so with none declared there is nothing to target.
  const declaredAudiences = Object.keys(detail.audiences ?? {}).length > 0;
  let value: unknown;
  try {
    value = text === '' ? undefined : editedValue(detail, text);
  } catch {
    value = undefined;
  }
  return (
    <Stack>
      {serving}
      <section className="console-section" aria-labelledby={`${id}-rules`}>
        <div className="console-section-head">
          <h3 className="console-section-title" id={`${id}-rules`}>
            {say('targeting')}
            <span className="console-count-pill">{draft.rules.length}</span>
          </h3>
          <Button
            size="compact"
            intent="quiet"
            disabled={disabled || draft.rules.length >= 64 || !declaredAudiences}
            onClick={() => {
              onChange({
                ...draft,
                rules: [
                  ...draft.rules,
                  {
                    value: (value ?? detail.value ?? detail.defaultValue) as FlagTarget['value'],
                  },
                ],
              });
              setOpen(draft.rules.length);
            }}
          >
            {say('addRule')}
          </Button>
        </div>
        {!draft.rules.length ? (
          <p className="console-caption">{say(declaredAudiences ? 'noRules' : 'noAudiences')}</p>
        ) : (
          <ol className="console-rules">
            {draft.rules.map((rule, index) => (
              <li key={index} className="console-rule" data-open={open === index || undefined}>
                <div className="console-rule-line">
                  <span className="console-rule-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="console-rule-words">
                    <RuleLine rule={rule} />
                  </span>
                  <span className="console-rule-tools">
                    <Button
                      size="compact"
                      intent="quiet"
                      aria-expanded={open === index}
                      aria-label={say(open === index ? 'doneRule' : 'editRule', { number: index + 1 })}
                      onClick={() => setOpen(open === index ? undefined : index)}
                    >
                      {open === index ? say('done') : say('edit')}
                    </Button>
                    <Button
                      size="compact"
                      intent="quiet"
                      disabled={disabled || index === 0}
                      aria-label={say('moveUp', { number: index + 1 })}
                      onClick={() => move(index, -1)}
                    >
                      <span aria-hidden="true">↑</span>
                    </Button>
                    <Button
                      size="compact"
                      intent="quiet"
                      disabled={disabled || index === draft.rules.length - 1}
                      aria-label={say('moveDown', { number: index + 1 })}
                      onClick={() => move(index, 1)}
                    >
                      <span aria-hidden="true">↓</span>
                    </Button>
                    <Button
                      size="compact"
                      intent="quiet"
                      disabled={disabled}
                      aria-label={say('removeRule', { number: index + 1 })}
                      onClick={() => {
                        onChange({
                          ...draft,
                          rules: draft.rules.filter((_, at) => at !== index),
                        });
                        setOpen(undefined);
                      }}
                    >
                      <span aria-hidden="true">×</span>
                    </Button>
                  </span>
                </div>
                {open === index && (
                  <RuleFields detail={detail} rule={rule} number={index + 1} disabled={disabled} update={(next) => update(index, next)} />
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="console-caption">{say('targetingHint')}</p>
      </section>
      <section className="console-section" aria-labelledby={`${id}-rest`}>
        <h3 className="console-section-title" id={`${id}-rest`}>
          {draft.rules.length ? say('everyoneElse') : say('everyone')}
        </h3>
        <div className="console-value-settings">
          <ValueEditor detail={detail} text={text} setText={setText} disabled={disabled} label={say('value')} />
          <Field size="compact" label={say('rollout')} hint={say('rolloutHint')}>
            <input
              type="number"
              min="0"
              max="100"
              step="any"
              placeholder="100"
              value={draft.rollout}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, rollout: event.target.value })}
            />
          </Field>
        </div>
        <RolloutBar
          detail={detail}
          controls={{
            value,
            rollout: rollout !== undefined && Number.isFinite(rollout) ? rollout : undefined,
            disabled: false,
          }}
        />
        {detail.disabled && (
          <label className="console-check-line">
            <input
              type="checkbox"
              checked={draft.disabled}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, disabled: event.target.checked })}
            />{' '}
            {say('keepDisabled')}
          </label>
        )}
        {detail.experimentAllocated && <p role="note">{say('replaceExperiment')}</p>}
      </section>
    </Stack>
  );
}
