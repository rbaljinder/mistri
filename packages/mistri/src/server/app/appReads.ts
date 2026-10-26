/**
 * What an App's resource reads are beside the database browser's
 * (resourceReadHttp.ts `AppReads`): a union read through its branches, a
 * reply that carries rendering state and never the compiler's output, a
 * failure in the App's words, and `me` with the memberships the text reads.
 * Every App read passes it; the database browser's reads pass none.
 */
import type { AppReads } from '@mistriwork/engine/server/resourceReadHttp.js';
import { appError } from './appErrors.js';
import { readMeSets, textsMentionMe } from './appMe.js';
import { appDataResponse } from './appResponses.js';
import { unionReads } from './unionReads.js';

export const APP_READS: AppReads = Object.freeze<AppReads>({
  reader: unionReads,
  reply: (body: Record<string, unknown>) => appDataResponse(body, true),
  error: (err: unknown) => appError(err),
  /* The person is looked up once, and only for text that compares with them. */
  person: async (me, texts, schema, adapter) =>
    textsMentionMe(texts, schema) ? { me: await readMeSets(await me(), texts, schema, adapter) } : {},
});
