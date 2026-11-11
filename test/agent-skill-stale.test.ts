/**
 * What `mistri agent init` promises to keep true over time: the AGENTS.md block
 * names every entry point the package exports (read from the exports map, so a
 * new one cannot be forgotten), and a skill copy stamped by an older mistri is
 * said, as a warning, by `check`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryPoints, runAgent, staleSkillWarning } from '../packages/mistri/src/server/cli/agentInit.js';
import { runtimeVersion } from '../packages/engine/src/server/packageVersion.js';

const exportsMap = (
  JSON.parse(readFileSync(new URL('../packages/mistri/package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> }
).exports;

describe('agent init entry points', () => {
  test('are the exports map, minus the wildcard and package.json', () => {
    const named = Object.keys(exportsMap).filter((key) => key !== './package.json' && !key.includes('*'));
    assert.deepEqual(entryPoints().sort(), named.map((key) => `@mistriwork/mistri/${key.slice(2)}`.replace(/\/$/, '')).sort());
    for (const sub of ['policy', 'page', 'ui', 'testing'])
      assert.ok(
        entryPoints().some((name) => name.endsWith(`/${sub}`)),
        sub,
      );
  });

  test('all appear in the AGENTS.md block', () => {
    const project = mkdtempSync(join(tmpdir(), 'mistri-agent-eps-'));
    try {
      assert.equal(
        runAgent(
          ['init', '--dir', project, '--tool', 'codex'],
          () => {},
          () => {},
        ),
        0,
      );
      const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
      for (const name of entryPoints()) assert.ok(agents.includes(name), `${name} is named`);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('a stale agent skill', () => {
  const stamped = (project: string, version: string) => {
    const copy = join(project, '.claude', 'skills', 'mistri');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, '.mistri-skill.json'), JSON.stringify({ mistri: version, files: {} }));
  };

  test('is named when its stamp is older, in order of version rather than text', () => {
    const project = mkdtempSync(join(tmpdir(), 'mistri-agent-stale-'));
    try {
      stamped(project, '1.0.0-rc.9');
      assert.match(staleSkillWarning(project, '1.0.0-rc.19') ?? '', /1\.0\.0-rc\.9.*1\.0\.0-rc\.19.*agent init/);
      stamped(project, '1.0.0-rc.19');
      assert.equal(staleSkillWarning(project, '1.0.0-rc.19'), undefined);
      stamped(project, '1.0.0-rc.20');
      assert.equal(staleSkillWarning(project, '1.0.0-rc.19'), undefined, 'a newer copy is not stale');
      stamped(project, '1.0.0-rc.19');
      assert.match(staleSkillWarning(project, '1.0.0') ?? '', /rc\.19/, 'a pre-release is older than its release');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  /* A field report: after an upgrade whose skill files had not changed, a re-run said "up to date" and kept the old
     stamp, so check went on warning until the folder was moved away. */
  test('whose files are current is restamped by a re-run, with or without --force, and check stops warning', () => {
    const project = mkdtempSync(join(tmpdir(), 'mistri-agent-restamp-'));
    const manifest = join(project, '.claude', 'skills', 'mistri', '.mistri-skill.json');
    const init = (...flags: string[]) => {
      const said: string[] = [];
      const code = runAgent(
        ['init', '--dir', project, '--tool', 'claude', ...flags],
        (text) => said.push(text),
        () => {},
      );
      return { code, said: said.join('') };
    };
    const backdate = () => {
      const stamp = JSON.parse(readFileSync(manifest, 'utf8')) as { mistri: string };
      writeFileSync(manifest, JSON.stringify({ ...stamp, mistri: '1.0.0-rc.1' }));
    };
    try {
      assert.equal(init().code, 0);
      assert.match(init().said, /\.claude\/skills\/mistri \(claude\): up to date/);
      for (const flags of [[], ['--force']]) {
        backdate();
        assert.match(staleSkillWarning(project, runtimeVersion()) ?? '', /rc\.1\b/);
        const rerun = init(...flags);
        assert.equal(rerun.code, 0, flags.join(' '));
        assert.match(rerun.said, /\.claude\/skills\/mistri \(claude\): updated/, flags.join(' '));
        assert.equal((JSON.parse(readFileSync(manifest, 'utf8')) as { mistri: string }).mistri, runtimeVersion());
        assert.equal(staleSkillWarning(project, runtimeVersion()), undefined);
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  // A field report: --force on a copy it could not tell was stale answered "up to date" and wrote nothing.
  test('--force rewrites a copy that is current, and says so', () => {
    const project = mkdtempSync(join(tmpdir(), 'mistri-agent-force-'));
    const readme = join(project, '.claude', 'skills', 'mistri', 'SKILL.md');
    const said: string[] = [];
    const init = (...flags: string[]) =>
      runAgent(
        ['init', '--dir', project, '--tool', 'claude', ...flags],
        (text) => said.push(text),
        () => {},
      );
    try {
      assert.equal(init(), 0);
      const before = statSync(readme).mtimeMs;
      const until = Date.now() + 20;
      while (Date.now() < until);
      said.length = 0;
      assert.equal(init('--force'), 0);
      assert.match(said.join(''), /\.claude\/skills\/mistri \(claude\): updated \(--force\)/);
      assert.ok(statSync(readme).mtimeMs > before, 'the files were written again');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('is silent when no copy was made', () => {
    const project = mkdtempSync(join(tmpdir(), 'mistri-agent-none-'));
    try {
      assert.equal(staleSkillWarning(project, '1.0.0'), undefined);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
