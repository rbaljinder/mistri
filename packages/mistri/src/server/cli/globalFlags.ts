/**
 * The flags that name what a command works on (`--config`, `--app`, `--db`, `--schema`), typed before the command:
 * `mistri --config x.json schema --brief`. A command is read from the first word, so these were taken for a start's
 * flags and the command's own (`--brief`) for an unknown option. They are moved behind the command word they
 * precede, where every command reads them.
 */

const VALUE_FLAGS: ReadonlySet<string> = new Set(['--config', '--app', '--db', '--schema']);

/**
 * `argv` (the process's, with the script at 1) with leading global flags moved after the command that follows them,
 * or as it was when no command follows. A word that is a file here is a database to open, not a command.
 */
export function globalsAfterCommand(argv: readonly string[], commands: ReadonlySet<string>, isFile: (word: string) => boolean): string[] {
  let at = 2;
  while (at < argv.length) {
    const arg = argv[at];
    if (VALUE_FLAGS.has(arg)) at += 2;
    else if (/^--(config|app|db|schema)=/.test(arg)) at += 1;
    else break;
  }
  const word = argv[at];
  if (at === 2 || word === undefined || !commands.has(word) || isFile(word)) return [...argv];
  return [...argv.slice(0, 2), word, ...argv.slice(at + 1), ...argv.slice(2, at)];
}
