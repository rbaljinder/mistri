/*
 * The same applications drawn on the server, with no hooks and no script: a server component has no browser session, so
 * it asks the handler for a token (`tokenFor`), which stands for the person whose cookie the request carried and for
 * the `applications` surface alone, and reads the rows through the App's API with it.
 */
import { headers } from 'next/headers';
import { SurfaceTokenRefused } from '@mistriwork/mistri/handler';
import { mistri } from '../../lib/mistri';

export const dynamic = 'force-dynamic';

const ORIGIN = process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000';

export default async function Page() {
  let token: string;
  try {
    token = await mistri.tokenFor({ headers: await headers() }, { surface: 'applications', ttl: 30 });
  } catch (error) {
    if (error instanceof SurfaceTokenRefused && error.code === 'no_session') {
      return (
        <p>
          <a href="/api/mistri/sign-in?then=/server">Sign in</a> to see the applications.
        </p>
      );
    }
    throw error;
  }
  const response = await mistri.fetch(
    new Request(`${ORIGIN}/api/mistri/api/view/run?app=command-desk`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'command-desk', view: { base: 'loan_application' }, count: 'none' }),
    }),
  );
  if (!response.ok) throw new Error(`The App refused the read: ${response.status}`);
  const { rows } = (await response.json()) as { rows: Record<string, unknown>[] };
  return (
    <main>
      <h1>Applications</h1>
      <ul>
        {rows.map((row) => (
          <li key={String(row.id)}>
            {String(row.reference)} — {String(row.status)}
          </li>
        ))}
      </ul>
    </main>
  );
}
