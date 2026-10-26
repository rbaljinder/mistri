/**
 * A save that did not load, said where the author is looking.
 *
 * The server keeps serving the last good App and places the failure as
 * `mistri check` would (server/app/appLive.ts): the file and line, the
 * code its words name, the message, and the lines around it. This draws that
 * over the page, which stays usable beneath it — the last good App is still
 * the one being served, and the author may want to look at it while fixing.
 * The next good save takes it away (appLive.ts); Dismiss hides this one
 * until a save fails again.
 *
 * Loaded only while a server follows the App's source: no first page carries
 * it (client appLive.ts).
 */
import type { AppLoadProblem } from '../../shared/appPayload.js';
import { say } from '../copy/shell/components/AppReloadProblem.js';
import './AppReloadProblem.css';

export function AppReloadProblem({ problem, onDismiss }: { problem: AppLoadProblem; onDismiss: () => void }) {
  const where = problem.file
    ? `${problem.file}${problem.line ? `:${problem.line}${problem.column ? `:${problem.column}` : ''}` : ''}`
    : undefined;
  const width = String(problem.frame?.at(-1)?.line ?? 0).length;
  return (
    <section className="app-reload-problem" role="alert" aria-labelledby="app-reload-problem-title">
      <div className="app-reload-problem-head">
        <h2 id="app-reload-problem-title">{say('theLastSaveDidNotLoad')}</h2>
        <button type="button" className="ghost app-reload-problem-dismiss" onClick={onDismiss}>
          {say('dismiss')}
        </button>
      </div>
      <p className="app-reload-problem-where">
        {where ? <code>{where}</code> : null}
        <a href={problem.docs} target="_blank" rel="noreferrer" title={say('aboutThisCode', { code: problem.code })}>
          {problem.code}
        </a>
      </p>
      <p className="app-reload-problem-message">{problem.message}</p>
      {problem.frame?.length ? (
        <pre className="app-reload-problem-frame" aria-label={say('linesAround', { file: problem.file ?? '', line: problem.line ?? 0 })}>
          {problem.frame.map((row) => (
            <span key={row.line} className={row.line === problem.line ? 'is-at' : undefined}>
              <span className="app-reload-problem-line" aria-hidden="true">
                {String(row.line).padStart(width)}
              </span>
              {row.text}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : null}
      <p className="note">{say('stillServingTheLastGoodSave')}</p>
    </section>
  );
}
