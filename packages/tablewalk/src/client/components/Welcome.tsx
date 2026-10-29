/**
 * The screen for someone who has nothing connected yet.
 *
 * It does not pretend to be the app; it says what the tool is before
 * asking for credentials; and it reloads rather than booting a second way,
 * because the ordinary start path is the one with every feature wired in.
 * Why each of those, at length: `welcome.js`.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@mistriwork/kit/client/core.js';
import { addConnection, openConnections } from '../connmanager.js';
import { whenStartupReady } from '@mistriwork/kit/client/startup.js';
import { say } from '../copy/workbench/components/Welcome.js';

/** The shapes a target can take, kept in the order they are likely to be met. */
const EXAMPLES = [
  { label: 'PostgreSQL', text: 'postgres://user@localhost:5432/appdb' },
  { label: 'SQLite', text: './data/app.db' },
];

interface ListedConnection {
  name: string;
  error?: string;
}

export function Welcome({ listed = [] }: { listed?: ListedConnection[] }) {
  const sample = useRef<HTMLButtonElement>(null);
  const [building, setBuilding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(
    () =>
      whenStartupReady(() => {
        sample.current?.focus();
      }),
    [],
  );
  const openSample = async () => {
    setFailure(null);
    setBuilding(true);
    try {
      /* Session-only, built server-side, then a plain reload. */
      await api('/api/connections/demo', {});
      window.location.reload();
    } catch (err) {
      setBuilding(false);
      setFailure(say('couldNotBuildTheSample', { message: (err as Error)?.message ?? err }));
    }
  };
  /* Connections that exist and would not open: the useful move is almost
     always to fix or remove the one that failed, not to add another. */
  const broken = listed.filter((c) => c.error);
  return (
    <div className="welcome">
      {/* The promise, not a status report — the README's own line, deliberately. */}
      <h1>{say('followTheData')}</h1>
      <p className="welcome-lede">{say('openAnyRowAndYouSee')}</p>
      <div className="welcome-actions">
        <button type="button" className="welcome-go" ref={sample} disabled={building} onClick={() => void openSample()}>
          {building ? say('buildingTheSample') : say('openTheSampleDatabase')}
        </button>
        <button type="button" className="ghost welcome-connect" onClick={() => addConnection(() => window.location.reload())}>
          {say('connectADatabase')}
        </button>
        <p className="welcome-error" role="alert" hidden={failure === null}>
          {failure ?? ''}
        </p>
      </div>
      {broken.length ? (
        <div className="welcome-trouble">
          <p className="welcome-trouble-head">
            <strong>
              {broken.length === 1
                ? say('oneConnectionIsConfigured')
                : say('connectionsAreConfiguredAndNone', { brokenCount: broken.length })}
            </strong>
          </p>
          <ul>
            {broken.map((c) => (
              <li key={c.name}>
                <span className="welcome-trouble-name">{c.name}</span>
                <span className="welcome-trouble-why">{c.error}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="ghost" onClick={() => void openConnections()}>
            {say('openConnections')}
          </button>
        </div>
      ) : null}
      <p className="welcome-assure">
        <strong>{say('readOnlyLede')}</strong>
        {say('youTurnEditingOnYourself')}
      </p>
      <div className="welcome-examples">
        <h2>{say('whatToPoint')}</h2>
        <ul>
          {EXAMPLES.map((e) => (
            <li key={e.label}>
              <span className="welcome-ex-label">{e.label}</span>
              <code>{e.text}</code>
            </li>
          ))}
        </ul>
        <p className="note">
          {say('thePasswordDoes')}
          <code>{'${DB_PASSWORD}'}</code>
          {say('andItComesFromTheEnvironment')}
        </p>
        <p className="note">
          {say('toSkipThisNext')}
          <code>tablewalk.json</code>
          {say('whereYouStartTablewalk')}
        </p>
        <pre className="welcome-config">{'{\n  "connections": [\n    { "name": "app", "url": "postgres://localhost/appdb" }\n  ]\n}'}</pre>
      </div>
    </div>
  );
}
