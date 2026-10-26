/**
 * The display rules served against one connection's schema (split from
 * app.ts): each resource's declared rules over the conventions, re-keyed to
 * resolved table ids, with the references a rule makes — a signature's file
 * resource, a rich text column's people and pictures, an avatar's photos —
 * checked against what this catalog holds.
 */
import { declaredDisplayOf, effectiveDisplay } from '@mistriwork/engine/shared/displayDefaults.js';
import {
  columnKind,
  columnOrRollup,
  isFlagColumn,
  tableNamed,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
import { mentionSourceProblem } from '@mistriwork/engine/shared/mentionLabel.js';
import { appFileRules } from './appResourceRules.js';
import type { AppDef, AppDisplayRule } from './appModel.js';

/**
 * The display rules against one connection's schema: keys re-addressed to
 * resolved table ids (what every client lookup runs on), rules whose
 * table or column this connection lacks carried as warnings rather than
 * served — a rule that can never match is a typo, and typos get named.
 * Each rule is declared on its column inside its resource's block; the
 * served key stays "table.column", with the table's resolved id.
 */
export function resolveDisplay(app: AppDef, schema: DatabaseSchema): { display: Record<string, AppDisplayRule>; warnings: string[] } {
  const display: Record<string, AppDisplayRule> = {};
  const warnings: string[] = [];
  /* Each declared rule over the conventions it leaves standing, and the conventions the App did not mention
     (displayDefaults.ts): a `price` is money without being told. */
  const declaredOf = declaredDisplayOf(app, schema);
  const declared = Object.entries(app.resources ?? {}).flatMap(([resource, { display: rules, machine }]) => {
    const table = tableNamed(schema, resource);
    const drawn = table ? effectiveDisplay(rules, table, { machine, schema, served: true, declared: declaredOf }) : rules;
    return Object.entries(drawn ?? {}).map(([column, rule]) => ({ tableName: resource, column, rule }));
  });
  for (const entry of declared) {
    const { tableName, column } = entry;
    let { rule } = entry;
    const key = `${tableName}.${column}`;
    const table = tableNamed(schema, tableName);
    /* The words a value component's `label` gave this column (server/app/valueLabels.ts): under the inferred words,
       over nothing the author said, because an authored `values` key is the author's word for that value. */
    const labelled = app.valueLabels?.[key];
    if (labelled && rule.component)
      rule = {
        ...rule,
        values: { ...rule.values, ...labelled, ...app.resources?.[tableName]?.display?.[column]?.values },
        humanize: true,
      };
    if (!table) {
      warnings.push(`display "${key}": no table "${tableName}" on this connection.`);
      continue;
    }
    /* A rollup or a computed column dresses like a column: a sum of amounts reads as money, an overdue flag takes a tone. */
    if (!columnOrRollup(table, column)) {
      warnings.push(`display "${key}": "${table.name}" has no column "${column}".`);
      continue;
    }
    /* Tones try in written order and the first satisfied key wins, so a
       threshold standing after a looser one can never win — {">= 4":
       "warn", ">= 5": "bad"} makes 5 warn. That bit this repo's own
       examples; a documented sharp edge on a config surface is the
       validator's to name. */
    const threshold = (k: string) => {
      const m = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(k);
      return m ? { op: m[1], n: Number(m[2]) } : null;
    };
    const keys = Object.keys(rule.tone ?? {});
    outer: for (let i = 1; i < keys.length; i++) {
      const later = threshold(keys[i]) ?? (Number.isFinite(Number(keys[i])) ? { op: '=', n: Number(keys[i]) } : null);
      if (!later) continue;
      for (const earlierKey of keys.slice(0, i)) {
        const earlier = threshold(earlierKey);
        if (!earlier || (later.op !== '=' && earlier.op[0] !== later.op[0])) continue;
        const up = earlier.op[0] === '>';
        /* Everything the later key admits, the earlier already took. */
        const covered =
          later.op === '='
            ? up
              ? earlier.op === '>'
                ? later.n > earlier.n
                : later.n >= earlier.n
              : earlier.op === '<'
                ? later.n < earlier.n
                : later.n <= earlier.n
            : up
              ? earlier.op === '>' && later.op === '>='
                ? later.n > earlier.n
                : later.n >= earlier.n
              : earlier.op === '<' && later.op === '<='
                ? later.n < earlier.n
                : later.n <= earlier.n;
        if (covered) {
          warnings.push(
            `display "${key}": tone "${keys[i]}" can never win — tones try in written order and ` +
              `"${earlierKey}" is satisfied first. Put the narrower rule before it.`,
          );
          continue outer;
        }
      }
    }
    /* A yes/no is keyed by true and false, which every engine reads alike (SQLite's 1 and 0 included); a key
       written as 1, yes or Y is a value the column never says, so its word or tone is never drawn. */
    const yesNo = table.computed?.[column]
      ? table.computed[column].type === 'boolean'
      : isFlagColumn(table.columns.find((c) => c.name === column));
    if (yesNo)
      for (const [what, map] of [
        ['values', rule.values],
        ['tone', rule.tone],
        ['icons', rule.icons],
      ] as const) {
        const odd = Object.keys(map ?? {}).filter((k) => k !== 'true' && k !== 'false' && k !== '*');
        if (odd.length)
          warnings.push(
            `display "${key}" [boolean-keys]: "${column}" is yes or no, and its ${what} ${odd.length === 1 ? 'key' : 'keys'} ` +
              `${odd.map((k) => `"${k}"`).join(', ')} ${odd.length === 1 ? 'is' : 'are'} never matched. Key it by true and false.`,
          );
      }
    /* A second line names another column of the same record. One this
       catalog lacks (or cannot show this reader) is left out, not the rule. */
    /* A lead icon's tone names another column of the record; one this catalog lacks leaves the square in the accent. */
    if (rule.icon?.toneOf !== undefined && (rule.icon.toneOf === column || !table.columns.some((c) => c.name === rule.icon!.toneOf))) {
      warnings.push(
        `display "${key}": icon toneOf "${rule.icon.toneOf}" is not another column of "${table.name}" here, so the mark keeps the accent.`,
      );
      rule = { ...rule, icon: { mark: rule.icon.mark } };
    }
    /* Minor units are a whole number of cents: a decimal column already holds the figure itself.
       A computed column is typed numeric whatever it adds up, so it is the author's to say. */
    const stored = table.columns.find((c) => c.name === column);
    if (rule.minor && stored && !table.computed?.[column] && !/int|serial/i.test(stored.type)) {
      warnings.push(
        `display "${key}": "${column}" is ${stored.type || 'untyped'}, and minor units are a whole number of cents; ` +
          `keep them in an integer column, or drop "minor" for a decimal money column.`,
      );
    }
    /* Each row's currency is another of the record's columns, holding a code. */
    if (rule.currencyColumn !== undefined) {
      const holder = table.columns.find((c) => c.name === rule.currencyColumn);
      if (!holder || rule.currencyColumn === column || columnKind(holder.type) !== 'text')
        warnings.push(
          `display "${key}": the currency column "${rule.currencyColumn}" is not another text column of "${table.name}" here; ` +
            `name the column each row keeps its ISO 4217 code in.`,
        );
    }
    if (rule.subtitle !== undefined && (rule.subtitle === column || !table.columns.some((c) => c.name === rule.subtitle))) {
      warnings.push(`display "${key}": subtitle "${rule.subtitle}" is not another column of "${table.name}" here, so it is left out.`);
      const { subtitle: _left, ...rest } = rule;
      display[`${table.id}.${column}`] = rest;
      continue;
    }
    display[`${table.id}.${column}`] = withSignature(
      app,
      schema,
      table,
      column,
      key,
      withRichText(app, schema, key, withAvatarPhoto(app, schema, table, key, rule, warnings), warnings),
      warnings,
    );
  }
  return { display, warnings };
}

/**
 * A signature column, against this catalog: the file resource its single
 * column points at, re-addressed to that table's id, which is where the pad
 * keeps the drawing. A column that points at no file resource is the author's
 * mistake, named; the column is then a plain box.
 */
function withSignature(
  app: AppDef,
  schema: DatabaseSchema,
  table: TableMeta,
  column: string,
  key: string,
  rule: AppDisplayRule,
  warnings: string[],
): AppDisplayRule {
  if (!rule.signature) return rule;
  const { signature: _authored, ...rest } = rule;
  const fk = (schema.foreignKeys ?? []).find(
    (candidate) => candidate.from.table === table.id && candidate.from.columns.length === 1 && candidate.from.columns[0] === column,
  );
  if (!fk || !appFileRules(app, schema).rules.has(fk.to.table)) {
    warnings.push(
      `display "${key}": a signature is kept as a file, so "${column}" must point at a resource with "file"; it is a plain box here.`,
    );
    return rest;
  }
  return { ...rest, signature: { table: fk.to.table, key: fk.to.columns[0] } };
}

/**
 * A rich text column's people and pictures, against this catalog: each
 * re-addressed to its resolved id. One this reader's catalog lacks is left
 * out — no @ suggestions, no picture upload — as its rows are; a picture
 * resource that holds no files is the author's typo, named.
 */
function withRichText(app: AppDef, schema: DatabaseSchema, key: string, rule: AppDisplayRule, warnings: string[]): AppDisplayRule {
  if (rule.format !== 'richText' || (!rule.mentions && !rule.images)) return rule;
  const { mentions, images, ...rest } = rule;
  const people = mentions && tableNamed(schema, mentions.from);
  const pictures = images ? tableNamed(schema, images) : undefined;
  if (pictures && !appFileRules(app, schema).rules.has(pictures.id))
    warnings.push(`display "${key}": pictures go to "${images}", which is not a resource whose rows are files; declare "file" on it.`);
  /* A label is a column or a template of the people's own columns ('{first_name} {last_name}'); the first column
     either names that this catalog's table lacks is said by name (mentionLabel.ts). */
  const peopleProblem = people && mentionSourceProblem(mentions, people);
  if (peopleProblem) warnings.push(`display "${key}": mentions ${peopleProblem}`);
  const peopleOk = people && !peopleProblem;
  /* Teams are offered beside the people where this reader's catalog has them; how a person is in one is the
     server's to read (appNotify.ts), so the browser is told only what to list. */
  const said = mentions?.groups;
  const teams = said && tableNamed(schema, said.from);
  const teamsProblem = teams && mentionSourceProblem(said, teams);
  const teamsOk = teams && !teamsProblem;
  const through = said?.through === undefined ? undefined : tableNamed(schema, said.through);
  if (teamsProblem) warnings.push(`display "${key}": mentions.groups ${teamsProblem}`);
  return {
    ...rest,
    ...(people && peopleOk
      ? {
          mentions: {
            from: people.id,
            by: mentions.by,
            ...(mentions.labelColumn === undefined ? {} : { labelColumn: mentions.labelColumn }),
            ...(teams && teamsOk
              ? {
                  groups: {
                    from: teams.id,
                    by: said.by,
                    ...(said.labelColumn === undefined ? {} : { labelColumn: said.labelColumn }),
                    /* The editor offers a team only where a link row names it. */
                    ...(through ? { through: through.id } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(pictures && appFileRules(app, schema).rules.has(pictures.id) ? { images: pictures.id } : {}),
  };
}

/**
 * An avatar's photo, against this catalog: the file resource re-addressed to
 * its resolved id, its `whose` a column of it that points at the rule's own
 * table. Where this catalog cannot read the photos — a reader whose grant
 * leaves out the file resource — the disc is the initials, as it was, and
 * nothing is said: that is the reader's grant working. A photo resource that
 * is not one (no `file`, no column pointing here) is the author's typo, named.
 */
function withAvatarPhoto(
  app: AppDef,
  schema: DatabaseSchema,
  table: TableMeta,
  key: string,
  rule: AppDisplayRule,
  warnings: string[],
): AppDisplayRule {
  const photo = rule.avatar;
  if (!photo || photo === true) return rule;
  const initials = { ...rule, avatar: true as const };
  const from = tableNamed(schema, photo.from);
  if (!from) return initials;
  if (!appFileRules(app, schema).rules.has(from.id)) {
    warnings.push(
      `display "${key}": avatar photos come from "${photo.from}", which is not a resource whose rows are files; declare "file" on it.`,
    );
    return initials;
  }
  const points = schema.foreignKeys.some(
    (fk) => fk.from.table === from.id && fk.to.table === table.id && fk.from.columns.length === 1 && fk.from.columns[0] === photo.whose,
  );
  if (!points) {
    warnings.push(`display "${key}": avatar photos need "${photo.whose}", a column of "${from.name}" that points at "${table.name}".`);
    return initials;
  }
  return { ...rule, avatar: { ...photo, from: from.id } };
}
