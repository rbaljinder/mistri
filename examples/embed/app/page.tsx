'use client';
/*
 * A front end that draws everything itself and uses mistri as its back end (@mistriwork/mistri/react/headless): the
 * applications as a plain list, and a button that runs `assignReviewer` on the first one. Nothing here is mistri's
 * but the hooks' answers.
 */
import { useState } from 'react';
import { Provider, useCommand, useRows } from '@mistriwork/mistri/react/headless';

function Applications() {
  const rows = useRows('loan_application', { show: ['id', 'reference', 'status', 'reviewer_id'] });
  const assign = useCommand('assignReviewer');
  const [said, setSaid] = useState('');
  const run = async () => {
    // Reviewer 3 is Robin Bell on the North desk, in the seeded database.
    const outcome = await assign.run({ id: 1 }, { reviewer: 3, reason: 'Assigned from the Next.js front end.' });
    setSaid(`${outcome.status}: ${'message' in outcome ? outcome.message : ''}`);
    void rows.refetch();
  };
  return (
    <main>
      <h1>Applications</h1>
      <ul>
        {rows.data?.map((row) => (
          <li key={String(row.id)}>
            {String(row.reference)} — {String(row.status)} —{' '}
            {row.reviewer_id == null ? 'unassigned' : `reviewer ${String(row.reviewer_id)}`}
          </li>
        ))}
      </ul>
      <button type="button" disabled={!assign.granted} onClick={() => void run()}>
        Assign Robin Bell to the first application
      </button>
      <output>{said}</output>
    </main>
  );
}

export default function Page() {
  return (
    <Provider
      endpoint="/api/mistri"
      app="command-desk"
      surface="applications"
      fallback={
        <p>
          <a href="/api/mistri/sign-in?then=/">Sign in</a> to see the applications.
        </p>
      }
    >
      <Applications />
    </Provider>
  );
}
