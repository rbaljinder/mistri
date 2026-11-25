/** `mistri-reads`: the header's tables are kept against the answer, then the query, and forgotten with it. */
import { expect, test } from 'vitest';
import { QueryCache, QueryClient } from '@tanstack/react-query';
import { fileQueryReads, fileReads, fileWrites, parseReads, parseWrites, queryReads, readsOf, sameReads, writesOf } from './liveReads.js';

test('a header names its tables, an encoded comma stays inside its id', () => {
  expect(parseReads('job,ledger')).toEqual(['job', 'ledger']);
  expect(parseReads('a%2Cb,c')).toEqual(['a,b', 'c']);
  expect(parseReads('')).toBeUndefined();
  expect(parseReads(null)).toBeUndefined();
  expect(parseReads('%E0%A4%A')).toBeUndefined();
});

test('the tables are kept against the parsed answer, and an answer with no header has none', () => {
  const answer = { rows: [] };
  fileReads(answer, 'job');
  expect(readsOf(answer)).toEqual(['job']);
  const bare = { rows: [] };
  fileReads(bare, null);
  expect(readsOf(bare)).toBeUndefined();
  expect(() => fileReads('text', 'job')).not.toThrow();
});

test("a query holds its answer's tables while it is cached, and not after it is removed", async () => {
  const cache = new QueryCache({ onSuccess: fileQueryReads });
  const client = new QueryClient({ queryCache: cache });
  await client.fetchQuery({
    queryKey: ['count', 'spoke', 'x'],
    queryFn: () => {
      const answer = { count: 3 };
      fileReads(answer, 'job');
      return answer;
    },
  });
  const hash = cache.getAll()[0].queryHash;
  expect(queryReads(hash)).toEqual(['job']);
  /* A later answer without the header clears what the earlier one said: the family's own rule applies again. */
  await client.fetchQuery({ queryKey: ['count', 'spoke', 'x'], staleTime: 0, queryFn: () => ({ count: 4 }) });
  expect(queryReads(hash)).toBeUndefined();
});

/* A component's own list (`useRows`) is kept a page at a time: unfiled, every change to any table asked it again. */
test("a read kept in pages holds its pages' tables, and none once a page does not say", async () => {
  const cache = new QueryCache({ onSuccess: fileQueryReads });
  const client = new QueryClient({ queryCache: cache });
  const said = (reads: string | null) => {
    const answer = { rows: [] };
    fileReads(answer, reads);
    return sameReads({ rows: [], more: false }, answer);
  };
  await client.fetchQuery({
    queryKey: ['mistri-ui', 'rows', 'a'],
    queryFn: () => ({ pages: [said('job'), said('job,ledger')], pageParams: [0, 20] }),
  });
  expect([...(queryReads(cache.getAll()[0].queryHash) ?? [])].sort()).toEqual(['job', 'ledger']);
  await client.fetchQuery({
    queryKey: ['mistri-ui', 'rows', 'b'],
    queryFn: () => ({ pages: [said('job'), said(null)], pageParams: [0, 20] }),
  });
  expect(queryReads(cache.getAll()[1].queryHash)).toBeUndefined();
});

test("a command's answer says the tables its run wrote: some, none, or nothing known", () => {
  expect(parseWrites('tables=job,a%2Cb')).toEqual(['job', 'a,b']);
  expect(parseWrites('tables=')).toEqual([]);
  expect(parseWrites(null)).toBeUndefined();
  expect(parseWrites('')).toBeUndefined();
  expect(parseWrites('job')).toBeUndefined();
  expect(parseWrites('tables=%E0%A4%A')).toBeUndefined();
  const applied = { status: 'applied' };
  fileWrites(applied, 'tables=');
  expect(writesOf(applied)).toEqual([]);
  const replayed = { status: 'applied' };
  fileWrites(replayed, null);
  expect(writesOf(replayed)).toBeUndefined();
});
