/**
 * The App framework's commands: each word, and the module it loads when it is the one typed. Nothing here is
 * imported until its command runs, so the table costs a start nothing (test/cli-startup.test.ts counts).
 *
 * `migrate` and `seed` are the engine's commands with the App's part handed in (cli/appTargets.ts): the database
 * browser has its own, without `--app` (packages/tablewalk/src/server/cli/browserCommands.ts).
 */
import type { Subcommands } from '@mistriwork/engine/server/cli/subcommand.js';

const sections = async () => (await import('../serviceConnections.js')).CONFIG_SECTIONS;

export const MISTRI_COMMANDS: Subcommands = {
  virtual: { run: async (argv) => (await import('./virtualCommand.js')).runVirtualCommand(argv) },
  experiments: { run: async (argv) => (await import('./experimentsCommand.js')).runExperimentsCommand(argv) },
  /* A tenant App's sandboxes. */
  tenant: { run: async (argv) => (await import('./tenantCommand.js')).runTenantCommand(argv) },
  /* Flows started on records already there. */
  flows: { run: async (argv) => (await import('./flowsCommand.js')).runFlowsCommand(argv) },
  /* A decision measured on settled records, and its model pinned to apply. */
  decide: { run: async (argv) => (await import('./decideCommand.js')).runDecideCommand(argv) },
  /* A job at times run now, by hand. */
  jobs: { run: async (argv) => (await import('./jobsCommand.js')).runJobsCommand(argv) },
  analytics: { run: async (argv) => (await import('./analyticsCommand.js')).runAnalyticsCommand(argv) },
  /* An App's words for a translator (messagesCommand.ts); loads the App, starts nothing. */
  messages: { run: async (argv) => (await import('./messagesCommand.js')).runMessagesCommand(argv) },
  flags: { run: async (argv) => (await import('./flagsCommand.js')).runFlagsCommand(argv) },
  suite: { run: async (argv) => (await import('./suiteCommand.js')).runSuiteCommand(argv) },
  'api-token': {
    async run(argv) {
      const { runApiTokenCommand } = await import('./apiTokenCommand.js');
      return runApiTokenCommand(
        argv,
        async (rest, rememberIssue) => (await import('./apiTokenMaintenance.js')).runApiTokenMaintenance(rest, undefined, rememberIssue),
        process.stdout,
        process.stderr,
      );
    },
  },
  'compare-openapi': {
    /* Its exit codes are a contract of their own: 0 met, 1 unmet, 2 input it could not read. */
    async run(argv) {
      const usage = 'mistri compare-openapi <previous.json> <current.json>';
      if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
        console.log(`${usage}\nCompare local Mistri read-contract previews. Exit 0: version requirement met; 1: unmet; 2: invalid input.`);
        return 0;
      }
      if (argv.length !== 2 || argv.some((arg) => !arg || arg.startsWith('-'))) {
        console.error(`mistri: expected ${usage}`);
        return 2;
      }
      try {
        const { compareOpenApiFiles } = await import('./compareOpenApi.js');
        const result = await compareOpenApiFiles(argv[0], argv[1]);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.versionRequirementMet ? 0 : 1;
      } catch (error) {
        console.error(`mistri: ${error instanceof Error ? error.message : 'Could not compare local read-contract previews.'}`);
        return 2;
      }
    },
  },
  /* A new App, written whole with its database: a starter to serve with `mistri dev` (newApp.ts), or with --api an
     App that is only an API (newApi.ts). mistri opens no bare file, so the word is always the command. */
  new: {
    run: async (argv) =>
      argv[0] === '--api' ? (await import('./newApi.js')).runNewApi(argv) : (await import('./newApp.js')).runNewApp(argv),
  },
  build: {
    async run(argv) {
      const [{ runBuild }, { USAGE }] = await Promise.all([import('../build/build.js'), import('./usage.js')]);
      return runBuild(argv, USAGE);
    },
  },
  /* The authoring loop: its flags are a start's, handed on to the validation it runs, but the command is its own. */
  check: { run: async (argv) => (await import('../build/check.js')).runCheck(argv) },
  /* The loop's eyes: the App served and photographed. */
  shot: { run: async (argv) => (await import('../build/shot.js')).runShot(argv) },
  /* The skill a coding agent loads, copied into the project it works in. */
  agent: { run: async (argv) => (await import('./agentInit.js')).runAgent(argv) },
  /* A starter suite for an App: a journey per role and a permissions matrix. */
  test: { run: async (argv) => (await import('./testInit.js')).runTestCommand(argv) },
  /* Schema changes as versioned SQL files, with an App's stores and files. */
  migrate: {
    async run(argv) {
      const [{ runMigrate }, { MIGRATE_APPS }] = await Promise.all([
        import('@mistriwork/engine/server/migrate/cli.js'),
        import('./appTargets.js'),
      ]);
      return runMigrate(argv, undefined, await sections(), MIGRATE_APPS);
    },
  },
  /* Rows to look at in an App's writable database, each status the way its machine moves it. */
  seed: {
    async run(argv) {
      const [{ runSeed }, { SEED_APPS }] = await Promise.all([import('@mistriwork/engine/server/seed/cli.js'), import('./appTargets.js')]);
      return runSeed(argv, undefined, await sections(), SEED_APPS);
    },
  },
  /* The dev observer of a running `--dev` server: its address, or its telemetry as MCP tools. */
  observe: {
    async run(argv) {
      const [{ runObserve }, { packageVersion }] = await Promise.all([
        import('../observe/cli.js'),
        import('@mistriwork/engine/server/cli/usage.js'),
      ]);
      return runObserve(argv, await packageVersion());
    },
  },
  /* A theme as it is worn, inherited values marked. Only with `show`, so `./theme` still opens a file. */
  theme: { takes: (argv) => argv[0] === 'show', run: async (argv) => (await import('../build/themeShow.js')).runTheme(argv) },
  /* The rubric, measured: the App served as shot serves it, each page judged. */
  grade: { run: async (argv) => (await import('../build/grade.js')).runGrade(argv) },
  /* The DNS records tenant mail is sent under. */
  'mail-dns': { run: async (argv) => (await import('../email/mailDns.js')).runMailDns(argv) },
  explain: { run: async (argv) => (await import('../build/explain.js')).runExplain(argv) },
  /* The reference the package ships, offline. It was once opened as a SQLite file of that name. */
  docs: { run: async (argv) => (await import('../docs.js')).runDocs(argv) },
};
