/**
 * The path a shown column's second line reads, or undefined for none. A
 * rule's `subtitle` names a column of the table the value was read from, so
 * `employee_id.name` shown on a timesheet reads `employee_id.title` — the
 * employee's title, never the timesheet's own column of that name. Its own
 * module: the cell draws it (client valueModel.ts) and a list's question
 * fetches it (listQuestion.ts), and a public page's cells carry nothing else.
 */
export function subtitlePath(rule: { subtitle?: string } | null | undefined, column: string): string | undefined {
  if (!rule?.subtitle) return undefined;
  const hop = column.lastIndexOf('.');
  return hop < 0 ? rule.subtitle : `${column.slice(0, hop + 1)}${rule.subtitle}`;
}

/**
 * The path a shown column's lead icon reads its tone from, or undefined for
 * none: like a second line, a column of the table the value was read from.
 */
export function leadTonePath(rule: { icon?: { toneOf?: string } } | null | undefined, column: string): string | undefined {
  if (!rule?.icon?.toneOf) return undefined;
  const hop = column.lastIndexOf('.');
  return hop < 0 ? rule.icon.toneOf : `${column.slice(0, hop + 1)}${rule.icon.toneOf}`;
}
