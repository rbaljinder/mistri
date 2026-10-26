/**
 * The theme contract (packages/mistri/src/server/build/themeContract.ts) and the page that states it
 * (site/src/content/docs/docs/theme-contract.md) are one list: every promise has its row, every code a promise
 * names is measured by the row and documented where its command's codes are, and `mistri explain C5` prints it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { codeRows } from '../packages/mistri/src/server/build/checkCodes.js';
import { explainCode } from '../packages/mistri/src/server/build/explain.js';
import { GRADE_CODES } from '../packages/mistri/src/server/build/gradeJudge.js';
import { CONTRACT_CODES, PROMISES, PROMISE_WORDS, promiseOf } from '../packages/mistri/src/server/build/themeContract.js';
import { docPage } from '../packages/mistri/src/server/docs.js';

describe('the theme contract, as the page states it', () => {
  const rows = codeRows().filter((row) => row.topic === 'theme-contract');
  test('a row for each promise, in order, naming every code that holds it', () => {
    assert.deepEqual(
      rows.map((row) => row.code),
      PROMISES.map((promise) => promise.toLowerCase()),
    );
    for (const [code, promise] of Object.entries(CONTRACT_CODES)) {
      const row = rows.find((each) => each.code === promise.toLowerCase())!;
      assert.match(row.where, new RegExp(`(?:check|grade|,) \`?${code}\\b`), `${promise} names ${code}`);
    }
    for (const promise of PROMISES) {
      const row = rows.find((each) => each.code === promise.toLowerCase())!;
      assert.ok(row.means.toLowerCase().startsWith(PROMISE_WORDS[promise].toLowerCase()), `${promise}: ${row.means}`);
    }
  });
  test("every contract code is documented where its command's codes are", () => {
    const documented = new Set(
      codeRows()
        .filter((row) => row.topic !== 'theme-contract')
        .map((row) => row.code),
    );
    for (const code of Object.keys(CONTRACT_CODES)) assert.ok(documented.has(code), `${code} has no row`);
    for (const code of Object.keys(GRADE_CODES)) if (promiseOf(code)) assert.ok(documented.has(code), code);
  });
  test('mistri explain C5 prints the promise and links its row', () => {
    const { found, text } = explainCode('C5');
    assert.ok(found);
    assert.match(
      text,
      /^C5\n\ngrade `overlap`, `clipped-text`, `clipped-number`, `sideways-scroll`, `header-wrap`\nNothing cut or overlapping/,
    );
    assert.match(text, /https:\/\/mistriwork\.dev\/docs\/theme-contract\/#c5\n$/);
  });
  test('the page says how to grade every theme', () => {
    assert.match(docPage('theme-contract')!.body, /--theme all --palette all --as all/);
  });
});
