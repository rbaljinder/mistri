/** Request branding is data, never CSS or authority. The host supplies an
 * already authorized row; this module only validates and compiles its look. */
import {
  FONT_TOKENS,
  PALETTE_TOKENS,
  shapeTokens,
  THEME_BASES,
  themeWarnings,
  type ThemeBase,
  type ThemeDefinition,
  type ThemePalette,
} from '@mistriwork/engine/shared/theme.js';
import { effectiveThemeDefinition, headingWeight, themePreset } from '@mistriwork/engine/shared/themePresets.js';
import { typeTokens } from '@mistriwork/engine/shared/themeType.js';

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const BRANDING_FONT_PAIRS = Object.freeze(['system', 'editorial', 'classic'] as const);
const BRANDING_BAR_STYLES = Object.freeze(['plain', 'brand'] as const);
type BrandingFontPair = (typeof BRANDING_FONT_PAIRS)[number];
type BrandingBarStyle = (typeof BRANDING_BAR_STYLES)[number];
const BRANDING_TEXT_LIMITS = Object.freeze({ name: 120, heading: 240, tagline: 500, hours: 1000, about: 8000 });
type BrandingContentField = keyof typeof BRANDING_TEXT_LIMITS;

/** `key` maps a file resource's primary-key columns to this record's columns.
 * The resulting reference still needs the ordinary file reader's authorization. */
export interface BrandingImageBinding<Column extends string = string> {
  readonly from: string;
  readonly key: Readonly<Record<string, Column>>;
  readonly alt?: string;
}
export type BrandingFields<Column extends string = string> = Readonly<
  Partial<Record<'preset' | 'accent' | 'fontPair' | 'barStyle' | BrandingContentField, Column>> & {
    logo?: BrandingImageBinding<Column>;
    hero?: BrandingImageBinding<Column>;
  }
>;
export interface FromRecordOptions<Column extends string = string> {
  readonly by: 'host' | 'tenant';
  readonly tenantField: Column;
  readonly publishedField?: Column;
  readonly fallback: { readonly preset: ThemeBase };
  readonly fields: BrandingFields<Column>;
}
export interface RecordBrandingSpec<Resource extends string = string, Column extends string = string> extends FromRecordOptions<Column> {
  readonly kind: 'fromRecord';
  readonly from: Resource;
}

/** A deliberately small catalog projection, supplied by the owner from its
 * declared resource catalog. Presence here is a binding check, not a grant. */
export type BrandingColumnKind = 'text' | 'integer' | 'number' | 'boolean';
export interface BrandingCatalog {
  readonly resources: Readonly<
    Record<
      string,
      {
        readonly columns: Readonly<Record<string, BrandingColumnKind>>;
        readonly primaryKey: readonly string[];
        readonly file?: boolean;
      }
    >
  >;
}
export interface BrandingBinding {
  readonly spec: RecordBrandingSpec;
  readonly columns: readonly string[];
  readonly columnKinds: Readonly<Record<string, BrandingColumnKind>>;
  readonly primaryKey: readonly string[];
}
export interface BrandingSourceIdentity {
  readonly deployment: string;
  readonly app: string;
  readonly source: string;
  readonly bindingRevision: string;
  readonly catalogRevision: string;
}
export interface BrandingSelection extends BrandingSourceIdentity {
  readonly tenant: string | null;
}
interface BrandingIdentity extends BrandingSelection {
  readonly recordKey: Readonly<Record<string, string | number>> | null;
  readonly version: string | null;
}
interface BrandingImage {
  readonly from: string;
  readonly key: Readonly<Record<string, string | number>>;
  readonly alt?: string;
}
interface BrandingDiagnostic {
  readonly code: 'invalid_record' | 'contrast' | 'unavailable' | 'unpublished' | 'closed';
  readonly message: string;
}
export interface ResolvedBranding {
  readonly status: 'resolved' | 'fallback';
  readonly identity: BrandingIdentity;
  readonly theme: Immutable<ThemeDefinition>;
  readonly tokens: { readonly light: Readonly<Record<string, string>>; readonly dark: Readonly<Record<string, string>> };
  readonly barStyle: BrandingBarStyle;
  readonly content: Readonly<Partial<Record<BrandingContentField, string>>>;
  readonly images: { readonly logo?: BrandingImage; readonly hero?: BrandingImage };
  /** A tenant's own logo (tenantBranding.ts): an address on the App's origin, by content hash. */
  readonly mark?: { readonly src: string; readonly dark?: string };
  readonly diagnostics: readonly BrandingDiagnostic[];
}

function freeze<T>(value: T): Immutable<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
function object(raw: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
    throw new Error('Branding requires plain data objects.');
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (
      typeof key !== 'string' ||
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      (keys && !keys.includes(key)) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      throw new Error('Invalid branding property.');
    out[key] = descriptor.value;
  }
  return out;
}
function name(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(raw) || ['__proto__', 'prototype', 'constructor'].includes(raw))
    throw new Error('Invalid branding resource or column.');
  return raw;
}
function choice<T extends string>(raw: unknown, choices: readonly T[]): T {
  if (typeof raw !== 'string' || !choices.includes(raw as T)) throw new Error('Invalid branding choice.');
  return raw as T;
}
function text(raw: unknown, maximum: number): string {
  // eslint-disable-next-line no-control-regex -- Branding text permits tabs and line breaks, but no other ASCII controls.
  if (typeof raw !== 'string' || !raw.trim() || raw.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) {
    throw new Error('Invalid branding text.');
  }
  return raw.trim();
}
function imageBinding(raw: unknown): BrandingImageBinding {
  const input = object(raw, ['from', 'key', 'alt']);
  const keys = object(input.key);
  if (!Object.keys(keys).length || Object.keys(keys).length > 8) throw new Error('A branding image needs a bounded record key.');
  const key = Object.fromEntries(Object.entries(keys).map(([target, column]) => [name(target), name(column)]));
  return { from: name(input.from), key, ...(input.alt === undefined ? {} : { alt: text(input.alt, 240) }) };
}

/* Spellings renamed before 1.0: the look is a `preset` and the brand color the `accent`, as `ui.theme` says them.
   Named here, before the strict reader's generic refusal, so the message says the word that replaced them. */
const RENAMED: Readonly<Record<string, string>> = { base: 'preset', brandColor: 'accent' };
function renamed(raw: unknown, at: string): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [old, now] of Object.entries(RENAMED)) {
    if (Object.hasOwn(raw, old)) throw new Error(`fromRecord ${at} has "${old}", which is now "${now}".`);
  }
}

/** Strict JSON/parser entry point, also usable by schema integration. */
export function parseRecordBranding(raw: unknown): RecordBrandingSpec {
  const input = object(raw, ['kind', 'from', 'by', 'tenantField', 'publishedField', 'fallback', 'fields']);
  if (input.kind !== 'fromRecord') throw new Error('Expected fromRecord branding.');
  renamed(input.fallback, 'fallback');
  renamed(input.fields, 'fields');
  const fallback = object(input.fallback, ['preset']);
  const fields = object(input.fields, ['preset', 'accent', 'fontPair', 'barStyle', 'logo', 'hero', ...Object.keys(BRANDING_TEXT_LIMITS)]);
  return freeze({
    kind: 'fromRecord',
    from: name(input.from),
    by: choice(input.by, ['host', 'tenant']),
    tenantField: name(input.tenantField),
    ...(input.publishedField === undefined ? {} : { publishedField: name(input.publishedField) }),
    fallback: { preset: choice(fallback.preset, THEME_BASES) },
    fields: Object.fromEntries(
      Object.entries(fields).map(([field, column]) => [field, field === 'logo' || field === 'hero' ? imageBinding(column) : name(column)]),
    ),
  });
}

/** `ui.messages: fromRecord('<table>', { by: 'tenant', tenantField, fields: { key, locale, text } })`: a tenant's own
 * words over the App's catalogs, one row per message and locale (server/app/recordMessages.ts). */
export interface RecordMessagesSpec {
  readonly kind: 'fromRecord';
  readonly from: string;
  readonly by: 'tenant';
  readonly tenantField: string;
  readonly fields: { readonly key: string; readonly locale: string; readonly text: string };
  /** The App's source catalog, set by the loader (appMessages.ts): what a row is held to on write and on read,
      wherever the definition travels — a tenant host's captured copy too. */
  readonly source?: { readonly locale: string; readonly entries: Readonly<Record<string, string>> };
}

/** The `ui.messages` binding, strict as `parseRecordBranding`: a tenant's table, its tenant column, and the three it reads. */
export function parseRecordMessages(raw: unknown): RecordMessagesSpec {
  const input = object(raw, ['kind', 'from', 'by', 'tenantField', 'fields']);
  if (input.kind !== 'fromRecord') throw new Error('Expected fromRecord(table, { by, tenantField, fields }).');
  if (input.by !== 'tenant') throw new Error('Messages are a tenant\'s own: by: "tenant".');
  const fields = object(input.fields, ['key', 'locale', 'text']);
  for (const field of ['key', 'locale', 'text'])
    if (fields[field] === undefined) throw new Error(`fields.${field} must name a text column.`);
  return freeze({
    kind: 'fromRecord',
    from: name(input.from),
    by: 'tenant',
    tenantField: name(input.tenantField),
    fields: { key: name(fields.key), locale: name(fields.locale), text: name(fields.text) },
  });
}

/** Authoring helper: detached, deeply frozen plain data, with literal resource
 * and column types retained for the DSL's generated reference checks. */
export function fromRecord<const Resource extends string, const Column extends string>(
  from: Resource,
  options: FromRecordOptions<Column>,
): RecordBrandingSpec<Resource, Column> {
  return parseRecordBranding({
    ...object(options, ['by', 'tenantField', 'publishedField', 'fallback', 'fields']),
    kind: 'fromRecord',
    from,
  }) as RecordBrandingSpec<Resource, Column>;
}

/** Verify references against the declared catalog once, before serving. */
export function bindRecordBranding(raw: unknown, catalog: BrandingCatalog): BrandingBinding {
  const spec = parseRecordBranding(raw);
  const resource = Object.hasOwn(catalog.resources, spec.from) ? catalog.resources[spec.from] : undefined;
  if (!resource) throw new Error('Branding resource is not declared.');
  const column = (key: string, kinds: readonly BrandingColumnKind[]) => {
    if (!Object.hasOwn(resource.columns, key) || !kinds.includes(resource.columns[key]))
      throw new Error(`Invalid branding column "${key}".`);
  };
  column(spec.tenantField, ['text']);
  /* The record's `version` column, when it has one, is its version; without one, the fresh-read comparison is. */
  const versioned = Object.hasOwn(resource.columns, 'version');
  if (versioned) column('version', ['integer']);
  if (spec.publishedField) column(spec.publishedField, ['boolean']);
  if (
    !Array.isArray(resource.primaryKey) ||
    !resource.primaryKey.length ||
    resource.primaryKey.length > 8 ||
    new Set(resource.primaryKey).size !== resource.primaryKey.length
  ) {
    throw new Error('Branding resource needs a bounded primary key.');
  }
  const columns = new Set<string>([...resource.primaryKey, spec.tenantField, ...(versioned ? ['version'] : [])]);
  for (const key of resource.primaryKey) column(name(key), ['text', 'integer']);
  if (spec.publishedField) columns.add(spec.publishedField);
  for (const [field, value] of Object.entries(spec.fields)) {
    if (typeof value === 'string') {
      column(value, ['text']);
      columns.add(value);
      continue;
    }
    const image = value as BrandingImageBinding;
    const target = Object.hasOwn(catalog.resources, image.from) ? catalog.resources[image.from] : undefined;
    if (
      target?.file !== true ||
      !Array.isArray(target.primaryKey) ||
      !target.primaryKey.length ||
      new Set(target.primaryKey).size !== target.primaryKey.length ||
      target.primaryKey.length !== Object.keys(image.key).length ||
      target.primaryKey.some((key) => !Object.hasOwn(image.key, key))
    )
      throw new Error(`Branding ${field} needs a declared file resource and its exact key.`);
    for (const [key, source] of Object.entries(image.key)) {
      const kind = target.columns[key];
      if (!Object.hasOwn(target.columns, key) || !['text', 'integer'].includes(kind)) throw new Error('Invalid branding file key type.');
      column(source, [kind]);
      columns.add(source);
    }
  }
  return freeze({
    spec,
    columns: [...columns].sort(),
    columnKinds: Object.fromEntries([...columns].sort().map((key) => [key, resource.columns[key]])),
    primaryKey: [...resource.primaryKey].sort(),
  });
}

export class BrandingValidationError extends Error {
  readonly diagnostics: readonly BrandingDiagnostic[];
  constructor(diagnostics: readonly BrandingDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join('\n'));
    this.name = 'BrandingValidationError';
    this.diagnostics = freeze(diagnostics.map((item) => ({ ...item })));
  }
}
const invalidRecord = (): BrandingValidationError =>
  new BrandingValidationError([{ code: 'invalid_record', message: 'The stored branding is invalid.' }]);
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const FONTS: Record<BrandingFontPair, NonNullable<ThemeDefinition['fonts']>> = {
  system: { ui: SANS, data: SANS, heading: SANS },
  editorial: { ui: SANS, data: SANS, heading: 'Georgia, "Times New Roman", serif' },
  classic: { ui: 'Arial, Helvetica, sans-serif', data: 'Arial, Helvetica, sans-serif', heading: 'Georgia, serif' },
};
function mix(color: string, ground: string, weight: number): string {
  return (
    '#' +
    [1, 3, 5]
      .map((at) =>
        Math.round(parseInt(color.slice(at, at + 2), 16) * weight + parseInt(ground.slice(at, at + 2), 16) * (1 - weight))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
function baseTheme(base: ThemeBase): ThemeDefinition {
  const preset = effectiveThemeDefinition(themePreset(base)!, 'default');
  // Variations remain the static App's choice, never the stored brand's surface.
  return {
    id: 'record-brand',
    label: 'Brand',
    base,
    light: { ...preset.light },
    dark: { ...preset.dark },
    fonts: { ...preset.fonts },
    radius: { ...preset.radius },
  };
}
function tokens(theme: ThemeDefinition, palette: ThemePalette): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, token] of Object.entries(PALETTE_TOKENS)) {
    const value = palette[key as keyof ThemePalette];
    if (value !== undefined) result[token] = value;
  }
  for (const [key, token] of Object.entries(FONT_TOKENS)) {
    const value = theme.fonts?.[key as keyof NonNullable<ThemeDefinition['fonts']>];
    if (value !== undefined) result[token] = value;
  }
  Object.assign(result, shapeTokens(theme), typeTokens(theme.type));
  result['--heading-weight'] = String(headingWeight(theme));
  return result;
}
function keyValue(raw: unknown): string | number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return raw;
  // eslint-disable-next-line no-control-regex -- Record identifiers must exclude ASCII controls.
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(raw)) return raw;
  throw invalidRecord();
}
function revision(raw: unknown): string {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw === 'string' && /^(?:0|[1-9][0-9]{0,127})$/.test(raw)) return raw;
  throw invalidRecord();
}
function identity(selection: BrandingSelection, recordKey: BrandingIdentity['recordKey'], version: string | null): BrandingIdentity {
  return {
    deployment: selection.deployment,
    app: selection.app,
    source: selection.source,
    bindingRevision: selection.bindingRevision,
    catalogRevision: selection.catalogRevision,
    tenant: selection.tenant,
    recordKey,
    version,
  };
}
function result(
  status: ResolvedBranding['status'],
  owner: BrandingIdentity,
  theme: ThemeDefinition,
  barStyle: BrandingBarStyle,
  content: ResolvedBranding['content'],
  images: ResolvedBranding['images'],
  diagnostics: readonly BrandingDiagnostic[],
): ResolvedBranding {
  return freeze({
    status,
    identity: owner,
    theme,
    barStyle,
    content,
    images,
    tokens: { light: tokens(theme, theme.light), dark: tokens(theme, theme.dark) },
    diagnostics,
  });
}

/** A fallback never carries any previously read row identity, content or images. */
export function fallbackBranding(
  binding: BrandingBinding,
  selection: BrandingSelection,
  diagnostics: readonly BrandingDiagnostic[] = [],
): ResolvedBranding {
  return result(
    'fallback',
    identity(selection, null, null),
    baseTheme(binding.spec.fallback.preset),
    'plain',
    {},
    {},
    diagnostics.map((item) => ({ ...item })),
  );
}

/** Save-time compiler. Call with the proposed complete row under the command's
 * own scoped target. Throws bounded diagnostics; never includes rejected values. */
export function validateBranding(binding: BrandingBinding, raw: unknown, selection: BrandingSelection): ResolvedBranding {
  try {
    const row = object(raw);
    if (
      !selection.tenant ||
      row[binding.spec.tenantField] !== selection.tenant ||
      binding.columns.some((column) => !Object.hasOwn(row, column))
    )
      throw invalidRecord();
    for (const column of binding.columns) {
      const value = row[column],
        kind = binding.columnKinds[column];
      if (value === null) continue;
      const valid =
        kind === 'text'
          ? typeof value === 'string'
          : kind === 'boolean'
            ? typeof value === 'boolean'
            : kind === 'integer'
              ? (typeof value === 'number' && Number.isSafeInteger(value)) ||
                (typeof value === 'string' && /^-?(?:0|[1-9][0-9]{0,127})$/.test(value))
              : typeof value === 'number' && Number.isFinite(value);
      if (!valid) throw invalidRecord();
    }
    const recordKey = Object.fromEntries(binding.primaryKey.map((key) => [key, keyValue(row[key])]));
    const version = binding.columns.includes('version') ? revision(row.version) : null;
    if (binding.spec.publishedField && typeof row[binding.spec.publishedField] !== 'boolean') throw invalidRecord();
    const read = (field: keyof BrandingFields) => {
      const column = binding.spec.fields[field];
      return typeof column === 'string' ? row[column] : undefined;
    };
    const base = read('preset') == null ? binding.spec.fallback.preset : choice(read('preset'), THEME_BASES);
    const theme = baseTheme(base);
    const color = read('accent');
    if (color != null && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) throw invalidRecord();
    const font = read('fontPair');
    if (font != null) theme.fonts = { ...FONTS[choice(font, BRANDING_FONT_PAIRS)] };
    const barStyle = read('barStyle') == null ? 'plain' : choice(read('barStyle'), BRANDING_BAR_STYLES);
    for (const mode of ['light', 'dark'] as const) {
      const palette = theme[mode];
      if (typeof color === 'string') {
        const accent = mode === 'dark' ? mix(color, '#ffffff', 0.62) : color.toLowerCase();
        /* A brand color must read as text as it is: `accentInk` said, so it is held to it and never derived. */
        Object.assign(palette, { accent, accentInk: accent, link: accent, chart1: accent, accentSoft: mix(accent, palette.surface, 0.14) });
        /* The words a look chose for its own accent fill (Workshop's ink on its orange) read on that fill, not the brand's. */
        delete palette.onAccent;
      }
      // A branded tint preserves every family's search-field ground and ink.
      // The full stored color remains the accent; bar style cannot inject CSS.
      Object.assign(palette, {
        navGround: barStyle === 'brand' ? mix(palette.accent, palette.surface, 0.12) : palette.surface,
        navInk: palette.ink,
        navMuted: palette.inkMuted,
        navAccent: palette.accent,
        navLine: palette.line,
      });
    }
    if (typeof color === 'string') {
      // Start with the existing single-accent derivation. Dark grounds differ
      // by base, so brighten only as far as the shared interaction checks need.
      // Light is never repaired: an unreadable authored color must fail Save.
      /* The dark palette is read here in the light slot, so a light palette's paper (C12) is not its question. */
      const darkWarnings = () => themeWarnings([{ ...theme, light: theme.dark }]).filter((line) => !/ on printed paper /.test(line));
      for (let percent = 60; percent >= 0 && darkWarnings().length; percent -= 2) {
        const accent = mix(color, '#ffffff', percent / 100),
          palette = theme.dark;
        Object.assign(palette, {
          accent,
          accentInk: accent,
          link: accent,
          chart1: accent,
          accentSoft: mix(accent, palette.surface, 0.14),
          navAccent: accent,
          navGround: barStyle === 'brand' ? mix(accent, palette.surface, 0.12) : palette.surface,
        });
      }
    }
    const content: Partial<Record<BrandingContentField, string>> = {};
    for (const field of Object.keys(BRANDING_TEXT_LIMITS) as BrandingContentField[]) {
      const value = read(field);
      if (value != null) content[field] = text(value, BRANDING_TEXT_LIMITS[field]);
    }
    const images: { logo?: BrandingImage; hero?: BrandingImage } = {};
    for (const field of ['logo', 'hero'] as const) {
      const image = binding.spec.fields[field];
      if (!image) continue;
      const entries = Object.entries(image.key).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (entries.every(([, column]) => row[column] === null)) continue;
      images[field] = {
        from: image.from,
        key: Object.fromEntries(entries.map(([key, column]) => [key, keyValue(row[column])])),
        ...(image.alt === undefined ? {} : { alt: image.alt }),
      };
    }
    const diagnostics: BrandingDiagnostic[] = themeWarnings([theme]).map((message) => ({ code: 'contrast', message }));
    if (diagnostics.length) throw new BrandingValidationError(diagnostics);
    return result('resolved', identity(selection, recordKey, version), theme, barStyle, content, images, []);
  } catch (error) {
    throw error instanceof BrandingValidationError ? error : invalidRecord();
  }
}

/** Runtime compiler: a malformed stored look is the clean base, not an error
 * page. Authorization and public publication are the reader owner's concern. */
export function compileBranding(binding: BrandingBinding, row: unknown, selection: BrandingSelection): ResolvedBranding {
  try {
    return validateBranding(binding, row, selection);
  } catch (error) {
    return fallbackBranding(binding, selection, (error as BrandingValidationError).diagnostics);
  }
}

/**
 * A tenant's saved branding as the presentation the shell, the sign-in page and
 * a public form already wear (appTheme.js): its compiled theme, its name and the
 * address of its logo. Only validated values reach here (tenantBranding.ts);
 * the tokens are written from the theme as any branding's are.
 */
export function tenantBrandingPresentation(options: {
  readonly selection: BrandingSelection;
  readonly revision: string;
  readonly theme: ThemeDefinition;
  readonly name?: string;
  readonly mark?: string;
  /** The logo for a dark bar or by night; the mark stands where there is none. */
  readonly darkMark?: string;
}): ResolvedBranding {
  const { selection, revision: version, theme, name: label, mark, darkMark } = options;
  const resolved = result('resolved', identity(selection, null, version), theme, 'plain', label ? { name: label } : {}, {}, []);
  return mark ? freeze({ ...resolved, mark: { src: mark, ...(darkMark ? { dark: darkMark } : {}) } }) : resolved;
}
