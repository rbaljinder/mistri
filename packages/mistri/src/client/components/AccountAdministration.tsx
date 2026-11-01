/**
 * Accounts: who can sign in to this App and the roles each holds, for an
 * administrator (an account holding `admin`), opened from the account menu.
 * Add an account, set its roles, deactivate or reactivate it, give it a new
 * password. Every change is the server's to authorize, make and record
 * (http/accountRoutes.ts); this screen says what it did or why it did not,
 * and shows the record: the history of changes made here (AccountTrail.tsx).
 *
 * One dialog, four places in it: the list, an account, the new account form
 * and the history, every account's or one's. On a phone it fills the screen
 * and the rows of the list and the history stack.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type RefObject } from 'react';
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  ACCOUNTS_PAGE,
  ADMIN_ROLE,
  type AccountSummary,
  type AccountsPage,
} from '../../shared/accountAdministration.js';
import { changeAccount, listAccounts } from '../accountAdministration.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { AccountTrail, roleName } from './AccountTrail.js';
import './AccountAdministration.css';
import { say } from '../copy/account/components/AccountAdministration.js';

type Place = { kind: 'list' } | { kind: 'account'; id: string } | { kind: 'new' } | { kind: 'trail'; id?: string };
type Said = { text: string; tone: 'status' | 'alert' } | null;

export function AccountAdministration({ onClose }: { onClose: () => void }) {
  const owner = useRef(sessionIdentity()).current;
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity);
  const alive = useRef(true);
  const [page, setPage] = useState<AccountsPage | null>(null);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [place, setPlace] = useState<Place>({ kind: 'list' });
  const [said, setSaid] = useState<Said>(null);
  const [loading, setLoading] = useState(true);
  const current = () => alive.current && sessionIdentity() === owner && owner.mode === 'authenticated';
  const heading = useRef<HTMLHeadingElement>(null);

  const load = async (text = search, from = offset) => {
    setLoading(true);
    try {
      const answer = await listAccounts(owner, text, from);
      if (!current()) return;
      setPage(answer);
    } catch (error) {
      if (!current()) return;
      setSaid({ text: error instanceof Error ? error.message : say('theAccountsCouldNotBeLoaded'), tone: 'alert' });
    } finally {
      if (current()) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);
  /* A change moves between places: the new place's heading takes the focus, so a reader is where the words are. */
  useEffect(() => {
    requestAnimationFrame(() => {
      if (current()) heading.current?.focus({ preventScroll: true });
    });
  }, [place.kind]);

  if (identity !== owner || owner.mode !== 'authenticated') return null;
  const account = place.kind === 'account' ? page?.accounts.find((item) => item.id === place.id) : undefined;
  /* One account's history goes back to that account; the whole history, and everything else, to the list. */
  const whose = place.kind === 'trail' && place.id ? page?.accounts.find((item) => item.id === place.id) : undefined;
  /* After a change: the account as the server says it is now, the list read again behind it. */
  const changed = (next: AccountSummary, message: string) => {
    setPage(
      (before) =>
        before && {
          ...before,
          accounts: before.accounts.some((item) => item.id === next.id)
            ? before.accounts.map((item) => (item.id === next.id ? next : item))
            : [next, ...before.accounts],
          total: before.total + (before.accounts.some((item) => item.id === next.id) ? 0 : 1),
        },
    );
    setSaid({ text: message, tone: 'status' });
  };
  /* Not made, or not known to be made: said, assertively, until the next change; the server's words say which. */
  const failed = (error: unknown) =>
    setSaid({ tone: 'alert', text: error instanceof Error ? error.message : say('theChangeCouldNotBeMade') });

  return (
    <Modal className="account-administration" ariaLabel={say('accounts')} onClose={onClose} fullscreen="mobile">
      <header>
        {place.kind === 'list' ? (
          <h2 ref={heading} tabIndex={-1}>
            {say('accounts')}
          </h2>
        ) : whose ? (
          <Button
            intent="quiet"
            onClick={() => {
              setPlace({ kind: 'account', id: whose.id });
              setSaid(null);
            }}
          >
            ← {whose.name || whose.email}
          </Button>
        ) : (
          <Button
            intent="quiet"
            onClick={() => {
              setPlace({ kind: 'list' });
              setSaid(null);
            }}
          >
            {say('allAccounts')}
          </Button>
        )}
        <Button intent="quiet" onClick={onClose} aria-label={say('closeAccounts')}>
          ×
        </Button>
      </header>
      {said && (
        <p className={`account-admin-said ${said.tone}`} role={said.tone}>
          {said.text}
        </p>
      )}
      {place.kind === 'list' && (
        <>
          <p className="note">{say('peopleWhoCanSign')}</p>
          <div className="account-admin-bar">
            <form
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                setOffset(0);
                void load(search, 0);
              }}
            >
              <input
                type="search"
                className="field-control"
                aria-label={say('searchAccountsByEmail')}
                placeholder={say('searchByEmail')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </form>
            <Button
              intent="quiet"
              onClick={() => {
                setSaid(null);
                setPlace({ kind: 'trail' });
              }}
            >
              {say('history')}
            </Button>
            <Button
              intent="primary"
              onClick={() => {
                setSaid(null);
                setPlace({ kind: 'new' });
              }}
            >
              {say('addAccount')}
            </Button>
          </div>
          {loading && !page && <p role="status">{say('loadingAccounts')}</p>}
          {page && !page.accounts.length && (
            <p className="note">{search.trim() ? say('noAccountsEmail', { search: search.trim() }) : say('noAccountsYet')}</p>
          )}
          {/* A list, not a table: each account is one row of three facts, the name its one target. */}
          {page && page.accounts.length > 0 && (
            <>
              <div className="account-admin-heads" aria-hidden="true">
                <span>{say('common.name')}</span>
                <span>{say('rolesHeading')}</span>
                <span>{say('common.status')}</span>
              </div>
              <ul
                className="account-admin-list"
                aria-label={say('accountsOf', { first: page.offset + 1, last: page.offset + page.accounts.length, total: page.total })}
              >
                {page.accounts.map((item) => (
                  <li key={item.id} className={item.active ? undefined : 'inactive'}>
                    <button
                      type="button"
                      className="account-admin-open"
                      onClick={() => {
                        setSaid(null);
                        setPlace({ kind: 'account', id: item.id });
                      }}
                    >
                      <span className="account-admin-name">
                        {item.name || item.email}
                        {item.id === owner.accountId ? ' (you)' : ''}
                      </span>
                      <span className="account-admin-email">{item.email}</span>
                    </button>
                    <span className="account-admin-fact">
                      <span className="account-admin-caption">{say('rolesHeading')} </span>
                      {item.roles.map(roleName).join(', ') || '—'}
                    </span>
                    <span className="account-admin-fact">
                      <span className="account-admin-caption">{say('common.status')} </span>
                      {item.active ? say('active') : say('deactivated')}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {page && page.total > ACCOUNTS_PAGE && (
            <nav className="account-admin-pager" aria-label={say('accountPages')}>
              <span>
                {page.offset + 1}–{page.offset + page.accounts.length} {say('ofTotal', { total: page.total })}
              </span>
              <Button
                intent="secondary"
                size="compact"
                disabled={page.offset === 0 || loading}
                onClick={() => {
                  const from = Math.max(0, page.offset - ACCOUNTS_PAGE);
                  setOffset(from);
                  void load(search, from);
                }}
              >
                {say('previous')}
              </Button>
              <Button
                intent="secondary"
                size="compact"
                disabled={page.offset + page.accounts.length >= page.total || loading}
                onClick={() => {
                  const from = page.offset + ACCOUNTS_PAGE;
                  setOffset(from);
                  void load(search, from);
                }}
              >
                {say('common.next')}
              </Button>
            </nav>
          )}
        </>
      )}
      {place.kind === 'new' && page && (
        <NewAccount
          heading={heading}
          roles={page.roles}
          passwords={page.passwords}
          owner={owner}
          current={current}
          onMade={(made, password) => {
            changed(made, password ? say('canSignInNowWithPassword', { email: made.email }) : say('canSignInNow', { email: made.email }));
            setPlace({ kind: 'account', id: made.id });
          }}
          onFailed={failed}
        />
      )}
      {place.kind === 'account' && account && page && (
        <AccountEditor
          key={account.id}
          heading={heading}
          account={account}
          roles={page.roles}
          passwords={page.passwords}
          self={account.id === owner.accountId}
          owner={owner}
          current={current}
          onChanged={changed}
          onFailed={failed}
          onHistory={() => {
            setSaid(null);
            setPlace({ kind: 'trail', id: account.id });
          }}
        />
      )}
      {place.kind === 'trail' && (
        <section className="account-admin-editor" aria-labelledby="account-admin-trail">
          <h2 id="account-admin-trail" ref={heading} tabIndex={-1}>
            {whose ? say('historyOf', { name: whose.name || whose.email }) : say('history')}
          </h2>
          <p className="note">{say('everyChangeMadeOnThisScreen')}</p>
          <AccountTrail key={place.id ?? ''} owner={owner} current={current} accountId={place.id} />
        </section>
      )}
    </Modal>
  );
}

/** The roles as checkboxes: at least one must stay chosen. */
function RolePicker({
  roles,
  chosen,
  onChange,
  locked,
}: {
  roles: readonly string[];
  chosen: readonly string[];
  onChange: (next: string[]) => void;
  locked?: string;
}) {
  return (
    <fieldset className="account-admin-roles">
      <legend>{say('rolesHeading')}</legend>
      {roles.map((role) => (
        <label key={role}>
          <input
            type="checkbox"
            checked={chosen.includes(role)}
            disabled={role === locked}
            onChange={(event) => onChange(event.target.checked ? [...chosen, role] : chosen.filter((item) => item !== role))}
          />
          {roleName(role)}
          {role === locked ? <span className="account-admin-hint"> {say('yoursToKeep')}</span> : null}
        </label>
      ))}
    </fieldset>
  );
}

interface EditorProps {
  heading: RefObject<HTMLHeadingElement | null>;
  roles: readonly string[];
  passwords: boolean;
  owner: ReturnType<typeof sessionIdentity>;
  current: () => boolean;
  onFailed: (error: unknown) => void;
}

function AccountEditor({
  heading,
  account,
  roles,
  passwords,
  self,
  owner,
  current,
  onChanged,
  onFailed,
  onHistory,
}: EditorProps & {
  account: AccountSummary;
  self: boolean;
  onChanged: (account: AccountSummary, message: string) => void;
  onHistory: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(account.roles);
  const [busy, setBusy] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const run = async (what: string, change: Parameters<typeof changeAccount>[1], message: (next: AccountSummary) => string) => {
    if (busy) return;
    setBusy(what);
    try {
      const next = await changeAccount(owner, change);
      if (current()) onChanged(next, message(next));
    } catch (error) {
      if (current()) onFailed(error);
    } finally {
      if (current()) setBusy(null);
    }
  };
  const same = chosen.length === account.roles.length && chosen.every((role) => account.roles.includes(role));
  return (
    <section className="account-admin-editor" aria-labelledby="account-admin-title">
      <h2 id="account-admin-title" ref={heading} tabIndex={-1}>
        {account.name || account.email}
      </h2>
      <dl className="account-admin-facts">
        <dt>{say('common.email')}</dt>
        <dd>{account.email}</dd>
        <dt>{say('common.status')}</dt>
        <dd>{account.active ? say('active') : say('deactivatedCannotSign')}</dd>
        {account.createdAt && (
          <>
            <dt>{say('common.added')}</dt>
            <dd>{formatDateTime(account.createdAt)}</dd>
          </>
        )}
        <dt>{say('changesLabel')}</dt>
        <dd>
          <Button intent="quiet" size="compact" onClick={onHistory}>
            {say('viewHistory')}
          </Button>
        </dd>
      </dl>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (chosen.length && !same)
            void run('roles', { operation: 'setRoles', accountId: account.id, roles: chosen }, (next) =>
              say('nowHolds', { email: next.email, map: next.roles.map(roleName).join(', ') }),
            );
        }}
      >
        <RolePicker roles={roles} chosen={chosen} onChange={setChosen} locked={self ? ADMIN_ROLE : undefined} />
        {!chosen.length && (
          <p className="account-admin-problem" role="alert">
            {say('chooseAtLeastOne')}
          </p>
        )}
        <div className="form-actions">
          <Button intent="primary" type="submit" busy={busy === 'roles'} busyLabel={say('common.saving')} disabled={!chosen.length || same}>
            {say('saveRoles')}
          </Button>
        </div>
      </form>
      {passwords && (
        <form
          className="account-admin-password"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
              setProblem(say('aPasswordIsToCharacters', { min: PASSWORD_MIN, max: PASSWORD_MAX }));
              return;
            }
            setProblem('');
            void run('password', { operation: 'setPassword', accountId: account.id, password }, (next) =>
              self
                ? say('signsInWithNewPassword', { email: next.email })
                : say('signsInWithNewPasswordSessionsEnded', { email: next.email }),
            ).then(() => setPassword(''));
          }}
        >
          <h3>{say('newPassword')}</h3>
          <Field label={say('common.password')} hint={say('giveItToThem')} problem={problem}>
            <input
              type="password"
              className="field-control"
              autoComplete="new-password"
              value={password}
              maxLength={PASSWORD_MAX}
              onChange={(event) => {
                setPassword(event.target.value);
                if (problem) setProblem('');
              }}
            />
          </Field>
          <div className="form-actions">
            <Button intent="secondary" type="submit" busy={busy === 'password'} busyLabel={say('setting')} disabled={!password}>
              {say('setPassword')}
            </Button>
          </div>
        </form>
      )}
      {!self && (
        <div className="account-admin-access">
          <h3>{say('access')}</h3>
          {account.active ? (
            <>
              <p className="note">{say('deactivatingEndsTheirSessions')}</p>
              <Button
                intent="danger"
                busy={busy === 'active'}
                busyLabel={say('deactivating')}
                onClick={() =>
                  void run('active', { operation: 'deactivate', accountId: account.id }, (next) =>
                    say('isDeactivatedAndSigned', { email: next.email }),
                  )
                }
              >
                {say('deactivateAccount')}
              </Button>
            </>
          ) : (
            <>
              <p className="note">{say('reactivatingLetsThemSign')}</p>
              <Button
                intent="secondary"
                busy={busy === 'active'}
                busyLabel={say('reactivating')}
                onClick={() =>
                  void run('active', { operation: 'reactivate', accountId: account.id }, (next) =>
                    say('canSignInAgain', { email: next.email }),
                  )
                }
              >
                {say('reactivateAccount')}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function NewAccount({
  heading,
  roles,
  passwords,
  owner,
  current,
  onMade,
  onFailed,
}: EditorProps & {
  onMade: (account: AccountSummary, password: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [chosen, setChosen] = useState<string[]>(roles.length ? [roles[0]] : []);
  const [password, setPassword] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = 'Enter their name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) found.email = say('enterAnEmailAddress');
    if (!chosen.length) found.roles = say('chooseAtLeastOne');
    if (passwords && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX))
      found.password = say('aPasswordIsToCharacters', { min: PASSWORD_MIN, max: PASSWORD_MAX });
    setProblems(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const made = await changeAccount(owner, {
        operation: 'create',
        name: name.trim(),
        email: email.trim(),
        roles: chosen,
        ...(passwords ? { password } : {}),
      });
      if (current()) onMade(made, passwords);
    } catch (error) {
      if (current()) onFailed(error);
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <form className="account-admin-editor" onSubmit={(event) => void submit(event)} noValidate aria-labelledby="account-admin-new">
      <h2 id="account-admin-new" ref={heading} tabIndex={-1}>
        {say('addAnAccount')}
      </h2>
      <p className="note">{passwords ? say('theySignInWithThisEmail') : say('theySignInWithThis')}</p>
      <Field label={say('common.name')} required problem={problems.name}>
        <input
          className="field-control"
          autoComplete="off"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label={say('common.email')} required problem={problems.email}>
        <input
          type="email"
          className="field-control"
          autoComplete="off"
          value={email}
          maxLength={254}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <RolePicker roles={roles} chosen={chosen} onChange={setChosen} />
      {problems.roles && (
        <p className="account-admin-problem" role="alert">
          {problems.roles}
        </p>
      )}
      {passwords && (
        <Field label={say('common.password')} required hint={say('giveItToThem')} problem={problems.password}>
          <input
            type="password"
            className="field-control"
            autoComplete="new-password"
            value={password}
            maxLength={PASSWORD_MAX}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
      )}
      <div className="form-actions">
        <Button intent="primary" type="submit" busy={busy} busyLabel={say('adding')}>
          {say('addAccount')}
        </Button>
      </div>
    </form>
  );
}
