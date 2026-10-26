/**
 * The two sentences a part of a screen says instead of its content: that
 * there is nothing here yet (`Empty`), and that it could not be shown
 * (`Problem`). Every section, list, lane and dashboard card says them this
 * way, so an empty place and a broken one read the same wherever they are.
 *
 * Both sit on the section's own edge at body size. An empty place is a
 * plain sentence with, at most, the one thing to do next; it is not a
 * heading louder than the section it is in. A problem is a warn mark, the
 * reader's sentence and Try again — never a dead end that only a reload
 * gets out of. Offline is said as offline, because it is the one cause the
 * reader can see and fix.
 *
 * A page that fails one way fails in several places at once — each of a
 * record's sections asks for the same row — and five copies of one sentence
 * read as five problems. Inside a `ProblemScope` the first place to say a
 * sentence says it in full; the rest say only that they are not loaded, for
 * that reason. Try again asks every failed question on the screen again,
 * not only its own, so the one full note can speak for all of them.
 */
import { createContext, useContext, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { message } from '../messages.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Icon } from './Icon.js';
import { useMessageLanguage } from './useMessageLanguage.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

/** Which place first said each sentence, for the places that follow it. */
const ProblemScope = createContext<Map<string, string> | null>(null);

/** A fresh scope for one screen; a scope outlives none of its places. */
export function ProblemScopeProvider({ children }: { children: ReactNode }) {
  const [owners] = useState(() => new Map<string, string>());
  return <ProblemScope.Provider value={owners}>{children}</ProblemScope.Provider>;
}

function subscribeOnline(listener: () => void): () => void {
  addHostListener(window, 'online', listener);
  addHostListener(window, 'offline', listener);
  return () => {
    removeHostListener(window, 'online', listener);
    removeHostListener(window, 'offline', listener);
  };
}
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * A part of the screen that could not be shown. `retry` is for what is not
 * a question — a boundary putting its section back; the failed questions
 * on the screen are asked again either way. `crashed` marks a part that
 * threw while drawing (`data-section-error`): a bug, not a refusal, and the
 * browser suites fail on it, since a caught error raises no page error.
 */
export function Problem({ text, retry, crashed = false }: { text: string; retry?: () => void; crashed?: boolean }) {
  useMessageLanguage();
  const isOnline = useSyncExternalStore(subscribeOnline, online, () => true);
  const client = useContext(QueryClientContext);
  const scope = useContext(ProblemScope);
  const id = useId();
  /* Offline outranks whatever the request said: it is why, and the reader can act on it. */
  const said = !crashed && !isOnline ? message('problem.offline') : text;
  if (scope && !scope.has(said)) scope.set(said, id);
  const first = !scope || scope.get(said) === id;
  useEffect(
    () => () => {
      if (scope?.get(said) === id) scope.delete(said);
    },
    [scope, said, id],
  );
  if (!first && !crashed) return <p className="problem problem-repeat">{message('problem.sameAbove')}</p>;
  const again = () => {
    retry?.();
    void client?.refetchQueries({ type: 'active', predicate: (query) => query.state.status === 'error' });
  };
  return (
    <div className="problem" role="alert" {...(crashed ? { 'data-section-error': '' } : {})}>
      <Icon name="warning" className="problem-mark" />
      <p className="problem-text">{said}</p>
      <Button size="compact" className="problem-retry" onClick={again}>
        {message('problem.retry')}
      </Button>
    </div>
  );
}

/**
 * The state block, one shape for three states (`Empty`, `Refused`, and `Problem` above): a mark, one line at body
 * size, an optional muted second line, and at most one compact action. It stands on the section's own edge; a
 * look dresses it through the tokens it already sets (ink, line, the warning ink for a failure).
 */
function StateBlock({
  mark,
  text,
  detail,
  action,
  className,
  role,
}: {
  mark: 'tray' | 'lock' | null;
  text: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className: string;
  role?: 'status';
}) {
  return (
    <div className={className} {...(role ? { role } : {})}>
      {mark ? <Icon name={mark} className="empty-note-mark" /> : null}
      <p className="empty-note-text">
        {text}
        {detail ? (
          <>
            {' '}
            <span className="empty-note-detail">{detail}</span>
          </>
        ) : null}
      </p>
      {action ? <div className="empty-note-action">{action}</div> : null}
    </div>
  );
}

/**
 * A place with nothing in it yet: one sentence at body size, a second one
 * that says what belongs here when there is one, and the way to add it.
 */
export function Empty({
  text,
  detail,
  action,
  className = '',
  mark = 'tray',
}: {
  text: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** The block's mark; none where the place is too small to carry one. */
  mark?: 'tray' | null;
}) {
  return <StateBlock mark={mark} text={text} detail={detail} action={action} className={`empty-note${className ? ` ${className}` : ''}`} />;
}

/**
 * A place the reader may not see: the same block under a lock, said as a status. What it says is the view's own
 * title and the noun it is (a page, a form, a record, a list), never a bare line.
 */
export function Refused({
  text,
  detail,
  action,
  className = '',
}: {
  text: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <StateBlock
      mark="lock"
      role="status"
      text={text}
      detail={detail}
      action={action}
      className={`empty-note is-refused${className ? ` ${className}` : ''}`}
    />
  );
}
