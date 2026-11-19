/**
 * The addresses a tenant's pages answer on, in Settings, over the routes its lease already answers (/api/domains,
 * /add, /check, /remove, /primary in tenantHttp.ts). Any member reads the list; the suite's domain editors add a
 * domain of their own, see the two DNS records that prove it, and ask for a check. The server decides who is an
 * editor and withholds the records (which carry the verification token) from everyone else, so this only draws
 * what it is given. A domain goes live by itself once DNS and its certificate are in order: the panel never says
 * a domain is live before the server does.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@mistriwork/kit/client/core.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import './TenantDomains.css';
import { say } from '../copy/tenancy/components/TenantDomains.js';

interface DnsRecord {
  type: 'CNAME' | 'TXT';
  name: string;
  value: string;
}
interface Domain {
  host: string;
  kind: 'subdomain' | 'custom';
  status: 'pending' | 'verified' | 'live' | 'suspended';
  primary: boolean;
  claimed: boolean;
  checkedAt: number | null;
  /** A pending claim's last day: it is dropped then unless a check has verified it (server http/customDomains.ts). */
  expiresAt?: number;
  records?: { cname: DnsRecord; txt: DnsRecord; apex: boolean };
}
interface Listing {
  domains: Domain[];
  limit: number;
  editor: boolean;
}
type Reply = Record<string, unknown> & { error?: string };

function Copyable({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="domains-copyable">
      <code>{value}</code>
      <Button
        size="compact"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? say('copied') : say('copy')}
      </Button>
    </span>
  );
}

function Records({ records, host }: { records: NonNullable<Domain['records']>; host: string }) {
  return (
    <div className="domains-records">
      <p>{say('records')}</p>
      <table>
        <thead>
          <tr>
            <th scope="col">{say('type')}</th>
            <th scope="col">{say('name')}</th>
            <th scope="col">{say('value')}</th>
          </tr>
        </thead>
        <tbody>
          {[records.cname, records.txt].map((record) => (
            <tr key={record.type}>
              <td>{record.type}</td>
              <td>
                <Copyable value={record.name} label={say('copyWhat', { type: record.type, part: say('name').toLowerCase() })} />
              </td>
              <td>
                <Copyable value={record.value} label={say('copyWhat', { type: record.type, part: say('value').toLowerCase() })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {records.apex && <p className="domains-dim">{say('apex', { host })}</p>}
    </div>
  );
}

export function TenantDomains() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const got = (await api('/api/domains', {})) as Reply;
      if (got.error) return setError(got.error);
      setListing(got as unknown as Listing);
      setError(undefined);
    } catch {
      setError(say('failed'));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  /* Every change answers with the whole list, so what is drawn is always the server's latest word. */
  const ask = async (
    path: '/api/domains/add' | '/api/domains/check' | '/api/domains/primary' | '/api/domains/remove',
    target: string,
    key: string,
  ): Promise<Reply | undefined> => {
    if (busy) return undefined;
    setBusy(key);
    setNotice(undefined);
    try {
      const got = (await api(path, { host: target })) as Reply;
      if (got.error) {
        setError(got.error);
        return undefined;
      }
      setError(undefined);
      setListing(got as unknown as Listing);
      return got;
    } catch {
      setError(say('failed'));
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!host.trim()) return;
    if (await ask('/api/domains/add', host.trim(), 'add')) setHost('');
  };
  const check = async (target: string) => {
    const got = await ask('/api/domains/check', target, `check:${target}`);
    if (got)
      setNotice(got.outcome === 'ok' ? say('checkedOk') : got.outcome === 'unavailable' ? say('checkedUnavailable') : say('checkedFailed'));
  };
  const custom = listing?.domains.filter((domain) => domain.kind === 'custom' && domain.claimed).length ?? 0;
  return (
    <div className="domains">
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!listing && !error && <p role="status">{say('loading')}</p>}
      {listing && !listing.domains.length && <p className="domains-dim">{say('none')}</p>}
      {listing && listing.domains.length > 0 && (
        <ul className="domains-list">
          {listing.domains.map((domain) => (
            <li key={domain.host} data-status={domain.status}>
              <div className="domains-head">
                <bdi className="domains-host">{domain.host}</bdi>
                <span className="domains-state">
                  {domain.status === 'pending'
                    ? say('pending')
                    : domain.status === 'verified'
                      ? say('verified')
                      : domain.status === 'live'
                        ? say('live')
                        : say('suspended')}
                  {domain.primary && ` · ${say('primary')}`}
                  {domain.kind === 'subdomain' && ` · ${say('subdomain')}`}
                  {!domain.claimed && domain.kind === 'custom' && ` · ${say('operator')}`}
                </span>
              </div>
              {domain.checkedAt !== null && <p className="domains-dim">{formatDateTime(domain.checkedAt)}</p>}
              {domain.status === 'pending' && domain.expiresAt !== undefined && (
                <p className="domains-dim">
                  {say('expires', { count: Math.max(1, Math.ceil((domain.expiresAt - Date.now()) / 86_400_000)) })}
                </p>
              )}
              {domain.records && domain.status !== 'live' && <Records records={domain.records} host={domain.host} />}
              {listing.editor && (domain.claimed || (domain.status === 'live' && !domain.primary)) && (
                <div className="domains-actions">
                  {domain.kind === 'custom' && domain.claimed && domain.status !== 'live' && (
                    <Button
                      size="compact"
                      busy={busy === `check:${domain.host}`}
                      busyLabel={say('checking')}
                      onClick={() => void check(domain.host)}
                    >
                      {say('check')}
                    </Button>
                  )}
                  {domain.status === 'live' && !domain.primary && (
                    <Button
                      size="compact"
                      busy={busy === `primary:${domain.host}`}
                      onClick={() => void ask('/api/domains/primary', domain.host, `primary:${domain.host}`)}
                    >
                      {say('makePrimary')}
                    </Button>
                  )}
                  {domain.kind === 'custom' && domain.claimed && confirming !== domain.host && (
                    <Button size="compact" intent="danger" onClick={() => setConfirming(domain.host)}>
                      {say('remove')}
                    </Button>
                  )}
                  {confirming === domain.host && (
                    <span className="domains-confirm" role="group" aria-label={say('confirmRemove', { host: domain.host })}>
                      <span>{say('confirmRemove', { host: domain.host })}</span>
                      <Button
                        size="compact"
                        intent="danger"
                        busy={busy === `remove:${domain.host}`}
                        busyLabel={say('removing')}
                        onClick={() =>
                          void ask('/api/domains/remove', domain.host, `remove:${domain.host}`).then(() => setConfirming(null))
                        }
                      >
                        {say('remove')}
                      </Button>
                      <Button size="compact" onClick={() => setConfirming(null)}>
                        {say('cancel')}
                      </Button>
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {listing?.editor &&
        (custom >= listing.limit ? (
          <p className="domains-dim">{say('full', { limit: listing.limit })}</p>
        ) : (
          <form className="domains-add" onSubmit={(event) => void add(event)}>
            <Field label={say('host')} hint={say('hostHint', { limit: listing.limit })} size="compact">
              <input
                data-slot="input"
                value={host}
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={253}
                placeholder={say('hostPlaceholder')}
                onChange={(event) => setHost(event.target.value)}
              />
            </Field>
            <Button intent="primary" size="compact" type="submit" busy={busy === 'add'} busyLabel={say('adding')} disabled={!host.trim()}>
              {say('addAction')}
            </Button>
          </form>
        ))}
    </div>
  );
}
