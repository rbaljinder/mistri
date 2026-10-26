/**
 * What the shape says about itself.
 *
 * Everything here is a fact tablewalk already holds — the tables, the keys,
 * the indexes' leading columns, the delete rules — asked a different
 * question: not "what is this" but "what will this cost the person who has
 * to work with it". A foreign key with no index behind it is the reverse
 * walk this whole tool is built on, run as a full scan every time. A table
 * with no primary key is a row nobody can edit or link to. Neither is
 * visible while browsing, because browsing a small table hides both.
 *
 * Deliberately narrow. Every rule is checkable from the catalog with no
 * queries and no heuristics about intent, and each one names the consequence
 * rather than the rule — "a schema lint that only cites style" is a lint
 * people turn off. Anything requiring judgement about the domain (a column
 * that should have been an enum, a table that should have been two) is left
 * out on purpose: it would be guessing, and guessing at scale is noise.
 */
import { primaryKey, referencesFrom, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  rule: string;
  severity: Severity;
  table: string;
  columns?: string[];
  /** What is true of *this* table: the specific statement. */
  message: string;
  /**
   * What it costs, which is a property of the rule rather than of the
   * finding.
   *
   * Split apart because they repeat differently. The statement is different
   * every time — a different column, a different target — and the
   * consequence is identical for every finding of the same rule. Repeating
   * the consequence on all seventeen made a list nobody reads past the
   * third line, and dropping it would leave a rule name doing the
   * explaining, which is what "a lint that only cites style" means.
   */
  why: string;
}

/** The cost of each rule, said once. */
const WHY: Record<string, string> = {
  'no-primary-key': 'No row here can be linked to, edited or deleted by this tool, and nothing else can point at it either.',
  'unindexed-foreign-key': 'Every walk back from the referenced table scans this whole table, and so does deleting a referenced row.',
  'no-delete-rule':
    'Deleting a parent fails at the moment someone tries it rather than saying what it would do. Restrict, cascade or set null states the intent.',
  'timestamp-without-zone':
    'The same stored text is a different instant to a reader in another zone, and nothing records which one wrote it.',
  'unreferenced-table':
    'It cannot be reached by walking, only by naming it — either a lookup nobody wired up, or something meant to stand alone.',
};

/** `timestamp` without a zone: the same text means a different instant per reader. */
const NAIVE_TIMESTAMP = /^timestamp( without time zone)?$/i;

interface LintOptions {
  /** Rules to leave out, by name. */
  skip?: string[];
}

export function lintSchema(schema: DatabaseSchema, options: LintOptions = {}): Finding[] {
  const skip = new Set(options.skip ?? []);
  const findings: Finding[] = [];
  const add = (finding: Finding) => {
    if (!skip.has(finding.rule)) findings.push(finding);
  };

  for (const table of schema.tables) {
    /* A view has no key, no index and no delete rule by definition, and
       saying so about each one would bury the tables that can be fixed. */
    if (table.isView) continue;

    if (!primaryKey(table).length) {
      add({
        rule: 'no-primary-key',
        severity: 'high',
        table: table.id,
        message: `${table.name} has no primary key.`,
        why: WHY['no-primary-key'],
      });
    }

    for (const fk of referencesFrom(schema, table.id)) {
      const lead = fk.from.columns[0];
      /* `indexed` carries only each index's *leading* column, which is
         exactly the question here: an index on (a, b) makes a lookup by `a`
         free and does nothing for a lookup by `b` alone. Absent means the
         adapter does not report indexes — that is "we did not look", not
         "there are none", so it is not a finding. */
      if (table.indexed && !table.indexed.includes(lead)) {
        add({
          rule: 'unindexed-foreign-key',
          severity: 'high',
          table: table.id,
          columns: fk.from.columns,
          message: `${lead} → ${fk.to.table}, with no index leading on ${lead}.`,
          why: WHY['unindexed-foreign-key'],
        });
      }

      if (!fk.onDelete || /^no action$/i.test(fk.onDelete)) {
        add({
          rule: 'no-delete-rule',
          severity: 'medium',
          table: table.id,
          columns: fk.from.columns,
          message: `${fk.from.columns.join(', ')} → ${fk.to.table}, with no ON DELETE rule.`,
          why: WHY['no-delete-rule'],
        });
      }
    }

    for (const column of table.columns) {
      if (NAIVE_TIMESTAMP.test(column.type)) {
        add({
          rule: 'timestamp-without-zone',
          severity: 'medium',
          table: table.id,
          columns: [column.name],
          message: `${column.name} is a timestamp with no time zone.`,
          why: WHY['timestamp-without-zone'],
        });
      }
    }
  }

  /* Islands last, and low: a table nothing points at and which points at
     nothing is sometimes a lookup nobody wired up, and sometimes a log
     that is meant to stand alone. Worth seeing, not worth alarming about. */
  for (const table of schema.tables) {
    if (table.isView) continue;
    if (referencesFrom(schema, table.id).length) continue;
    if (schema.foreignKeys.some((fk) => fk.to.table === table.id)) continue;
    add({
      rule: 'unreferenced-table',
      severity: 'low',
      table: table.id,
      message: `Nothing points at ${table.name} and it points at nothing.`,
      why: WHY['unreferenced-table'],
    });
  }

  return findings;
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Findings as a person reads them: worst first, grouped under their table. */
export function lintReport(findings: Finding[]): string {
  if (!findings.length) return 'Nothing to report: no missing keys, unindexed references or naive timestamps.';

  /* By table, then by severity within it. Sorting the other way round splits
     every table across three places in the document, and a schema is read
     one table at a time. */
  const sorted = [...findings].sort((a, b) => a.table.localeCompare(b.table) || ORDER[a.severity] - ORDER[b.severity]);
  const counts = lintCounts(findings);
  const lines: string[] = [
    `${findings.length} finding${findings.length === 1 ? '' : 's'}: ` + `${counts.high} high, ${counts.medium} medium, ${counts.low} low.`,
  ];
  let table = '';
  for (const finding of sorted) {
    if (finding.table !== table) {
      table = finding.table;
      lines.push('', `## ${table}`, '');
    }
    lines.push(`- **${finding.severity}** ${finding.rule} — ${finding.message}`);
  }

  /* The costs once, at the end, rather than on every line. Seventeen
     identical sentences is a list nobody reads past the third one. */
  const rules = [...new Set(sorted.map((f) => f.rule))].sort();
  lines.push('', '## Why these matter', '');
  for (const rule of rules) lines.push(`- **${rule}** — ${WHY[rule] ?? ''}`);

  return lines.join('\n').trim();
}

/** How many of each, for a caller deciding whether to fail a build. */
export function lintCounts(findings: Finding[]): Record<Severity, number> {
  return {
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
  };
}
