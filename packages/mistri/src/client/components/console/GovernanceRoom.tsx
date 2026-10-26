/**
 * The Console's Governance room (read-only): for one App, who did what (the
 * command journal, searchable by who, what and when, each row linked to the
 * record it changed), what the App lets each role do (its authority.lock as
 * sentences, and what changed in it), and who holds which role (the suite's
 * grants and their changes). Its route answers only an account holding the
 * App's own `admin` role, and sends which fields a command changed, never
 * what to. Roles are changed where they always were: the suite's access
 * page, which the Accounts view links to.
 */
import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Card, Empty, Stack, useViewer } from '@mistriwork/mistri/ui';
import { useAddressState } from '@mistriwork/mistri/page';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { say } from '../../copy/console/components/console/GovernanceRoom.js';
import { consoleRequest, type ConsoleRequest } from './model.js';
import { ConsoleHead, pickApp, useConsoleApp, useLiveRead, useLiveTick, When } from './ConsoleShell.js';
import './ConsoleRoom.css';

type View = 'audit' | 'authority' | 'accounts';
interface GovernanceApp {
  id: string;
  name: string;
  views: View[];
}
interface Person {
  id: string;
  email: string | null;
}
/** A role change from the suite's grant ledger, listed beside the commands. */
interface AccessRow {
  kind: 'access';
  id: string;
  at: string;
  who: Person;
  subject: Person;
  before: string[];
  after: string[];
}
interface CommandRow {
  kind?: undefined;
  id: string;
  at: string;
  who: Person;
  command: string;
  version: number;
  tenant?: string;
  resource?: string;
  href?: string;
  fields: string[];
  targets: number;
}
type AuditRow = CommandRow | AccessRow;
interface Authority {
  startedAt: string;
  locked: boolean;
  groups: { group: string; sentences: { text: string; by: string[] }[] }[];
  since?: string;
  changes: { change: 'added' | 'removed' | 'changed'; group: string; text: string; was?: string }[] | null;
}
interface Accounts {
  accounts: (Person & { roles: string[]; revision: number })[];
  more: boolean;
  changes: { at: string; subject: Person; actor: Person; before: string[]; after: string[] }[];
  manageHref?: string;
}
/** A tenant App's accounts: the tenants the caller's administration grant names, and one tenant's members. */
interface TenantAccounts {
  tenants: { id: string; name?: string; status: string | null; members: boolean }[];
  next?: string;
  chosen?: {
    id: string;
    members: (Person & { status: string; roles: string[]; validUntil: string })[];
    next?: string;
  };
  href: string;
  supportSessions: boolean;
  apiTokens: boolean;
}
interface AuditFilter {
  who?: string;
  what?: string;
  from?: string;
  to?: string;
}

const VIEWS: readonly View[] = ['audit', 'authority', 'accounts'];
const VIEW_WORD: Record<View, () => string> = {
  audit: () => say('audit'),
  authority: () => say('authority'),
  accounts: () => say('accounts'),
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function failure(code: string | undefined, message: string) {
  const said =
    code === 'not_granted'
      ? say('notGranted')
      : code === 'invalid_request'
        ? say('invalid')
        : code === 'unavailable'
          ? say('unavailable')
          : undefined;
  return said ?? (message || say('refused'));
}
/** A sentence's `names` drawn as code, the rest as text. */
function Words({ text }: { text: string }) {
  const parts = text.split(/`([^`]*)`/);
  return <span>{parts.map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}</span>;
}
const personWord = (person: Person) => person.email ?? person.id;
const groupWord = (group: string) =>
  group.startsWith('role:')
    ? say('groupRole', { role: group.slice(5) })
    : ((
        {
          'sign-in': () => say('groupSignIn'),
          data: () => say('groupData'),
          public: () => say('groupPublic'),
          api: () => say('groupApi'),
          flags: () => say('groupFlags'),
          environment: () => say('groupEnvironment'),
        } as Record<string, () => string>
      )[group]?.() ?? group);

export default function GovernanceRoom({ props }: { props: { endpoint: string } }) {
  useMessageLanguage();
  const viewer = useViewer();
  const request = useMemo(() => consoleRequest(props.endpoint, viewer.account ?? ''), [props.endpoint, viewer.account]);
  const [app, chooseApp] = useConsoleApp();
  const [view, setView] = useAddressState('view');
  const [who, setWho] = useAddressState('who'),
    [what, setWhat] = useAddressState('what'),
    [from, setFrom] = useAddressState('from'),
    [to, setTo] = useAddressState('to');
  if (!viewer.signedIn || !viewer.account) return <Empty title={say('signIn')} />;
  return (
    <GovernancePanel
      key={viewer.account}
      request={request}
      appId={app}
      view={(VIEWS as readonly string[]).includes(view ?? '') ? (view as View) : undefined}
      filter={{ who, what, from, to }}
      chooseView={(next) => setView(next === 'audit' ? undefined : next, { push: true })}
      chooseApp={chooseApp}
      chooseFilter={(next) => {
        setWho(next.who || undefined);
        setWhat(next.what || undefined);
        setFrom(next.from || undefined);
        setTo(next.to || undefined, { push: true });
      }}
    />
  );
}

export function GovernancePanel({
  request,
  appId,
  view: asked,
  filter = {},
  chooseView,
  chooseApp,
  chooseFilter,
}: {
  request: ConsoleRequest;
  appId?: string;
  view?: View;
  filter?: AuditFilter;
  chooseView?(view: View): void;
  chooseApp(app: { id: string; name: string }): void;
  chooseFilter?(filter: AuditFilter): void;
}) {
  useMessageLanguage();
  const [tick, refresh] = useLiveTick();
  const catalog = useLiveRead<{ apps: GovernanceApp[] }>(request, '/governance');
  const apps = catalog?.data?.apps ?? [];
  const app = pickApp(apps, appId);
  const views = VIEWS.filter((name) => app?.views.includes(name));
  const view = asked && views.includes(asked) ? asked : (views[0] ?? 'authority');
  // The older pages walked so far: the first is the newest, each next one the cursor of the page before.
  const [pages, setPages] = useState<string[]>([]);
  // A tenant App's Accounts: which tenant's members are open, and the page of each list.
  const [tenant, setTenant] = useState<{ id?: string; after?: string; members?: string }>({});
  const query = new URLSearchParams();
  if (view === 'audit') {
    if (filter.who) query.set('who', filter.who);
    if (filter.what) query.set('what', filter.what);
    if (filter.from && DATE.test(filter.from)) query.set('from', filter.from);
    if (filter.to && DATE.test(filter.to)) query.set('to', filter.to);
    if (pages.length) query.set('before', pages.at(-1)!);
  }
  if (view === 'accounts') {
    if (tenant.id) query.set('tenant', tenant.id);
    if (tenant.after) query.set('after', tenant.after);
    if (tenant.id && tenant.members) query.set('members', tenant.members);
  }
  const path = app ? `/governance/${app.id}/${view}${query.size ? `?${query}` : ''}` : undefined;
  const read = useLiveRead<unknown>(request, path, tick);
  const tabId = useId(),
    tabs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <Stack className="console-workspace">
      {catalog?.error && (
        <p className="console-problem" role="alert">
          {failure(catalog.code, catalog.error)}
        </p>
      )}
      {!catalog ? (
        <p role="status">{say('loadingApps')}</p>
      ) : !apps.length ? (
        <Empty title={say('noApps')} description={say('noAppsDetail')} />
      ) : (
        <>
          <ConsoleHead
            title={say('title')}
            apps={apps}
            app={app}
            onApp={(next) => {
              setPages([]);
              setTenant({});
              chooseApp(next);
            }}
            live={{ at: read?.at, pending: read?.pending ?? true, onRefresh: refresh }}
          />
          {read?.error && (
            <p className="console-problem" role="alert">
              {failure(read.code, read.error)}
            </p>
          )}
          <Stack className="page-tabs">
            <div className="page-tabstrip" role="tablist" aria-label={say('views')}>
              {views.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  className="page-tab"
                  role="tab"
                  id={`${tabId}-${name}`}
                  aria-controls={`${tabId}-panel`}
                  aria-selected={view === name}
                  tabIndex={view === name ? 0 : -1}
                  ref={(node) => {
                    tabs.current[index] = node;
                  }}
                  onClick={() => chooseView?.(name)}
                  onKeyDown={(key) => {
                    const step = key.key === 'ArrowRight' ? 1 : key.key === 'ArrowLeft' ? -1 : 0;
                    if (!step) return;
                    key.preventDefault();
                    const next = (index + step + views.length) % views.length;
                    chooseView?.(views[next]);
                    tabs.current[next]?.focus();
                  }}
                >
                  {VIEW_WORD[name]()}
                </button>
              ))}
            </div>
            <div className="page-tabpanel" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${view}`}>
              {view === 'audit' && (
                <AuditFilters
                  filter={filter}
                  choose={(next) => {
                    setPages([]);
                    chooseFilter?.(next);
                  }}
                />
              )}
              {!read?.data || !read.current ? (
                !read?.error && (
                  <p role="status" className="console-reading">
                    {say('loading')}
                  </p>
                )
              ) : view === 'audit' ? (
                <AuditLog
                  data={read.data as { rows: AuditRow[]; next?: string }}
                  newer={pages.length ? () => setPages(pages.slice(0, -1)) : undefined}
                  older={(cursor) => setPages([...pages, cursor])}
                />
              ) : view === 'authority' ? (
                <AuthorityView data={read.data as Authority} />
              ) : 'tenants' in (read.data as object) ? (
                <TenantAccountsView data={read.data as TenantAccounts} appName={app?.name ?? ''} choose={setTenant} at={tenant} />
              ) : (
                <AccountsView data={read.data as Accounts} />
              )}
            </div>
          </Stack>
        </>
      )}
    </Stack>
  );
}

function AuditFilters({ filter, choose }: { filter: AuditFilter; choose(filter: AuditFilter): void }) {
  // A draft until Search: each keystroke is not a read.
  const [draft, setDraft] = useState<AuditFilter>(filter);
  const field = (name: keyof AuditFilter, label: string, type: 'text' | 'date', hint?: string) => (
    <label>
      <span>{label}</span>
      <input
        type={type}
        value={draft[name] ?? ''}
        placeholder={hint}
        maxLength={320}
        onChange={(change) => setDraft({ ...draft, [name]: change.target.value })}
      />
    </label>
  );
  return (
    <form
      className="console-filter"
      role="search"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        choose(draft);
      }}
    >
      <span className="console-dates">
        {field('who', say('who'), 'text', say('whoHint'))}
        {field('what', say('what'), 'text', say('whatHint'))}
        {field('from', say('from'), 'date')}
        {field('to', say('to'), 'date')}
      </span>
      <span className="console-dates">
        <button type="submit" className="console-open">
          {say('search')}
        </button>
        {(filter.who || filter.what || filter.from || filter.to) && (
          <button
            type="button"
            className="console-open"
            onClick={() => {
              setDraft({});
              choose({});
            }}
          >
            {say('clear')}
          </button>
        )}
      </span>
    </form>
  );
}

const isAccess = (row: AuditRow): row is AccessRow => row.kind === 'access';

/** A role change: who changed it, for whom, from which roles to which, where a command's record and fields would be. */
function AccessLine({ row }: { row: AccessRow }) {
  return (
    <tr>
      <td>
        <When at={row.at} />
      </td>
      <td title={row.who.id}>{personWord(row.who)}</td>
      <td>{say('rolesChanged')}</td>
      <td title={row.subject.id}>{personWord(row.subject)}</td>
      <td className="console-wide">
        {roleList(row.before)} → {roleList(row.after)}
      </td>
    </tr>
  );
}

function CommandLine({ row }: { row: CommandRow }) {
  return (
    <tr>
      <td>
        <When at={row.at} />
      </td>
      <td title={row.who.id}>{personWord(row.who)}</td>
      <td>
        <code className="console-code">{row.command}</code>
      </td>
      <td>
        {row.href ? <a href={row.href}>{row.resource}</a> : (row.resource ?? <span className="console-faint">—</span>)}
        {row.targets > 1 && <span className="console-caption"> {say('moreTargets', { count: row.targets - 1 })}</span>}
      </td>
      <td className="console-wide">
        {row.fields.length ? row.fields.join(', ') : <span className="console-faint">{say('noFields')}</span>}
      </td>
    </tr>
  );
}

function AuditLog({ data, newer, older }: { data: { rows: AuditRow[]; next?: string }; newer?: () => void; older(cursor: string): void }) {
  if (!data.rows.length) return <Empty title={say('noAudit')} description={say('noAuditDetail')} />;
  return (
    <Stack gap="tight">
      <div className="console-scroll">
        <table className="console-table">
          <caption className="console-sr">{say('audit')}</caption>
          <thead>
            <tr>
              <th scope="col">{say('when')}</th>
              <th scope="col">{say('who')}</th>
              <th scope="col">{say('command')}</th>
              <th scope="col">{say('record')}</th>
              <th scope="col" className="console-wide">
                {say('fields')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) =>
              isAccess(row) ? <AccessLine key={`access-${row.id}`} row={row} /> : <CommandLine key={row.id} row={row} />,
            )}
          </tbody>
        </table>
      </div>
      <p className="console-caption">{say('auditCaption')}</p>
      {(newer || data.next) && (
        <span className="console-dates">
          {newer && (
            <button type="button" className="console-open" onClick={newer}>
              {say('newer')}
            </button>
          )}
          {data.next && (
            <button type="button" className="console-open" onClick={() => older(data.next!)}>
              {say('older')}
            </button>
          )}
        </span>
      )}
    </Stack>
  );
}

function AuthorityView({ data }: { data: Authority }) {
  return (
    <Stack>
      <Card>
        <p>
          <span className="console-strong">{say('started')}</span> <When at={data.startedAt} />
        </p>
        <p className="console-caption">{data.locked ? say('locked') : say('unlocked')}</p>
      </Card>
      <Card title={data.since ? `${say('changes')} · ${say('changesSince', { when: data.since.slice(0, 10) })}` : say('changes')}>
        {data.changes === null ? (
          <p className="console-caption">{say('noHistory')}</p>
        ) : !data.changes.length ? (
          <p className="console-caption">{say('noChanges')}</p>
        ) : (
          <ul className="console-diff">
            {data.changes.map((change, index) => (
              <li key={index}>
                <span className="console-diff-what">{groupWord(change.group)}</span>
                {change.was ? <span className="console-diff-was">{<Words text={change.was} />}</span> : <span />}
                <span className="console-diff-arrow">{change.was ? '→' : ''}</span>
                <span className={change.change === 'removed' ? 'console-down' : change.change === 'added' ? 'console-up' : undefined}>
                  <Words text={change.text} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {data.groups.map((group) => (
        <Card key={group.group} title={groupWord(group.group)}>
          <ul className="console-sentences">
            {group.sentences.map((sentence, index) => (
              <li key={index}>
                <Words text={sentence.text} />
                {sentence.by.length > 0 && <span className="console-caption">{say('grantedBy', { who: sentence.by.join(', ') })}</span>}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </Stack>
  );
}

const roleList = (list: string[]): ReactNode => (list.length ? list.join(', ') : <span className="console-faint">{say('noRoles')}</span>);

function AccountsView({ data }: { data: Accounts }) {
  return (
    <Stack>
      <Card title={say('accounts')}>
        {!data.accounts.length ? (
          <p className="console-caption">{say('noAccounts')}</p>
        ) : (
          <div className="console-scroll">
            <table className="console-table">
              <caption className="console-sr">{say('accounts')}</caption>
              <thead>
                <tr>
                  <th scope="col">{say('account')}</th>
                  <th scope="col">{say('roles')}</th>
                  <th scope="col" className="console-num console-wide">
                    {say('revision')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((account) => (
                  <tr key={account.id}>
                    <td title={account.id}>{personWord(account)}</td>
                    <td>{roleList(account.roles)}</td>
                    <td className="console-num console-wide">{account.revision}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.more && <p className="console-caption">{say('moreAccounts')}</p>}
        {data.manageHref && (
          <p className="console-caption">
            <a href={data.manageHref}>{say('manage')}</a> · {say('manageDetail')}
          </p>
        )}
      </Card>
      <Card title={say('accessChanges')}>
        {!data.changes.length ? (
          <p className="console-caption">{say('noAccessChanges')}</p>
        ) : (
          <div className="console-scroll">
            <table className="console-table">
              <caption className="console-sr">{say('accessChanges')}</caption>
              <thead>
                <tr>
                  <th scope="col">{say('when')}</th>
                  <th scope="col">{say('account')}</th>
                  <th scope="col">{say('change')}</th>
                  <th scope="col" className="console-wide">
                    {say('by')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.changes.map((change, index) => (
                  <tr key={index}>
                    <td>
                      <When at={change.at} />
                    </td>
                    <td title={change.subject.id}>{personWord(change.subject)}</td>
                    <td>
                      <span className="console-diff-was">{roleList(change.before)}</span> → {roleList(change.after)}
                    </td>
                    <td className="console-wide" title={change.actor.id}>
                      {personWord(change.actor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title={say('tokens')}>
        <p className="console-caption">{say('tokensNone')}</p>
      </Card>
      <Card title={say('support')}>
        <p className="console-caption">{say('supportNone')}</p>
      </Card>
    </Stack>
  );
}

/**
 * A tenant App's accounts, read through its own membership administration:
 * the tenants the caller's grant names, and one tenant's members within the
 * roles it reaches. Support sessions and API tokens are the App's own screens,
 * read on the leases that admit them, and the room says where.
 */
function TenantAccountsView({
  data,
  appName,
  at,
  choose,
}: {
  data: TenantAccounts;
  appName: string;
  at: { id?: string; after?: string; members?: string };
  choose(next: { id?: string; after?: string; members?: string }): void;
}) {
  return (
    <Stack>
      <Card title={say('tenants')}>
        {!data.tenants.length ? (
          <p className="console-caption">{say('noTenants')}</p>
        ) : (
          <div className="console-scroll">
            <table className="console-table">
              <caption className="console-sr">{say('tenants')}</caption>
              <thead>
                <tr>
                  <th scope="col">{say('tenant')}</th>
                  <th scope="col">{say('status')}</th>
                  <th scope="col" className="console-wide">
                    <span className="console-sr">{say('members')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((item) => (
                  <tr key={item.id} aria-current={item.id === data.chosen?.id ? 'true' : undefined}>
                    <td title={item.id}>{item.name ?? item.id}</td>
                    <td>{item.status ?? <span className="console-faint">{say('notCreated')}</span>}</td>
                    <td className="console-wide">
                      {item.members && item.id !== data.chosen?.id && (
                        <button type="button" className="console-open" onClick={() => choose({ ...at, id: item.id, members: undefined })}>
                          {say('showMembers')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(at.after || data.next) && (
          <span className="console-dates">
            {at.after && (
              <button type="button" className="console-open" onClick={() => choose({ id: at.id, after: undefined })}>
                {say('first')}
              </button>
            )}
            {data.next && (
              <button type="button" className="console-open" onClick={() => choose({ id: at.id, after: data.next })}>
                {say('older')}
              </button>
            )}
          </span>
        )}
      </Card>
      {data.chosen && (
        <Card title={say('membersOf', { tenant: data.tenants.find((item) => item.id === data.chosen!.id)?.name ?? data.chosen.id })}>
          {!data.chosen.members.length ? (
            <p className="console-caption">{say('noMembers')}</p>
          ) : (
            <div className="console-scroll">
              <table className="console-table">
                <caption className="console-sr">{say('members')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{say('account')}</th>
                    <th scope="col">{say('roles')}</th>
                    <th scope="col">{say('status')}</th>
                    <th scope="col" className="console-wide">
                      {say('until')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.chosen.members.map((member) => (
                    <tr key={member.id}>
                      <td title={member.id}>{personWord(member)}</td>
                      <td>{roleList(member.roles)}</td>
                      <td>{member.status}</td>
                      <td className="console-wide">
                        <When at={member.validUntil} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.chosen.next && (
            <button type="button" className="console-open" onClick={() => choose({ ...at, members: data.chosen!.next })}>
              {say('older')}
            </button>
          )}
        </Card>
      )}
      <Card title={say('elsewhere')}>
        <p className="console-caption">{say('tenantManage')}</p>
        {data.supportSessions && <p className="console-caption">{say('tenantSupport')}</p>}
        {data.apiTokens && <p className="console-caption">{say('tenantTokens')}</p>}
        <p>
          <a href={data.href}>{say('openApp', { app: appName })}</a>
        </p>
      </Card>
    </Stack>
  );
}
