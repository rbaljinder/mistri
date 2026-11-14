import { expect, test } from 'vitest';
import { parseCsv, toCsv } from '../src/importing';

test('a sheet is read as rows of cells, quoted ones holding commas, quotes and line ends', () => {
  const text = '﻿code,note\r\nDM-101,"corner, with a view"\nDM-102,"said ""quiet"""\nDM-103,"two\nlines"\n\n';
  expect(parseCsv(text)).toEqual([
    ['code', 'note'],
    ['DM-101', 'corner, with a view'],
    ['DM-102', 'said "quiet"'],
    ['DM-103', 'two\nlines'],
  ]);
});

test('rows are written as a sheet that reads back the same', () => {
  const rows = [
    ['DM-101', 'corner, with a view', 1650],
    ['DM-102', 'said "quiet"', null],
  ];
  const text = toCsv(['code', 'note', 'rent'], rows);
  expect(text).toBe('code,note,rent\r\nDM-101,"corner, with a view",1650\r\nDM-102,"said ""quiet""",');
  expect(parseCsv(text)).toEqual([
    ['code', 'note', 'rent'],
    ['DM-101', 'corner, with a view', '1650'],
    ['DM-102', 'said "quiet"', ''],
  ]);
});

test('a cell a spreadsheet would run as a formula is written so that it is not', () => {
  expect(toCsv(['name'], [['=HYPERLINK("http://x")'], ['+1'], ['@sum'], [-5]])).toBe(
    'name\r\n"\'=HYPERLINK(""http://x"")"\r\n\'+1\r\n\'@sum\r\n-5',
  );
});
