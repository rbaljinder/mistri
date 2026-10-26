/**
 * `mistri explain <check-code>`: one screen on one code — where it comes
 * from, what it means and the fix — read from the check-codes page the
 * package ships, so the command and the documentation cannot disagree.
 * An unknown code lists the nearest ones.
 */
import { codeRows, type CodeRow } from './checkCodes.js';

const EXPLAIN_USAGE = 'mistri explain <check-code>   e.g. mistri explain unknown-column';

/** Edit distance, for "did you mean"; codes are short. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

export function nearestCodes(wanted: string, codes: readonly string[], limit = 5): string[] {
  return [...codes]
    .map((code) => ({ code, score: code.includes(wanted) || wanted.includes(code) ? 0 : distance(wanted, code) }))
    .sort((a, b) => a.score - b.score || a.code.localeCompare(b.code))
    .slice(0, limit)
    .map((entry) => entry.code);
}

export function explainCode(given: string): { text: string; found: boolean } {
  const wanted = given
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const all = codeRows();
  /* tsc's own codes are the typecheck step's: its row says what to do with them. */
  const rows: CodeRow[] = /^ts\d+$/.test(wanted) ? all.filter((row) => row.code === 'typecheck') : all.filter((row) => row.code === wanted);
  if (!rows.length) {
    const known = [...new Set(all.map((row) => row.code))];
    return {
      found: false,
      text:
        `mistri explain: "${given}" is not a check code.${known.length ? ` Nearest: ${nearestCodes(wanted, known).join(', ')}.` : ''}\n` +
        'mistri docs check-codes lists every code.\n',
    };
  }
  const lines = [`${given}${/^ts\d+$/.test(wanted) ? ' (a TypeScript error, the typecheck step)' : ''}`];
  for (const row of rows) {
    lines.push('', `${row.where}${rows.length > 1 ? `: ${row.means}` : ''}`, ...(rows.length > 1 ? [] : [row.means]), `fix: ${row.fix}`);
  }
  lines.push(
    '',
    `mistri docs ${rows[0].topic}   https://mistriwork.dev/docs/${rows[0].topic === 'design' ? 'design-lint' : rows[0].topic}/#${wanted}`,
  );
  return { found: true, text: `${lines.join('\n')}\n` };
}

/** `mistri explain …`, as the command line runs it. Returns the exit code. */
export function runExplain(
  argv: string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
  warn: (text: string) => void = (text) => process.stderr.write(text),
): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(
      `${EXPLAIN_USAGE}\n\nWhat a check code means and how to fix it, from the shipped check-codes page. Codes are the ones mistri check --json and --brief print.\n`,
    );
    return 0;
  }
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    warn(`mistri explain: name one check code. ${EXPLAIN_USAGE}\n`);
    return 1;
  }
  const { text, found } = explainCode(argv[0]);
  (found ? write : warn)(text);
  return found ? 0 : 1;
}
