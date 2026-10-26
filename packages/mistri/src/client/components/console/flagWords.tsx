/**
 * A flag's targeting said as sentences: what it serves to whom, a rule as one
 * line, and a staged edit as the list of what it changes. The sheet leads
 * with these so a reader knows what a flag does before reading a form, and
 * the review step shows the same words for before and after, so a change is
 * judged in the terms it will be served in.
 *
 * The sentences follow the server's evaluation order exactly
 * (packages/mistri/src/server/flags/evaluation.ts): a disabled flag serves its safe value to
 * everyone; otherwise the first matching rule wins; then the rollout admits
 * its share to the flag's value (or its experiment); everyone else gets the
 * declared default.
 */
import type { ReactNode } from 'react';
import type { AudienceDefinition, FlagTarget } from '../../../shared/appFlags.js';
import { say } from '../../copy/console/components/console/flagWords.js';
import type { FlagDetail } from './model.js';

/** A rule as the editor holds it: the declared shape, its audiences still being
 * chosen (a new rule has none until one is checked), plus the value being typed. */
export type DraftRule = Omit<FlagTarget, 'audiences'> & {
  readonly audiences?: readonly string[];
  readonly draftValue?: string;
};

/* A hole the message keeps for a value drawn as code; split on, never shown. */
const HOLE = '\u0000';

/** A value as the sentence says it: a string as itself, anything else as JSON, an object shortened. */
export function valueWord(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') return Array.isArray(value) ? '[…]' : '{…}';
  return JSON.stringify(value) ?? '—';
}

/** Who a rule matches: "audience beta or staff". A rule reaches people only
 * through audiences; one still being written, with none checked, matches nobody. */
function ruleWho(rule: DraftRule): string {
  const audiences = rule.audiences ?? [];
  return audiences.length ? say(audiences.length === 1 ? 'audience' : 'audiences', { names: audiences.join(say('or')) }) : say('nobody');
}

/** Who an audience holds, as its definition says it: "role tester and 25% of people". */
export function audienceWords(audience: AudienceDefinition): string {
  const list = (names: readonly string[]) => names.join(say('or'));
  const parts = [
    ...(audience.roles ? [say(audience.roles.length === 1 ? 'role' : 'roles', { names: list(audience.roles) })] : []),
    ...(audience.tenants ? [say(audience.tenants.length === 1 ? 'tenant' : 'tenants', { names: list(audience.tenants) })] : []),
    ...(audience.attributes?.emailDomain ? [say('memberDomain', { names: list(audience.attributes.emailDomain) })] : []),
    ...(audience.rollout === undefined ? [] : [say('memberShare', { share: audience.rollout })]),
    ...(audience.allow ? [say('memberAllow', { count: audience.allow.length })] : []),
    ...(audience.deny ? [say('memberDeny', { count: audience.deny.length })] : []),
  ];
  return parts.length ? parts.join(say('and')) : say('everyone');
}

/** The value a rule serves, as typed or as declared. */
function ruleValue(rule: DraftRule): string {
  if (rule.draftValue === undefined) return valueWord(rule.value);
  try {
    return valueWord(JSON.parse(rule.draftValue));
  } catch {
    return rule.draftValue;
  }
}

/** A message with one value in it, the value drawn as code. */
function withValue(text: string, value: string, key: string): ReactNode {
  const [before, after = ''] = text.split(HOLE);
  return (
    <span key={key}>
      {before}
      <code className="console-value">{value}</code>
      {after}
    </span>
  );
}

/** One rule as a line: "If audience beta, serve true". */
export function RuleLine({ rule }: { rule: DraftRule }) {
  return <>{withValue(say('ruleLine', { who: ruleWho(rule), value: HOLE }), ruleValue(rule), 'rule')}</>;
}

/** The controls a sentence is said of: the flag's current ones, or a staged edit's. */
export interface ServingControls {
  value?: unknown;
  rollout?: number;
  disabled?: boolean;
  rules?: readonly DraftRule[];
  experiment?: boolean;
}

/** The controls the flag holds now, as the sentence reads them. */
export function currentControls(detail: FlagDetail): ServingControls | null {
  /* A reader shown the value but not the controls behind it still reads the value as what everyone gets. */
  if (!detail.control)
    return detail.value === undefined
      ? null
      : { value: detail.value, rollout: detail.rollout, disabled: detail.disabled, experiment: detail.experimentAllocated };
  return {
    value: detail.control.value,
    rollout: detail.control.rollout,
    disabled: detail.control.disabled,
    rules: detail.control.rules,
    experiment: detail.experimentAllocated,
  };
}

/**
 * The whole flag in one sentence: "Serve true to role manager; false to
 * tenant acme or globex; true to 35% of everyone else. Everyone else gets false."
 */
export function Serving({ detail, controls }: { detail: FlagDetail; controls: ServingControls | null }) {
  const fallback = valueWord(detail.defaultValue);
  if (controls?.disabled)
    return (
      <p className="console-serving">
        {detail.safeValue === undefined
          ? say('servingOff')
          : withValue(say('servingOffValue', { value: HOLE }), valueWord(detail.safeValue), 'off')}
      </p>
    );
  if (!controls)
    return (
      <p className="console-serving">
        {detail.defaultValue === undefined ? say('servingUnknown') : withValue(say('servingDefault', { value: HOLE }), fallback, 'default')}
      </p>
    );
  const rules = controls.rules ?? [];
  const clauses: ReactNode[] = rules.map((rule, index) =>
    withValue(say('clauseRule', { value: HOLE, who: ruleWho(rule) }), ruleValue(rule), `rule-${index}`),
  );
  const rest = rules.length ? say('everyoneElse') : say('everyone');
  const share = controls.rollout ?? 100;
  if (controls.experiment) clauses.push(<span key="experiment">{say('clauseExperiment', { share, rest })}</span>);
  else if (controls.value !== undefined)
    clauses.push(
      withValue(
        share < 100 ? say('clauseShare', { value: HOLE, share, rest }) : say('clauseAll', { value: HOLE, rest }),
        valueWord(controls.value),
        'rollout',
      ),
    );
  const remainder = controls.experiment || (controls.value !== undefined && share < 100) || controls.value === undefined;
  return (
    <p className="console-serving">
      {clauses.length ? (
        <>
          {say('serve')}{' '}
          {clauses.map((clause, index) => (
            <span key={index}>
              {index > 0 && say('clauseJoin')}
              {clause}
            </span>
          ))}
          {say('stop')}
        </>
      ) : null}
      {remainder && detail.defaultValue !== undefined && (
        <>
          {clauses.length ? ' ' : ''}
          {withValue(say(clauses.length ? 'restGet' : 'everyoneGets', { value: HOLE }), fallback, 'rest')}
        </>
      )}
    </p>
  );
}

/** The share the rollout admits and the share left to the default, as one bar's two parts. */
export function RolloutBar({ detail, controls }: { detail: FlagDetail; controls: ServingControls | null }) {
  if (!controls || controls.disabled) return null;
  const share = Math.max(0, Math.min(100, controls.rollout ?? 100));
  const served = controls.experiment ? say('experimentArms') : controls.value === undefined ? undefined : valueWord(controls.value);
  if (served === undefined) return null;
  const rest = 100 - share;
  const label = say('rolloutBar', {
    share,
    served,
    rest,
    fallback: valueWord(detail.defaultValue),
  });
  return (
    <div className="console-split-bar" role="img" aria-label={label}>
      <span className="console-split-track" aria-hidden="true">
        {share > 0 && <span className="console-split-part is-served" style={{ flexGrow: share }} />}
        {rest > 0 && <span className="console-split-part is-rest" style={{ flexGrow: rest }} />}
      </span>
      <span className="console-split-legend" aria-hidden="true">
        <span className="console-legend-item">
          <span className="console-legend-swatch is-served" />
          {say('legendServed', { share, served })}
        </span>
        {rest > 0 && (
          <span className="console-legend-item">
            <span className="console-legend-swatch is-rest" />
            {say('legendRest', {
              rest,
              fallback: valueWord(detail.defaultValue),
            })}
          </span>
        )}
      </span>
    </div>
  );
}

/** One line of a staged edit's review: what it touches, and its words before and after. */
interface StagedChange {
  what: string;
  before?: ReactNode;
  after?: ReactNode;
}

const ruleKey = (rule: DraftRule) => {
  return JSON.stringify([rule.audiences ?? [], ruleValue(rule)]);
};

/** What a staged edit changes against the flag's controls, in the order the sheet draws them. */
export function stagedChanges(
  base: {
    text: string;
    rollout: string;
    disabled: boolean;
    rules: readonly DraftRule[];
  },
  next: {
    text: string;
    rollout: string;
    disabled: boolean;
    rules: readonly DraftRule[];
  },
): StagedChange[] {
  const changes: StagedChange[] = [];
  const percent = (text: string) => (text.trim() === '' ? '100%' : `${text.trim()}%`);
  if (base.text !== next.text)
    changes.push({
      what: say('changeValue'),
      before: base.text === '' ? say('nothing') : <code className="console-value">{base.text}</code>,
      after: <code className="console-value">{next.text}</code>,
    });
  if (percent(base.rollout) !== percent(next.rollout))
    changes.push({
      what: say('changeRollout'),
      before: percent(base.rollout),
      after: percent(next.rollout),
    });
  if (base.disabled !== next.disabled)
    changes.push({
      what: say('changeDisabled'),
      before: base.disabled ? say('off') : say('on'),
      after: next.disabled ? say('off') : say('on'),
    });
  const count = Math.max(base.rules.length, next.rules.length);
  for (let index = 0; index < count; index++) {
    const was = base.rules[index],
      now = next.rules[index];
    const what = say('changeRule', { number: index + 1 });
    if (!was) changes.push({ what, after: <RuleLine rule={now} /> });
    else if (!now) changes.push({ what, before: <RuleLine rule={was} /> });
    else if (ruleKey(was) !== ruleKey(now))
      changes.push({
        what,
        before: <RuleLine rule={was} />,
        after: <RuleLine rule={now} />,
      });
  }
  return changes;
}
