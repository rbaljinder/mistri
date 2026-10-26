/**
 * Behavior analytics, declared: which built-in kinds an App collects, the
 * custom events its components may emit, and the funnels read over them.
 *
 * Off unless declared. A declaration only names things; what is stored, and
 * where, is the `analytics` store's (src/server/analytics/), bound by
 * configuration, never by the App. The finding codes `analytics-unknown-step`,
 * `analytics-not-collected` and `analytics-name-clash` are carried in
 * brackets, which is how `mistri check --json` reads a code.
 */
import { isFormView, type AppDef } from './appModel.js';
import { isRecord, VIEW_KEY } from '@mistriwork/engine/shared/model.js';
import { captureFlagDeclaration } from './appExperiments.js';
import { DURATION_WORDS, parseDuration } from '@mistriwork/engine/shared/duration.js';

const ANALYTICS_KINDS = ['views', 'commands', 'forms'] as const;
export type AnalyticsKind = (typeof ANALYTICS_KINDS)[number];

/** Closed bounds: a declaration is data a person reads, not a pipeline. */
export const ANALYTICS_LIMITS = Object.freeze({ events: 64, eventFields: 16, funnels: 32, steps: 10, windowHours: 8760, valueLength: 200 });

/** Exactly one of view, command, form (with an optional step) or event. */
export type AnalyticsStep =
  | { readonly view: string }
  | { readonly command: string }
  | { readonly form: string; readonly step?: string }
  | { readonly event: string };

export interface AnalyticsFunnel {
  readonly unit: 'subject' | 'visitor';
  /** `'72 hours'`: how long after its first step a subject may take the rest. */
  readonly conversionWindow: string;
  readonly steps: readonly AnalyticsStep[];
}

export interface AnalyticsDeclaration {
  readonly collect?: readonly AnalyticsKind[];
  readonly events?: Readonly<Record<string, { readonly fields: readonly string[] }>>;
  readonly funnels?: Readonly<Record<string, AnalyticsFunnel>>;
}

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

function object(value: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} must be an object.`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new Error(`${at} has "${key}", which it does not take. It takes: ${keys.join(', ')}.`);
  return value;
}

/** The authored `analytics` block, closed and frozen. Throws a sentence naming where. */
export function normalizeAnalytics(input: unknown, where: string): AnalyticsDeclaration {
  const at = `${where}: analytics`;
  const raw = object(captureFlagDeclaration(input), at, ['collect', 'events', 'funnels']);
  let collect: AnalyticsKind[] | undefined;
  if (raw.collect !== undefined) {
    if (
      !Array.isArray(raw.collect) ||
      raw.collect.some((kind) => !ANALYTICS_KINDS.includes(kind as AnalyticsKind)) ||
      new Set(raw.collect).size !== raw.collect.length
    ) {
      if (Array.isArray(raw.collect) && raw.collect.includes('actions'))
        throw new Error(`${at} collect has "actions", which is now "commands": the command runs an action or a form starts.`);
      throw new Error(`${at} collect is a list of ${ANALYTICS_KINDS.map((kind) => `"${kind}"`).join(', ')}, each once.`);
    }
    collect = [...raw.collect] as AnalyticsKind[];
  }
  let events: Record<string, { fields: readonly string[] }> | undefined;
  if (raw.events !== undefined) {
    const declared = object(raw.events, `${at} events`, Object.keys(isRecord(raw.events) ? raw.events : {}));
    if (Object.keys(declared).length > ANALYTICS_LIMITS.events)
      throw new Error(`${at} events holds at most ${ANALYTICS_LIMITS.events} events.`);
    events = {};
    for (const [name, value] of Object.entries(declared)) {
      // An App's own names, a custom event's and a funnel's, are spelled as its view ids are.
      if (!VIEW_KEY.test(name))
        throw new Error(`${at} events "${name}" is not an id of lowercase letters, digits and "-", as a view id is ('compare-opened').`);
      const event = object(value, `${at} events "${name}"`, ['fields']);
      const fields = event.fields ?? [];
      if (
        !Array.isArray(fields) ||
        fields.length > ANALYTICS_LIMITS.eventFields ||
        fields.some((field) => typeof field !== 'string' || !FIELD.test(field) || FORBIDDEN.has(field)) ||
        new Set(fields).size !== fields.length
      ) {
        throw new Error(`${at} events "${name}" fields is a list of at most ${ANALYTICS_LIMITS.eventFields} distinct field names.`);
      }
      events[name] = Object.freeze({ fields: Object.freeze([...fields] as string[]) });
    }
  }
  let funnels: Record<string, AnalyticsFunnel> | undefined;
  if (raw.funnels !== undefined) {
    const declared = object(raw.funnels, `${at} funnels`, Object.keys(isRecord(raw.funnels) ? raw.funnels : {}));
    if (Object.keys(declared).length > ANALYTICS_LIMITS.funnels)
      throw new Error(`${at} funnels holds at most ${ANALYTICS_LIMITS.funnels} funnels.`);
    funnels = {};
    for (const [id, value] of Object.entries(declared)) {
      if (!VIEW_KEY.test(id))
        throw new Error(`${at} funnels "${id}" is not an id of lowercase letters, digits and "-", as a view id is ('apply-funnel').`);
      const here = `${at} funnel "${id}"`;
      const funnel = object(value, here, ['unit', 'conversionWindow', 'steps']);
      if (funnel.unit !== 'subject' && funnel.unit !== 'visitor') throw new Error(`${here} unit is "subject" or "visitor".`);
      const windowMs = parseDuration(funnel.conversionWindow);
      if (!windowMs || windowMs > ANALYTICS_LIMITS.windowHours * 3_600_000) {
        throw new Error(
          `${here} conversionWindow is ${DURATION_WORDS}, above zero and at most a year ('${ANALYTICS_LIMITS.windowHours} hours').`,
        );
      }
      if (!Array.isArray(funnel.steps) || funnel.steps.length < 2 || funnel.steps.length > ANALYTICS_LIMITS.steps) {
        throw new Error(`${here} steps is a list of 2 to ${ANALYTICS_LIMITS.steps} steps.`);
      }
      const steps = funnel.steps.map((entry, index): AnalyticsStep => {
        const step = `${here} step ${index + 1}`;
        if (isRecord(entry) && entry.action !== undefined)
          throw new Error(`${step} has "action", which is now "command": the id of the command it counts.`);
        const given = isRecord(entry) ? Object.keys(entry).filter((key) => ['view', 'command', 'form', 'event'].includes(key)) : [];
        if (given.length !== 1) throw new Error(`${step} names exactly one of view, command, form or event.`);
        const kind = given[0] as 'view' | 'command' | 'form' | 'event';
        const record = object(entry, step, kind === 'form' ? ['form', 'step'] : [kind]);
        const name = record[kind];
        if (typeof name !== 'string' || !NAME.test(name) || FORBIDDEN.has(name)) throw new Error(`${step} ${kind} is not a name.`);
        if (record.step !== undefined && (typeof record.step !== 'string' || !NAME.test(record.step)))
          throw new Error(`${step} step is not a name.`);
        return Object.freeze(
          kind === 'form' ? { form: name, ...(record.step === undefined ? {} : { step: record.step as string }) } : { [kind]: name },
        ) as AnalyticsStep;
      });
      funnels[id] = Object.freeze({
        unit: funnel.unit,
        conversionWindow: (funnel.conversionWindow as string).trim(),
        steps: Object.freeze(steps),
      });
    }
  }
  return Object.freeze({
    ...(collect ? { collect: Object.freeze(collect) } : {}),
    ...(events ? { events: Object.freeze(events) } : {}),
    ...(funnels ? { funnels: Object.freeze(funnels) } : {}),
  });
}

/** The beacon's path, after the App's mount. Reserved: no App id or view starts with an underscore. */
export const ANALYTICS_BEACON_PATH = '/_mistri/analytics';

/** What a funnel's steps name, read off the parsed App: views and pages, the commands actions and forms run, forms and their steps. */
export function analyticsCatalog(app: AppDef, pages: ReadonlyArray<{ id: string }> = []): AnalyticsCatalog {
  const views = new Set<string>(pages.map((page) => page.id)),
    commands = new Set<string>();
  const forms = new Map<string, readonly string[]>();
  for (const [key, view] of Object.entries(app.views)) {
    if (isFormView(view)) {
      forms.set(
        key,
        (view.steps ?? []).map((step) => step.id),
      );
      commands.add(view.command.id);
      for (const step of view.steps ?? []) if (step.command) commands.add(step.command.id);
    } else views.add(key);
  }
  // The landing is kept apart from the views, and it is the first step of most funnels.
  if (app.landing) views.add(app.landing.view);
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (resource.form)
      forms.set(
        name,
        (resource.form.steps ?? []).map((step) => step.id),
      );
    for (const action of resource.actions ?? []) if ('command' in action && action.command) commands.add(action.command.id);
  }
  return { views, commands, forms };
}

/** What the references of a funnel are checked against. */
export interface AnalyticsCatalog {
  /** Every list or dashboard view key, the landing's, and every page id. */
  readonly views: ReadonlySet<string>;
  /** The command ids an action or a form runs: what the server sees at admission. */
  readonly commands: ReadonlySet<string>;
  /** A form's id (a form view key or a resource with a New form) to its step ids. */
  readonly forms: ReadonlyMap<string, readonly string[]>;
  /** The names `defineEvent` issued, when the caller can see them; absent, a business event is not judged. */
  readonly businessEvents?: ReadonlySet<string>;
}

/** The step's kind, and the built-in kind it needs collected. */
export const stepKind = (step: AnalyticsStep): 'view' | 'command' | 'form' | 'event' =>
  'view' in step ? 'view' : 'command' in step ? 'command' : 'form' in step ? 'form' : 'event';
const COLLECTS = { view: 'views', command: 'commands', form: 'forms' } as const;

/** Every problem a declaration has against the App it belongs to, each ending in its finding code. */
export function analyticsProblems(declaration: AnalyticsDeclaration, catalog: AnalyticsCatalog, where: string): string[] {
  const problems: string[] = [];
  const custom = Object.keys(declaration.events ?? {});
  for (const name of custom) {
    if (catalog.businessEvents?.has(name)) {
      problems.push(
        `${where}: analytics events "${name}" is also a business event of this App. Custom and business events share one namespace: rename the custom one. [analytics-name-clash]`,
      );
    }
  }
  for (const [id, funnel] of Object.entries(declaration.funnels ?? {})) {
    funnel.steps.forEach((step, index) => {
      const here = `${where}: analytics funnel "${id}" step ${index + 1}`;
      const kind = stepKind(step);
      let known = true;
      if ('view' in step) known = catalog.views.has(step.view);
      else if ('command' in step) known = catalog.commands.has(step.command);
      else if ('form' in step) {
        const steps = catalog.forms.get(step.form);
        known = !!steps && (step.step === undefined || steps.includes(step.step));
      } else known = custom.includes(step.event) || !catalog.businessEvents || catalog.businessEvents.has(step.event);
      if (!known) {
        problems.push(
          `${here} names ${kind} "${(step as Record<string, string>)[kind]}${'step' in step && step.step ? `", step "${step.step}` : ''}", which this App does not declare. [analytics-unknown-step]`,
        );
        return;
      }
      if (kind !== 'event' && !declaration.collect?.includes(COLLECTS[kind])) {
        problems.push(
          `${here} counts ${kind}s, and analytics.collect does not list "${COLLECTS[kind]}", so none is recorded. [analytics-not-collected]`,
        );
      }
    });
  }
  return problems;
}
