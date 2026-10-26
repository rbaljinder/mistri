/**
 * A member's API tokens in their tenant, over the routes the tenant's lease
 * already answers (/api/tokens, /issue, /revoke in tenantHttp.ts). The lease
 * names the membership a token binds; the server decides what is listed — a
 * member's own tokens, and for the tenant's administrator the others' that are
 * no wider than theirs — and refuses anything wider. A new token's secret is
 * shown once, when it is made, and never again.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@mistriwork/kit/client/core.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { roleName } from '../tenantNames.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import './TenantApiTokens.css';
import { say } from '../copy/tenancy/components/TenantApiTokens.js';

interface Token {
  id: string;
  label: string;
  roles: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  mine: boolean;
}
interface Listing {
  tokens: Token[];
  choices: { roles: string[]; maxDays: number };
}
type Reply = Record<string, unknown> & { error?: string };

const when = (value: string) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? formatDateTime(at) : value;
};
const stateOf = (token: Token) =>
  token.revokedAt ? say('revoked') : Date.parse(token.expiresAt) <= Date.now() ? say('expired') : say('active');

export function TenantApiTokens({ onClose }: { onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [label, setLabel] = useState('');
  const [roles, setRoles] = useState<string[] | null>(null);
  const [days, setDays] = useState('90');
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    try {
      const got = (await api('/api/tokens', {})) as Reply;
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
  const chosen = roles ?? listing?.choices.roles ?? [];
  const make = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !label.trim() || !chosen.length) return;
    setBusy('make');
    setSecret(null);
    try {
      const got = (await api('/api/tokens/issue', { label: label.trim(), roles: chosen, days: Number(days) })) as Reply;
      if (got.error) setError(got.error);
      else {
        setSecret(String(got.token));
        setCopied(false);
        setLabel('');
        await load();
      }
    } catch {
      setError(say('failed'));
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const got = (await api('/api/tokens/revoke', { id })) as Reply;
      if (got.error) setError(got.error);
      await load();
    } catch {
      setError(say('failed'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal className="api-tokens" aria-label={say('title')} fullscreen="mobile" onClose={onClose}>
      <header>
        <h2>{say('title')}</h2>
        <button type="button" className="ghost" aria-label={say('close')} onClick={onClose}>
          ×
        </button>
      </header>
      <p className="note">{say('note')}</p>
      {error && <p role="alert">{error}</p>}
      {!listing && !error && <p role="status">{say('loading')}</p>}
      {secret && (
        <div className="api-tokens-secret" role="status">
          <p>{say('madeOnce')}</p>
          <div>
            <input className="field-control" readOnly value={secret} aria-label={say('title')} onFocus={(event) => event.target.select()} />
            <Button
              size="compact"
              onClick={() => {
                void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
              }}
            >
              {copied ? say('copied') : say('copy')}
            </Button>
          </div>
        </div>
      )}
      {listing && !listing.tokens.length && <p role="status">{say('none')}</p>}
      {listing && listing.tokens.length > 0 && (
        <div className="api-tokens-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{say('label')}</th>
                <th scope="col">{say('roles')}</th>
                <th scope="col">{say('expires')}</th>
                <th scope="col">{say('state')}</th>
                <th scope="col">
                  <span className="visually-hidden">{say('revoke')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {listing.tokens.map((token) => (
                <tr key={token.id}>
                  <td>
                    <bdi>{token.label}</bdi>
                    {!token.mine && <span className="api-tokens-dim"> · {say('someoneElse')}</span>}
                  </td>
                  <td>{token.roles.map(roleName).join(', ')}</td>
                  <td className="api-tokens-dim">{when(token.expiresAt)}</td>
                  <td>{stateOf(token)}</td>
                  <td>
                    {!token.revokedAt && (
                      <Button
                        intent="danger"
                        size="compact"
                        busy={busy === token.id}
                        busyLabel={say('revoking')}
                        onClick={() => void revoke(token.id)}
                      >
                        {say('revoke')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {listing && (
        <form className="api-tokens-make" onSubmit={(event) => void make(event)}>
          <h3>{say('make')}</h3>
          {!listing.choices.roles.length ? (
            <p className="note">{say('noRoles')}</p>
          ) : (
            <>
              <Field label={say('label')} hint={say('labelHint')} size="compact" required>
                <input className="field-control" value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} />
              </Field>
              {listing.choices.roles.length > 1 && (
                <Field label={say('roles')} size="compact" group>
                  {(control) => (
                    <div className="api-tokens-roles" {...control} role="group">
                      {listing.choices.roles.map((role) => (
                        <label key={role}>
                          <input
                            type="checkbox"
                            checked={chosen.includes(role)}
                            onChange={(event) =>
                              setRoles(event.target.checked ? [...chosen, role] : chosen.filter((each) => each !== role))
                            }
                          />
                          {roleName(role)}
                        </label>
                      ))}
                    </div>
                  )}
                </Field>
              )}
              <Field label={say('days')} hint={say('daysHint', { most: listing.choices.maxDays })} size="compact">
                <input
                  className="field-control api-tokens-days"
                  type="number"
                  min={1}
                  max={listing.choices.maxDays}
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                />
              </Field>
              <div className="api-tokens-actions">
                <Button
                  intent="primary"
                  size="compact"
                  type="submit"
                  busy={busy === 'make'}
                  busyLabel={say('creating')}
                  disabled={!label.trim() || !chosen.length}
                >
                  {say('create')}
                </Button>
              </div>
            </>
          )}
        </form>
      )}
    </Modal>
  );
}
