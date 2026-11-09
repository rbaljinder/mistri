/**
 * A front end that draws everything itself and uses mistri as its back end
 * (@mistriwork/mistri/react/headless): the Command desk fixture's applications as a plain list, and one button that
 * runs `assignReviewer` on the first one. Nothing here is mistri's but the hooks' answers.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, useCommand, useRows } from '../../../packages/mistri/src/embed/headless.tsx';

function Applications() {
  const rows = useRows('loan_application', { show: ['id', 'reference', 'status', 'reviewer_id'] });
  const assign = useCommand('assignReviewer');
  const [said, setSaid] = useState('');
  const run = async () => {
    const outcome = await assign.run({ id: 1 }, { reviewer: 3, reason: 'Assigned from the headless host.' });
    setSaid(`${outcome.status}: ${'message' in outcome ? outcome.message : ''}`);
    void rows.refetch();
  };
  return (
    <main>
      <h1>Applications</h1>
      <ul aria-label="Applications">
        {rows.data?.map((row) => (
          <li key={String(row.id)}>
            {String(row.reference)} — {String(row.status)} —{' '}
            {row.reviewer_id == null ? 'unassigned' : `reviewer ${String(row.reviewer_id)}`}
          </li>
        ))}
      </ul>
      <p data-granted={String(assign.granted)}>{assign.granted ? 'May assign' : 'May not assign'}</p>
      <button type="button" onClick={() => void run()}>
        Assign Robin Bell
      </button>
      <output>{said}</output>
    </main>
  );
}

createRoot(document.getElementById('host')!).render(
  <Provider endpoint="/api/mistri" app="command-desk-fixture" surface="applications" fallback={<p>Opening</p>}>
    <Applications />
  </Provider>,
);
