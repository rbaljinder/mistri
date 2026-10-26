#!/usr/bin/env node
/**
 * What CI checks that the local gate does not, in a few seconds and with nothing installed.
 *
 * 0.9.2 took three CI runs that failed on things no local suite looked at:
 *   - the Dockerfile still COPY'd examples/apps/compass after it moved to
 *     test/fixtures/apps/crm, and only the Docker job builds the image;
 *   - CI's brotli measured the App's first-paint script a few bytes over a
 *     ceiling the local build had met, because the two compressors differ by
 *     bytes and the ceiling sat closer than that;
 *   - the generated DSL reference pages were stale after an example changed,
 *     and the local Node lane that compares them had run before the change.
 *
 * So, before a release PR is pushed:
 *   - every COPY source of the Dockerfile's build exists, and everything
 *     `npm run build` reads (the scripts it runs, the configs it names, the
 *     fixture Apps scripts/type-budget.mjs measures) is copied into it;
 *   - the generated CLI and DSL references match what they are generated from;
 *   - a bundle measure within 0.1% of its ceiling is named (a warning: it
 *     passes here and may not on CI's compressor). Skipped when dist/client
 *     has not been built.
 *
 *   node scripts/ci-parity.mjs        (npm run test:ci-parity)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

/** The build stage's COPY sources (not `--from` copies, which read another stage), as repo paths. */
export function dockerCopySources(dockerfile) {
  const sources = [];
  let stage = '';
  for (const line of dockerfile.split('\n')) {
    const from = /^FROM\s.*\bAS\s+(\S+)/i.exec(line);
    if (from) stage = from[1];
    const copy = /^COPY\s+(.*)$/i.exec(line.trim());
    if (!copy) continue;
    const words = copy[1].split(/\s+/).filter(Boolean);
    if (words.some((word) => word.startsWith('--from'))) continue;
    const paths = words.filter((word) => !word.startsWith('--'));
    for (const path of paths.slice(0, -1)) sources.push({ stage, path: posix.normalize(path.replace(/^\.\//, '')).replace(/\/$/, '') });
  }
  return sources;
}

/** What `npm run build` reads from the source tree, beyond src/ and the manifests. */
export function buildInputs(root = ROOT) {
  const at = (path) => readFileSync(join(root, path), 'utf8');
  const build = JSON.parse(at('package.json')).scripts.build;
  const inputs = new Set();
  for (const [, path] of build.matchAll(/(?:-p|-c)\s+(\S+)/g)) inputs.add(path);
  /* A script may follow node's own flags (`node --conditions=mistri-built scripts/type-budget.mjs`). */
  for (const [, path] of build.matchAll(/\bnode\s+(?:--[\w=-]+\s+)*(scripts\/[\w.-]+\.mjs)/g)) inputs.add(path);
  if (existsSync(join(root, 'vite.config.ts'))) inputs.add('vite.config.ts');
  /* The scripts those scripts load — a relative import, a join(ROOT, 'scripts', …), a 'scripts/x.mjs' they run — and
     the tsc and Vite configs they name (scripts/build-packages.mjs runs the build's steps). */
  const pending = [...inputs].filter((path) => path.startsWith('scripts/'));
  while (pending.length) {
    const script = /** @type {string} */ (pending.pop());
    const text = at(script);
    const found = [
      ...[...text.matchAll(/['"]\.\/([\w.-]+\.mjs)['"]/g)].map((match) => `scripts/${match[1]}`),
      ...[...text.matchAll(/'scripts',\s*'([\w.-]+\.mjs)'/g)].map((match) => `scripts/${match[1]}`),
      ...[...text.matchAll(/'(scripts\/[\w.-]+\.mjs)'/g)].map((match) => match[1]),
    ];
    /* Only a config at the root is a source: type-budget.mjs names the tsconfig.budget.json it writes into a copy. */
    for (const [, config] of text.matchAll(/'((?:tsconfig[\w.-]*\.json)|(?:vite[\w.-]*\.config\.ts))'/g))
      if (existsSync(join(root, config))) inputs.add(config);
    for (const path of found) {
      if (inputs.has(path)) continue;
      inputs.add(path);
      pending.push(path);
    }
  }
  for (const config of [...inputs].filter((path) => path.startsWith('vite'))) {
    for (const [, path] of at(config).matchAll(/from\s+'\.\/(scripts\/[\w.-]+\.mjs)'/g)) inputs.add(path);
  }
  /* The App fixtures the type budget copies and measures. */
  for (const [, path] of at('scripts/type-budget.mjs').matchAll(/\bfrom:\s*'([^']+)'/g)) inputs.add(path);
  return [...inputs];
}

function docker() {
  const problems = [];
  const sources = dockerCopySources(read('Dockerfile'));
  for (const { path } of sources) {
    if (!existsSync(join(ROOT, path))) problems.push(`Dockerfile copies ${path}, which does not exist`);
  }
  const built = sources.filter((source) => source.stage === 'build').map((source) => source.path);
  const covered = (path) => built.some((source) => source === '.' || path === source || path.startsWith(`${source}/`));
  for (const path of buildInputs()) {
    if (!covered(path)) problems.push(`npm run build reads ${path}, which the Dockerfile's build stage does not copy`);
  }
  return problems;
}

function references() {
  const problems = [];
  for (const script of ['scripts/cli-reference.mjs', 'scripts/dsl-reference.mjs']) {
    const run = spawnSync(process.execPath, [join(ROOT, script), '--check'], { cwd: ROOT, encoding: 'utf8' });
    if (run.status !== 0) problems.push(`${script} --check: ${(run.stderr || run.stdout).trim()} (run node ${script})`);
  }
  return problems;
}

/** Margin under which a passing measure is reported: CI's compressor and a laptop's differ by bytes. */
export const NEAR = 0.001;

async function budgets() {
  const budget = await import(join(ROOT, 'scripts/bundle-budget.mjs'));
  if (Object.values(budget.CLIENTS).some((client) => !existsSync(join(client, 'index.html')))) return { skipped: true, near: [] };
  const near = [];
  const look = (what, size, ceiling) => {
    if (size <= ceiling && ceiling - size <= ceiling * NEAR) near.push(`${what}: ${size} of ${ceiling} (${ceiling - size} bytes under)`);
  };
  for (const surface of Object.keys(budget.SURFACES)) {
    const shipped = budget.firstPaint(surface);
    for (const kind of ['script', 'style'])
      for (const measure of ['raw', 'br'])
        look(`${surface} ${kind} ${measure}`, shipped[kind][measure], budget.ceilingOf(surface)[kind][measure]);
  }
  for (const [bin, client] of Object.entries(budget.CLIENTS))
    for (const [language, sizes] of Object.entries(budget.localeSizes(client)))
      for (const measure of ['raw', 'br']) look(`${bin} words ${language} ${measure}`, sizes[measure], budget.LOCALE_BUDGET[measure]);
  if (existsSync(join(ROOT, 'packages/mistri/dist/embed/react/index.js'))) {
    const embedded = budget.embedSizes();
    for (const part of Object.keys(budget.EMBED_BUDGET))
      for (const measure of ['raw', 'br'])
        look(`@mistriwork/mistri/react ${part} ${measure}`, embedded[part][measure], budget.EMBED_BUDGET[part][measure]);
  }
  return { skipped: false, near };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = [...docker(), ...references()];
  const { skipped, near } = await budgets();
  if (skipped)
    console.log("ci-parity: the products' dist/client is not built; bundle margins not measured (npm run build first to see them).");
  for (const line of near)
    console.warn(
      `ci-parity: warning: ${line} is within ${NEAR * 100}% of its ceiling in scripts/bundle-budget.mjs; CI may measure it over.`,
    );
  if (problems.length) {
    console.error(`ci-parity:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log('ci-parity: Dockerfile inputs, CLI and DSL references agree.');
}
