/**
 * `mistri build --dockerfile`: the image recipe is written from the build's own options and keeps the repository
 * Dockerfile's conventions (pinned node:24 alpine, tini, uid 1000, PORT, /healthz).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDockerfile } from '../packages/mistri/src/server/build/dockerfile.js';
import { runBuild } from '../packages/mistri/src/server/build/build.js';

const root = mkdtempSync(join(tmpdir(), 'tablewalk-dockerfile-'));
const home = process.cwd();
before(() => process.chdir(root));
after(() => {
  process.chdir(home);
  rmSync(root, { recursive: true, force: true });
});

describe('mistri build --dockerfile', () => {
  test('builds with the options given and serves the build with its own entries', () => {
    const text = appDockerfile({ app: 'my-app', commands: 'my-app/commands.ts', jobs: 'my-app/jobs.ts', config: 'mistri.json' });
    assert.match(text, /^ARG NODE_IMAGE=node:24\.\d+\.\d+-alpine/m);
    assert.match(
      text,
      /RUN npx @mistriwork\/mistri build --app my-app --out build\/my-app --commands my-app\/commands\.ts --jobs my-app\/jobs\.ts\n/,
    );
    assert.match(text, /COPY my-app \.\/my-app\n/);
    assert.match(text, /COPY mistri\.json \/config\/mistri\.json\n/);
    assert.match(text, /ENTRYPOINT \["\/sbin\/tini", "--", "node_modules\/\.bin\/mistri"\]/);
    assert.match(
      text,
      /CMD \["--host", "0\.0\.0\.0", "--config", "\/config\/mistri\.json", "--app", "build\/my-app", "--commands", "build\/my-app\/server\/commands\.mjs", "--jobs", "build\/my-app\/server\/jobs\.mjs"\]/,
    );
    assert.match(text, /^USER node$/m);
    assert.match(text, /ENV PORT=4111/);
    assert.match(text, /HEALTHCHECK[^]*\/healthz/);
  });

  test('copies an entry that sits outside the App, and omits what was not asked for', () => {
    const text = appDockerfile({ app: 'apps/crm', commands: 'server/commands.ts' });
    assert.match(text, /COPY server \.\/server\n/);
    assert.doesNotMatch(text, /\/config\/mistri\.json/);
    assert.match(text, /CMD \["--host", "0\.0\.0\.0", "--app", "build\/crm", "--commands", "build\/crm\/server\/commands\.mjs"\]/);
  });

  test('an App that is the project root is built from a folder of its own, beside the build', () => {
    const text = appDockerfile({ app: '.', commands: 'server/commands.ts', config: 'mistri.json' });
    assert.match(text, /^COPY \. \.\/app$/m);
    assert.match(text, /RUN npx @mistriwork\/mistri build --app app --out build\/[^ ]+ --commands app\/server\/commands\.ts\n/);
    assert.doesNotMatch(text, /^COPY server /m);
  });

  test('refuses a path outside the build context', () => {
    assert.throws(() => appDockerfile({ app: '../elsewhere' }), /not inside the current directory/);
    assert.throws(() => appDockerfile({ app: 'a', config: '/etc/mistri.json' }), /not inside the current directory/);
  });

  test('the command writes the file and builds nothing', async () => {
    mkdirSync(join(root, 'tick'));
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(await runBuild(['--app', 'tick', '--dockerfile', 'Dockerfile'], ''), 0);
    } finally {
      console.log = log;
    }
    assert.match(readFileSync(join(root, 'Dockerfile'), 'utf8'), /build --app tick --out build\/tick\n/);
  });
});
