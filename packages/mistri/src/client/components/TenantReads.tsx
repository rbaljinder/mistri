/**
 * Who saw this organization's records, in Settings, over /api/reads on the tenant's own lease (tenantReadsRoute.ts):
 * each read of an audited resource, newest first, a page at a time, filtered by person, record and time. The server
 * decides who may read it (the tenant's admins) and whose rows these are (the lease's tenant, never the request's),
 * so this only draws what it is given. A record's id is matched where it was opened and in every list that showed it,
 * because a list is how most records are seen (a field report).
 */
import { useCallback, useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { api } from '@mistriwork/kit/client/core.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { navFollow } from '@mistriwork/kit/client/shellHost.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';
import { sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { Select } from '@mistriwork/ui/Select.js';
import { recordHref } from '../publicAddress.js';
import './TenantReads.css';
import { say } from '../copy/tenancy/components/TenantReads.js';

type Route = 'page' | 'api' | 'mcp' | 'assistant' | 'export' | 'picker' | 'custom-page' | 'related' | 'command';
interface Read {
  id: number;
  at: string;
  actor: string;
  person?: string;
  resource: string;
  route: Route;
  kind: 'opened' | 'listed';
  record?: string;
  count?: number;
}
interface Page {
  reads: Read[];
  next?: number;
  resources: string[];
}
interface Filters {
  actor?: string;
  resource?: string;
  record?: string;
  /** Dates as the date inputs hold them, YYYY-MM-DD in the reader's own day. */
  from?: string;
  to?: string;
}
type Reply = Record<string, unknown> & { error?: string };

const ROUTE_WORD: Record<Route, () => string> = {
  page: () => say('routePage'),
  api: () => say('routeApi'),
  mcp: () => say('routeMcp'),
  assistant: () => say('routeAssistant'),
  export: () => say('routeExport'),
  picker: () => say('routePicker'),
  'custom-page': () => say('routeCustomPage'),
  related: () => say('routeRelated'),
  command: () => say('routeCommand'),
};

/** The person a row names, as a reader would say it: the sign-in store's name, else what kind of reader it was. */
function who(read: Read): string {
  const { actor, person } = read;
  if (actor === 'public') return say('visitor');
  if (actor.startsWith('assistant:')) return say('assistant', { who: person ?? actor.slice('assistant:'.length) });
  if (actor.startsWith('support:')) return say('support');
  if (actor.startsWith('api-token:')) return say('token');
  if (actor.startsWith('service:')) return say('service');
  return person ?? actor;
}

/** The day's start in the reader's own zone, as the instant the server compares. */
const dayStart = (date: string, plusDays = 0): string | undefined => {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day + plusDays).toISOString();
};

/** The body a page of reads is asked with: `to` is the whole of its day, so the instant sent is the next day's start. */
function body(filters: Filters, before?: number): Record<string, unknown> {
  const since = filters.from ? dayStart(filters.from) : undefined;
  const until = filters.to ? dayStart(filters.to, 1) : undefined;
  return {
    ...(filters.actor ? { actor: filters.actor } : {}),
    ...(filters.resource ? { resource: filters.resource } : {}),
    ...(filters.record ? { record: filters.record } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(before !== undefined ? { before } : {}),
  };
}

/** An in-App address as the shell writes it for this session: a tenant's carries its selector (sdk/host.tsx). */
function tenantQualified(href: string): string {
  const { tenant } = sessionIdentity();
  const qualify = shell().tenantLinks?.qualify;
  if (!tenant || !qualify) return href;
  try {
    return qualify(href, tenant.appId, tenant.tenantId);
  } catch {
    return href;
  }
}

function RecordLink({ resource, record }: { resource: string; record: string }) {
  const href = recordHref(resource, record);
  if (!href) return <code>{record}</code>;
  const to = tenantQualified(href);
  return (
    <a
      href={to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navFollow(to);
      }}
    >
      <code>{record}</code>
    </a>
  );
}

export function TenantReads() {
  const [filters, setFilters] = useState<Filters>({});
  const [draft, setDraft] = useState<Filters>({});
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<'load' | 'older' | null>('load');
  const load = useCallback(async (asked: Filters) => {
    setBusy('load');
    try {
      const got = (await api('/api/reads', body(asked))) as Reply;
      if (got.error) return setError(got.error);
      setPage(got as unknown as Page);
      setError(undefined);
    } catch {
      setError(say('failed'));
    } finally {
      setBusy(null);
    }
  }, []);
  useEffect(() => {
    void load(filters);
  }, [load, filters]);
  const older = async () => {
    if (!page?.next || busy) return;
    setBusy('older');
    try {
      const got = (await api('/api/reads', body(filters, page.next))) as Reply;
      if (got.error) return setError(got.error);
      const more = got as unknown as Page;
      setPage({ ...more, reads: [...page.reads, ...more.reads] });
      setError(undefined);
    } catch {
      setError(say('failed'));
    } finally {
      setBusy(null);
    }
  };
  const apply = (event: FormEvent) => {
    event.preventDefault();
    setFilters({ ...draft, record: draft.record?.trim() || undefined });
  };
  const byPerson = (read: Read) => {
    const next = { ...filters, actor: read.actor };
    setDraft({ ...draft, actor: read.actor });
    setFilters(next);
  };
  const filtered = Object.values(filters).some(Boolean);
  const named = filters.actor ? page?.reads.find((read) => read.actor === filters.actor) : undefined;
  return (
    <div className="reads">
      <form className="reads-filters" onSubmit={apply}>
        <Select
          label={say('resource')}
          options={[{ value: '', label: say('anyResource') }, ...(page?.resources ?? []).map((name) => ({ value: name, label: name }))]}
          value={draft.resource ?? ''}
          onValueChange={(value: string) => setDraft({ ...draft, resource: value || undefined })}
          reserve={false}
        />
        <Field label={say('record')} hint={say('recordHint')} size="sm">
          <input
            data-slot="input"
            value={draft.record ?? ''}
            autoCapitalize="none"
            spellCheck={false}
            maxLength={2048}
            onChange={(event) => setDraft({ ...draft, record: event.target.value })}
          />
        </Field>
        <Field label={say('from')} size="sm">
          <input
            data-slot="input"
            type="date"
            value={draft.from ?? ''}
            onChange={(event) => setDraft({ ...draft, from: event.target.value || undefined })}
          />
        </Field>
        <Field label={say('to')} size="sm">
          <input
            data-slot="input"
            type="date"
            value={draft.to ?? ''}
            onChange={(event) => setDraft({ ...draft, to: event.target.value || undefined })}
          />
        </Field>
        <div className="reads-apply">
          <Button variant="primary" size="sm" type="submit">
            {say('apply')}
          </Button>
          {filtered && (
            <Button
              size="sm"
              onClick={() => {
                setDraft({});
                setFilters({});
              }}
            >
              {say('clear')}
            </Button>
          )}
        </div>
      </form>
      {filters.actor && (
        <p className="reads-person">
          <span>{say('person', { who: named ? who(named) : filters.actor })}</span>
          <Button
            size="sm"
            onClick={() => {
              setDraft({ ...draft, actor: undefined });
              setFilters({ ...filters, actor: undefined });
            }}
          >
            {say('removePerson')}
          </Button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p role="status">{say('loading')}</p>}
      {page && !page.reads.length && <p className="reads-dim">{say('none')}</p>}
      {page && page.reads.length > 0 && (
        <ul className="reads-list">
          {page.reads.map((read) => (
            <li key={read.id} data-kind={read.kind}>
              <time className="reads-at" dateTime={read.at}>
                {formatDateTime(read.at)}
              </time>
              {filters.actor === read.actor ? (
                <span className="reads-who">{who(read)}</span>
              ) : (
                <button type="button" className="reads-who" title={say('onlyPerson', { who: who(read) })} onClick={() => byPerson(read)}>
                  {who(read)}
                </button>
              )}
              <span className="reads-what">
                {read.kind === 'opened' && read.record !== undefined ? (
                  <>
                    {say('opened', { resource: read.resource })} <RecordLink resource={read.resource} record={read.record} />
                  </>
                ) : (
                  say('listed', { resource: read.resource, count: read.count ?? 0 })
                )}
                <span className="reads-dim"> · {say('via', { route: ROUTE_WORD[read.route]?.() ?? read.route })}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {page?.next !== undefined && (
        <Button size="sm" loading={busy === 'older'} loadingLabel={say('loadingOlder')} onClick={() => void older()}>
          {say('older')}
        </Button>
      )}
    </div>
  );
}
