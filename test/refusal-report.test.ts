/**
 * Every refusal names its cause, to whom it may (http/refusalReport.ts): the
 * operator's console for a failure or a refusal that recorded why, the
 * author's own page for the author at work, and nobody else.
 */
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { authoringApp, noteAuthorRequest, reportRefusal } from '../packages/engine/src/server/http/refusalReport.js';
import {
  Refusal,
  recordRefusalCause,
  refusalHeadline,
  refusalReasons,
  refusalReasonsBelow,
} from '../packages/engine/src/shared/refusal.js';

const request = (url = '/api/run') => ({ method: 'POST', url: `${url}?app=x` }) as IncomingMessage;
function heard(run: () => unknown): { lines: string[]; value: unknown } {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...line: unknown[]) => {
    lines.push(line.join(' '));
  };
  try {
    return { lines, value: run() };
  } finally {
    console.error = error;
  }
}

test('a server failure is told to the operator with its own words, and a refusal with each reason under it', () => {
  // `me` in a rollup reached PostgreSQL as text and failed there: a 500 and nothing logged.
  const failure = heard(() =>
    reportRefusal(
      request(),
      500,
      'data_unavailable',
      'The data could not be loaded.',
      new Error('invalid input syntax for type integer: "me"'),
    ),
  );
  assert.deepEqual(failure.lines, [
    'mistri: POST /api/run refused (500 data_unavailable): The data could not be loaded.',
    '  because: invalid input syntax for type integer: "me"',
  ]);
  const scoped = recordRefusalCause(new Refusal('Not in scope.'), 'The "loan" row id 9 is outside the principal\'s rows.');
  const refusal = heard(() =>
    reportRefusal(
      request('/api/commands/execute'),
      503,
      'temporarily_unavailable',
      'Try again.',
      recordRefusalCause(new Error('Try again.'), scoped),
    ),
  );
  assert.deepEqual(refusal.lines.slice(1), [
    '  because: Not in scope.',
    '  because: The "loan" row id 9 is outside the principal\'s rows.',
  ]);
});

test('an ordinary refusal that recorded nothing stays quiet', () => {
  assert.deepEqual(heard(() => reportRefusal(request(), 404, undefined, 'No such endpoint.', new Error('No such endpoint.'))).lines, []);
});

test("the cause reaches the answer only for the App's administrator at an App served from its source on a loopback listener", () => {
  const error = recordRefusalCause(new Error('Try again.'), 'The rule that refused.');
  const loopback = { host: '127.0.0.1', port: 1 };
  const answer = (req: IncomingMessage) => heard(() => reportRefusal(req, 503, 'x', 'Try again.', error)).value;
  authoringApp('/apps/watched');
  const watched = [{ path: '/apps/watched' }];
  const cases: Array<[string, Parameters<typeof noteAuthorRequest>, boolean]> = [
    ['the author at work', [request(), loopback, true, watched], true],
    ['a signed-out visitor or an ordinary account', [request(), loopback, false, watched], false],
    ['a built App', [request(), loopback, true, [{ path: '/apps/watched', build: {} }]], false],
    ['an App not watched', [request(), loopback, true, [{ path: '/apps/deployed' }]], false],
    ['a listener the network reaches', [request(), { host: '0.0.0.0', port: 1 }, true, watched], false],
    ['an allowed host', [request(), { ...loopback, allowedHosts: ['apps.example.com'] }, true, watched], false],
    ['a proxy that signs people in', [request(), { ...loopback, identityHeader: 'x-user' }, true, watched], false],
  ];
  for (const [name, args, told] of cases) {
    noteAuthorRequest(...args);
    assert.equal(answer(args[0]), told ? 'The rule that refused.' : undefined, name);
  }
});

test('a reason is recorded once, kept off `cause`, and read through every refusal rebuilt over it', () => {
  const inner = recordRefusalCause(new Refusal('Not in scope.'), 'The first reason.');
  recordRefusalCause(inner, 'A later reason does not replace it.');
  const outer = recordRefusalCause(new Error('Refused.'), inner);
  assert.equal('cause' in outer, false);
  assert.equal(JSON.stringify(outer), '{}');
  assert.deepEqual(refusalReasons(outer), ['Not in scope.', 'The first reason.']);
});

test('a denial recorded under a refusal is no reason: an ordinary forbidden stays quiet', () => {
  const denied = recordRefusalCause(
    new Error('This command is not available to this account.'),
    new Refusal('Access to this resource is denied.'),
  );
  assert.deepEqual(
    heard(() => reportRefusal(request('/api/commands/execute'), 403, 'forbidden', 'This command is not available to this account.', denied))
      .lines,
    [],
  );
});

test('a startup headline states the recorded cause, and a refusal with none keeps its sentence', () => {
  const sentence = 'The commands module could not be loaded.';
  const caused = recordRefusalCause(new Error(sentence), 'ReferenceError: foo is not defined');
  assert.equal(refusalHeadline(caused), `${sentence} Cause: ReferenceError: foo is not defined`);
  assert.equal(refusalHeadline(new Error(sentence)), sentence);
  // The lines under the headline go on past the cause it said: printed again, it read as a second reason.
  assert.deepEqual(refusalReasonsBelow(caused), []);
  const deeper = recordRefusalCause(new Error(sentence), new Error('The store is not provisioned.', { cause: new Error('no such table') }));
  assert.equal(refusalHeadline(deeper), `${sentence} Cause: The store is not provisioned.`);
  assert.deepEqual(refusalReasonsBelow(deeper), ['no such table']);
});
