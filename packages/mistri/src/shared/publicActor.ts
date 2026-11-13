/**
 * The ids a public principal runs under: its door's (`public:<form>`), for a visitor on a public form or page, or a
 * token's (`token:<tokenId>`), for an App API token that names the door's verb. Every check that asks "is this the
 * public principal's id" asks here, so a second door never has to be found by hand — a hard-coded `public:` id outside
 * this module fails test/public-actor-ids.test.ts.
 */

const TOKEN_ACTOR = /^token:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The id a visitor at a public door runs under. */
export const publicActorId = (form: string): string => `public:${form}`;

/** The id a token runs a public verb under: its own, so each token's receipts and budget are its own. */
export const tokenActorId = (tokenId: string): string => `token:${tokenId}`;

/** Whether `id` is a token's public-lane id. */
export const isTokenActorId = (id: unknown): id is string => typeof id === 'string' && TOKEN_ACTOR.test(id);

/** Whether `id` is one a public principal at `form` may carry: the door's own, or a token's. */
export const isPublicActorId = (id: unknown, form: string): boolean => id === publicActorId(form) || isTokenActorId(id);
