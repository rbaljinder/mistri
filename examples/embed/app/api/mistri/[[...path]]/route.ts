/*
 * mistri mounted in Next's own server, under /api/mistri: the App's API, its sign-in and the auth routes. The page
 * (app/page.tsx) calls it through the hooks; nothing else here is mistri's.
 */
import { mistri } from '../../../../lib/mistri';

export const runtime = 'nodejs';

const handle = (request: Request) => mistri.fetch(request);
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
