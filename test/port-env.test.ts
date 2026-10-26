import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../packages/engine/src/server/cli/args.js';

const withPort = (value: string | undefined, run: () => void) => {
  const before = process.env.PORT;
  if (value === undefined) delete process.env.PORT;
  else process.env.PORT = value;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.PORT;
    else process.env.PORT = before;
  }
};

test('PORT sets the port when no flag does, and counts as named so a busy port is not rolled past', () => {
  withPort('8080', () => {
    const opts = parseArgs(['x.db']);
    assert.equal(opts.port, 8080);
    assert.equal(opts.portGiven, true);
  });
});

test('--port wins over PORT', () => {
  withPort('8080', () => assert.equal(parseArgs(['x.db', '--port', '5000']).port, 5000));
});

test('no PORT, or one that is not a port, leaves the default', () => {
  for (const value of [undefined, '', 'abc', '0', '70000', '80.5']) {
    withPort(value, () => {
      const opts = parseArgs(['x.db']);
      assert.equal(opts.port, 4111, String(value));
      assert.equal(opts.portGiven, false);
    });
  }
});
