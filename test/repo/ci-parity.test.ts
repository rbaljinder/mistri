/**
 * scripts/ci-parity.mjs reads the Dockerfile and the build the way CI's Docker
 * job does. 0.9.2's image build failed on a COPY of examples/apps/compass
 * after the App moved; these hold that the check would have named it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInputs, dockerCopySources } from '../../scripts/ci-parity.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;

test('the build stage COPY sources are read, multi-source lines and --from copies apart', () => {
  const sources = dockerCopySources(
    [
      'FROM node AS build',
      'COPY package.json package-lock.json ./',
      'COPY examples/apps/compass ./examples/apps/compass',
      'FROM node AS runtime',
      'COPY --from=build /src/dist ./dist',
      'COPY skills ./skills',
    ].join('\n'),
  );
  assert.deepEqual(sources, [
    { stage: 'build', path: 'package.json' },
    { stage: 'build', path: 'package-lock.json' },
    { stage: 'build', path: 'examples/apps/compass' },
    { stage: 'runtime', path: 'skills' },
  ]);
});

test('what npm run build reads includes the type budget fixtures and the scripts it loads', () => {
  const inputs = buildInputs();
  assert.ok(inputs.includes('test/fixtures/apps/crm'), inputs.join(', '));
  assert.ok(inputs.includes('scripts/synthetic-app.mjs'), inputs.join(', '));
  assert.ok(inputs.includes('scripts/embed-css.mjs'), inputs.join(', '));
});

test('every build input is copied by the real Dockerfile', () => {
  const copied = dockerCopySources(readFileSync(`${ROOT}Dockerfile`, 'utf8'))
    .filter((source) => source.stage === 'build')
    .map((source) => source.path);
  const missing = buildInputs().filter((path) => !copied.some((source) => path === source || path.startsWith(`${source}/`)));
  assert.deepEqual(missing, []);
});
