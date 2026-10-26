/**
 * A word of the command line that is a command of its own (`tablewalk migrate`, `mistri tenant`), not a
 * database to open, and the one way each main runs one.
 *
 * Each main has a table of them (cli/browserCommands.ts, cli/mistriCommands.ts). They were some twenty-five
 * copied blocks in one `main`, and they failed two ways: some caught a throw and said `tablewalk: …` with exit 1,
 * the rest let it escape as a stack trace. `runSubcommand` is the one way now: a command returns its exit code,
 * and whatever it throws is said in a line, exit 1.
 *
 * A command is read before the flags are, since parseArgs would take its word for a SQLite file, and nothing a
 * start reads — a config, a connection, a server — is its business. A file of that name is still `./migrate`.
 */

interface Subcommand {
  /**
   * Whether these arguments (the ones after the word) are this command's. Absent, the word alone is enough; a
   * word that is a command only with a second word (`theme show`) or a flag (`new --api`) leaves the rest to the
   * start, which opens a SQLite file of that name.
   */
  takes?(argv: readonly string[]): boolean;
  /** The arguments after the word; the exit code, or nothing for 0. */
  run(argv: string[]): Promise<number | void> | number | void;
}

export type Subcommands = Readonly<Record<string, Subcommand>>;

/** The command `argv` (the process's arguments after the script) names in `table`, or nothing. */
export function subcommandIn(table: Subcommands, argv: readonly string[]): Subcommand | undefined {
  const word = argv[0];
  if (word === undefined || !Object.hasOwn(table, word)) return undefined;
  const command = table[word];
  return !command.takes || command.takes(argv.slice(1)) ? command : undefined;
}

/** Runs one, as every main does: its exit code on the process, a throw said in a line, under the binary's name, with exit 1. */
export async function runSubcommand(command: Subcommand, argv: string[], bin: 'tablewalk' | 'mistri'): Promise<void> {
  try {
    const code = await command.run(argv);
    if (typeof code === 'number') process.exitCode = code;
  } catch (error) {
    console.error(`${bin}: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
