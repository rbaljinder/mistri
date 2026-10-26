#!/usr/bin/env node
/**
 * Every recipe value and every type role in words, generated from packages/engine/src/shared/themeRecipeWords.ts.
 *
 * The values were only pictures (the gallery's contact sheets) and an enum: an
 * agent choosing a theme's recipes reads text, and could not tell `ruled` from
 * `soft` without opening an image. This writes each part's sentences into the
 * two places that are read as text — the schema's description of the part
 * (packages/mistri/schema/theme.schema.json, which the DSL reference and an editor show) and
 * the gallery page, under each part's picture. The type roles (themeType.ts)
 * go the same way, the schema's `type.roles` written whole from their rules, so
 * a range said there is the range the compiler holds a theme to.
 *
 *   node scripts/recipe-words.mjs           regenerate both
 *   node scripts/recipe-words.mjs --check   fail if either differs (test/theme-recipe-words.test.ts runs this)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPE_MENU } from '../packages/engine/src/shared/themeRecipes.ts';
import { RECIPE_WORDS, recipeDescription, TYPE_WORDS } from '../packages/engine/src/shared/themeRecipeWords.ts';
import { TYPE_BASES, TYPE_FACES, TYPE_ROLES } from '../packages/engine/src/shared/themeType.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA = join(ROOT, 'packages/mistri/schema/theme.schema.json');
export const GALLERY = join(ROOT, 'site/src/content/docs/docs/theme-recipes.md');

const START = (part) => `<!-- recipe words: ${part} -->`;
const END = '<!-- /recipe words -->';

/** The schema with each recipe part described by its values' words, the rest as it is. */
export function schemaText(text = readFileSync(SCHEMA, 'utf8')) {
  const schema = JSON.parse(text);
  const parts = schema.properties.recipes.properties;
  for (const part of Object.keys(RECIPE_MENU)) {
    const { enum: values, description: _old, ...rest } = parts[part];
    parts[part] = { enum: values, description: recipeDescription(part), ...rest };
  }
  const { base: _base, roles: _roles, ...type } = schema.properties.type.properties;
  schema.properties.type.properties = {
    ...type,
    base: { enum: TYPE_BASES, description: 'The size an App’s text is drawn at; every size grows with it, the roles’ too. Omitted, 13px.' },
    roles: typeRolesSchema(),
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/** `type.roles` as the schema says it: each role with only the properties it takes, in the ranges it is held to. */
function typeRolesSchema() {
  const properties = {};
  for (const [role, rule] of Object.entries(TYPE_ROLES)) {
    const said = {};
    for (const key of rule.takes) {
      if (key === 'face') said.face = { enum: Object.keys(TYPE_FACES) };
      else if (key === 'size')
        said.size = {
          type: 'string',
          pattern: '^\\d{1,2}(?:\\.\\d)?px$',
          description: `${rule.size[0]}px to ${rule.size[1]}px, at the 13px base.`,
        };
      else if (key === 'leading') said.leading = { type: 'number', minimum: rule.leading[0], maximum: rule.leading[1] };
      else if (key === 'tracking')
        said.tracking = { type: 'string', pattern: '^-?(?:0|0?\\.\\d{1,3})em$', description: '-0.03em to 0.15em.' };
      else if (key === 'weight') said.weight = { enum: rule.weights };
      else if (key === 'case') said.case = { enum: ['none', 'upper', 'small-caps'] };
      else if (key === 'reach')
        said.reach = {
          enum: ['values', 'figures'],
          description:
            'values (omitted): every value in the data face; figures: only figures, keys and dates, names in the interface face.',
        };
      else if (key === 'features')
        said.features = {
          type: 'array',
          maxItems: 8,
          uniqueItems: true,
          items: { type: 'string', pattern: '^(?:tnum|lnum|onum|zero|case|ss(?:0[1-9]|1\\d|20)|cv(?:0[1-9]|[1-9]\\d))$' },
        };
    }
    properties[role] = { type: 'object', additionalProperties: false, description: TYPE_WORDS[role], properties: said };
  }
  return {
    type: 'object',
    additionalProperties: false,
    description:
      'Each kind of text by what it is for, saying only what differs from the look. Body, data, label and nav text has no size of its own: it follows type.base.',
    properties,
  };
}

const TYPE_START = '<!-- type words -->';

/** The gallery page with each part's values listed in words under its picture, between markers this rewrites. */
export function galleryText(text = readFileSync(GALLERY, 'utf8')) {
  let page = text;
  for (const part of Object.keys(RECIPE_MENU)) {
    const list = [START(part), '', ...Object.entries(RECIPE_WORDS[part]).map(([value, words]) => `- \`${value}\`: ${words}`), '', END].join(
      '\n',
    );
    const heading = `## \`${part}\`\n`;
    const at = page.indexOf(heading);
    if (at < 0) throw new Error(`${GALLERY} has no section for recipes.${part}`);
    const next = page.indexOf('\n## ', at + heading.length);
    const section = page.slice(at, next < 0 ? page.length : next);
    const marked = section.indexOf(START(part));
    const updated =
      marked >= 0
        ? section.slice(0, marked) + list + section.slice(section.indexOf(END, marked) + END.length)
        : `${section.replace(/\n+$/, '')}\n\n${list}\n`;
    page = page.slice(0, at) + updated + page.slice(at + section.length);
  }
  const start = page.indexOf(TYPE_START);
  if (start < 0) throw new Error(`${GALLERY} has no ${TYPE_START} in its Type section`);
  const list = [TYPE_START, '', ...Object.entries(TYPE_WORDS).map(([role, words]) => `- \`${role}\`: ${words}`), '', END].join('\n');
  page = page.slice(0, start) + list + page.slice(page.indexOf(END, start) + END.length);
  return page;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [file, made] of [
    [SCHEMA, schemaText()],
    [GALLERY, galleryText()],
  ]) {
    if (readFileSync(file, 'utf8') === made) continue;
    if (check) stale.push(file);
    else writeFileSync(file, made);
  }
  if (stale.length) {
    console.error(
      `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} not what node scripts/recipe-words.mjs writes: run it and commit.`,
    );
    process.exit(1);
  }
}
