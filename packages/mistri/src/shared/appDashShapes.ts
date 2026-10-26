/**
 * What a dashboard's sections and layout are judged by, apart from the figures themselves: the conditions a query may
 * hold, a chart's and a breakdown's shapes, a funnel's stages, a note's banner and the grid a layout places sections
 * on. Parsed here, beside the dashboard parser that calls them (appViews.ts), which had grown past a screen of seams.
 */
import { splitClauseTail } from '@mistriwork/engine/shared/query.js';
import { FUNNEL_MAX_STAGES, FUNNEL_MIN_STAGES, type FunnelStage } from '@mistriwork/engine/shared/funnel.js';
import { type AppDashSection } from './appModel.js';
import { allowKeys, isRecord, optionalText } from '@mistriwork/engine/shared/model.js';
import type { ParsedData } from './appResourceBlocks.js';
import { layoutAreas, layoutGrid, layoutProblems, nearestArea } from '@mistriwork/engine/shared/dashLayout.js';
import { AppProblems } from './appProblems.js';

/**
 * A query an author writes in the DSL holds conditions and nothing else: the
 * order is a `sort`, the columns a `show`, the count a `limit`, each said where
 * it belongs and checked there. (The query bar still takes all of them in one
 * line, and an address carries them so; that is a reader's, not a declaration.)
 */
export function conditionsOnly(text: string, at: string, key = 'query'): void {
  const { tail } = splitClauseTail(text);
  const clause = /^(sort|order\s+by|show|select|limit)\b/i
    .exec(tail)?.[1]
    ?.toLowerCase()
    .replace(/\s+by$/, '');
  if (!clause) return;
  const word = clause === 'order' ? 'sort' : clause === 'select' ? 'show' : clause;
  throw new Error(
    `${at} has a "${key}" with a ${word} clause ("${tail}"). A ${key} holds conditions only: say it in "${word}"` +
      `${word === 'sort' ? ', which a tab takes too' : ''}.`,
  );
}

/**
 * A dashboard's `areas` against the sections it places, every refusal in one throw. A template is judged for its
 * shape first (dashLayout.ts); the sections are judged against it only once it is sound, since a refusal of the
 * template would be restated by every section it left unplaced.
 */
export function parseAreas(raw: unknown, at: string, sections: AppDashSection[], hasAside: boolean): string[] | undefined {
  const stray = sections.filter((section) => section.area !== undefined);
  if (raw === undefined) {
    if (stray.length)
      throw new Error(`${at}, section ${sections.indexOf(stray[0]!) + 1} has an "area", and the dashboard has no "areas" to place it in.`);
    return undefined;
  }
  const problems = layoutProblems(raw, at);
  if (hasAside) problems.push(`${at} has "areas" and an "aside". The areas place every section, a side column included: remove the aside.`);
  if (problems.length) throw new AppProblems(problems);
  const layout = (raw as string[]).map((row) => row.trim().split(/\s+/).join(' '));
  const areas = layoutAreas(layoutGrid(layout));
  const placed = sections.flatMap((section, i) => (section.kind === 'firstRun' ? [] : [{ section, i }]));
  const unplaced = placed.filter(({ section }) => section.area === undefined);
  if (unplaced.length) {
    problems.push(
      `${at}, "areas": every section names the "area" it stands in. Without one: ${unplaced
        .map(({ section, i }) => `section ${i + 1}${section.title ? ` ("${section.title}")` : ''}`)
        .join(', ')}. The areas: ${areas.join(', ')}.`,
    );
  }
  for (const { section, i } of placed) {
    if (section.area === undefined || areas.includes(section.area)) continue;
    const near = nearestArea(section.area, areas);
    problems.push(
      `${at}, section ${i + 1} stands in "${section.area}", which "areas" does not have.${near ? ` Did you mean "${near}"?` : ''} The areas: ${areas.join(', ')}.`,
    );
  }
  for (const name of areas) {
    if (!placed.some(({ section }) => section.area === name))
      problems.push(`${at}, "areas": "${name}" is empty. Place a section in it, or replace it with . in "areas".`);
  }
  if (problems.length) throw new AppProblems(problems);
  return layout;
}

/**
 * What the dashboard's own chart shapes ask of a chart's grouping: a heat map
 * crosses two keys, the rest one; a scatter's dots are placed by two
 * measures, `x` across and `measure` up, and only a scatter has an `x`; and
 * none of them has a scale a target or a donut's total could be ruled on.
 */
export function parseChartShape(s: Record<string, unknown>, here: string): void {
  const shape = s.shape as string | undefined;
  const keys = typeof s.by === 'string' ? s.by.split(',').filter((key) => key.trim()).length : 0;
  if (s.x !== undefined && shape !== 'scatter')
    throw new Error(`${here} has an "x", which places a scatter's dots across; add shape: 'scatter' or leave "x" out.`);
  if (shape === 'scatter' && (typeof s.x !== 'string' || !s.x.trim()))
    throw new Error(`${here} is a scatter and needs an "x": the measure that places each dot across ("count", "sum amount").`);
  if (shape === 'heatmap' && keys !== 2)
    throw new Error(
      `${here} is a heat map and needs a two-key "by" — "weekday created_at, hour created_at": rows by the first, columns by the second.`,
    );
  if ((shape === 'scatter' || shape === 'waterfall' || shape === 'treemap') && keys > 1)
    throw new Error(`${here} is a ${shape} and groups by one key; "${String(s.by).trim()}" has ${keys}.`);
  if (s.target !== undefined && ['scatter', 'heatmap', 'treemap'].includes(shape ?? ''))
    throw new Error(`${here} is a ${shape}, which has no scale to rule a "target" on. Use a line, bars or a waterfall.`);
}

/**
 * A funnel's stages: two to eight, each a label and the conditions a row holds to be at it. The first is every row the
 * section holds, so it cannot be a side road. The conditions are the section's own language (`conditionsOnly`), and a
 * segment is a word in it. Every problem is told at once, since one stage's typo hides the next one's.
 */
/* Renamed before 1.0: a stage's words are a label, as a step's, a tab's and a choice's are ("title" heads a section). */
const STAGE_RENAMED = { title: 'is now "label": the stage as a reader says it' };

export function parseFunnelStages(s: Record<string, unknown>, here: string): FunnelStage[] {
  if (!Array.isArray(s.stages) || s.stages.length < FUNNEL_MIN_STAGES || s.stages.length > FUNNEL_MAX_STAGES) {
    throw new Error(
      `${here} is a funnel and needs "stages": ${FUNNEL_MIN_STAGES} to ${FUNNEL_MAX_STAGES} of them, in order, like [{ label: 'Started' }, { label: 'Submitted', query: 'submitted_at is not empty' }].`,
    );
  }
  const problems: string[] = [];
  const labels = new Set<string>();
  const stages = s.stages.map((raw, i): FunnelStage => {
    const at = `${here}, stage ${i + 1}`;
    const stage = raw as Record<string, unknown>;
    if (!isRecord(raw)) {
      problems.push(`${at} is not an object with a "label" and a "query".`);
      return { label: '' };
    }
    try {
      allowKeys(raw, ['label', 'query', 'optional'], at, STAGE_RENAMED);
      const label = optionalText(raw, 'label', at);
      if (!label) throw new Error(`${at} needs a "label": the stage as a reader says it, like "Submitted".`);
      if (labels.has(label.toLowerCase())) throw new Error(`${at} repeats the label "${label}". Each stage is told apart by its label.`);
      labels.add(label.toLowerCase());
      if (stage.query !== undefined && (typeof stage.query !== 'string' || !stage.query.trim()))
        throw new Error(`${at} has a "query" that is not a non-empty string.`);
      if (stage.optional !== undefined && typeof stage.optional !== 'boolean')
        throw new Error(`${at} has an "optional" that is not true or false.`);
      if (i === 0 && stage.optional)
        throw new Error(`${at} is optional, and the first stage is every row the funnel holds: it cannot be a side road.`);
      if (typeof stage.query === 'string') conditionsOnly(stage.query, at, 'query');
      return {
        label,
        ...(typeof stage.query === 'string' ? { query: stage.query.trim() } : {}),
        ...(stage.optional ? { optional: true as const } : {}),
      };
    } catch (error) {
      problems.push((error as Error).message);
      return { label: '' };
    }
  });
  if (problems.length) throw new AppProblems(problems);
  return stages;
}

/** A breakdown drawn as steps: a card per value of one column, in the column's order. A bucketed `by` ("month
    opened_on") has no order of its own to step through, so steps take a column; a step's note names one of its values. */
export function parseStepsShape(s: Record<string, unknown>, here: string): void {
  if (s.shape !== undefined && s.shape !== 'bars' && s.shape !== 'steps')
    throw new Error(`${here} has a "shape" of "${String(s.shape)}". A breakdown is "bars" (the default) or "steps".`);
  if (s.shape === 'steps' && typeof s.by === 'string' && /\s|,/.test(s.by.trim()))
    throw new Error(`${here} draws steps by "${s.by.trim()}". Steps follow one column's values in its order: name the column alone.`);
  if (s.notes === undefined) return;
  if (s.shape !== 'steps') throw new Error(`${here} has "notes", which only a breakdown drawn as steps carries: add shape: 'steps'.`);
  const notes = s.notes as Record<string, unknown>;
  if (!notes || typeof notes !== 'object' || Array.isArray(notes) || Object.keys(notes).length > 12)
    throw new Error(`${here} has "notes" that is not a map of at most 12 values to a line each: { received: 'Waiting to be picked' }.`);
  for (const [value, note] of Object.entries(notes))
    if (typeof note !== 'string' || !note.trim() || note.trim().length > 80)
      throw new Error(`${here} has a note for "${value}" that is not a line of 1 to 80 characters.`);
}

/** A note as the dashboard's banner: its tag and picture belong to the banner alone, and a banner says what it
    introduces in a title. The picture is a row of a file resource; whether the reader may see it is the file route's. */
export function parseNoteBanner(
  s: Record<string, unknown>,
  here: string,
  data: ParsedData,
): Pick<AppDashSection, 'variant' | 'eyebrow' | 'image'> {
  if (s.variant === undefined) {
    for (const key of ['eyebrow', 'image'])
      if (s[key] !== undefined) throw new Error(`${here} has an "${key}", which only a banner carries: add variant: 'banner'.`);
    return {};
  }
  if (s.variant !== 'banner') throw new Error(`${here} has a "variant" of "${String(s.variant)}". A dashboard's note takes 'banner'.`);
  if (typeof s.title !== 'string' || !s.title.trim()) throw new Error(`${here} is a banner and has no "title": say what it introduces.`);
  const out: Pick<AppDashSection, 'variant' | 'eyebrow' | 'image'> = {
    variant: 'banner',
  };
  if (s.eyebrow !== undefined) {
    if (typeof s.eyebrow !== 'string' || !s.eyebrow.trim() || s.eyebrow.trim().length > 40)
      throw new Error(`${here} has an "eyebrow" that is not a short tag: 1 to 40 characters.`);
    out.eyebrow = s.eyebrow.trim();
  }
  if (s.image !== undefined) {
    const at = `${here}, "image"`;
    const image = s.image as Record<string, unknown>;
    if (!image || typeof image !== 'object' || Array.isArray(image)) throw new Error(`${at} must be { from, key, alt }.`);
    for (const key of Object.keys(image))
      if (!['from', 'key', 'alt'].includes(key)) throw new Error(`${at} has no "${key}". It takes: from, key, alt.`);
    const from = typeof image.from === 'string' ? image.from.trim() : '';
    const files = Object.entries(data.resources ?? {})
      .filter(([, resource]) => resource.file)
      .map(([name]) => name);
    if (!files.includes(from))
      throw new Error(
        `${at} takes its picture from "${String(image.from)}", which is not a resource of files. ` +
          (files.length ? `Such resources: ${files.join(', ')}.` : 'This App has none: declare "file" on a resource.'),
      );
    const key = image.key;
    if (!((typeof key === 'string' && key.trim()) || (typeof key === 'number' && Number.isFinite(key))))
      throw new Error(`${at} needs a "key": the record key of the row that holds the picture, like 1.`);
    if (typeof image.alt !== 'string' || !image.alt.trim() || image.alt.trim().length > 200)
      throw new Error(`${at} needs an "alt": what the picture shows, 1 to 200 characters.`);
    out.image = {
      from,
      key: typeof key === 'string' ? key.trim() : key,
      alt: image.alt.trim(),
    };
  }
  return out;
}
