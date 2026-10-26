/**
 * The applications this person allowed to act as them (auth/oauthServer.ts),
 * in their profile, each with the roles it was given and when its grant ends,
 * and a way to end it now: every token it holds stops at its next request.
 * Shown only where the App's authorization server issues (the profile says).
 */
import { useEffect, useState } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { roleLabel } from '@mistriwork/kit/client/roleLabels.js';
import { say } from '../copy/account/components/ConnectedClients.js';

interface Grant {
  grantId: string;
  client: string | null;
  clientId: string;
  roles: string[];
  createdAt: number;
  expiresAt: number;
}

const grantsOf = (body: unknown): Grant[] | undefined => {
  const grants = (body as { grants?: unknown } | null)?.grants;
  if (!Array.isArray(grants)) return undefined;
  return grants.filter(
    (grant): grant is Grant =>
      !!grant &&
      typeof grant.grantId === 'string' &&
      (grant.client === null || typeof grant.client === 'string') &&
      Array.isArray(grant.roles) &&
      typeof grant.expiresAt === 'number',
  );
};

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function ConnectedClients() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchServer('/api/auth/oauth/grants', { credentials: 'same-origin', signal: AbortSignal.timeout(15_000) });
        const list = res.ok ? grantsOf(await res.json()) : undefined;
        if (!alive) return;
        if (list) setGrants(list);
        else setMessage({ text: say('couldNotLoad'), alert: true });
      } catch {
        if (alive) setMessage({ text: say('couldNotLoad'), alert: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const disconnect = async (grant: Grant) => {
    const client = grant.client ?? say('unnamed');
    setBusy(grant.grantId);
    setMessage(null);
    try {
      const res = await fetchServer('/api/auth/oauth/grants/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ grantId: grant.grantId }),
      });
      const list = res.ok ? grantsOf(await res.json()) : undefined;
      if (!list) throw new Error('refused');
      setGrants(list);
      setMessage({ text: say('disconnected', { client }), alert: false });
    } catch {
      setMessage({ text: say('couldNotDisconnect', { client }), alert: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="account-profile-clients" aria-labelledby="account-profile-clients">
      <h3 id="account-profile-clients">{say('connectedApplications')}</h3>
      <p className="note">{say('theyActAsYou')}</p>
      {grants && !grants.length && <p className="account-profile-clients-none">{say('none')}</p>}
      {grants && grants.length > 0 && (
        <ul>
          {grants.map((grant) => {
            const client = grant.client ?? say('unnamed');
            return (
              <li key={grant.grantId}>
                <div>
                  <span className="account-profile-client">{client}</span>
                  <span className="account-profile-client-roles">
                    {say('until', {
                      roles: grant.roles.map((role) => roleLabel(role) ?? role).join(', '),
                      date: day.format(new Date(grant.expiresAt)),
                    })}
                  </span>
                </div>
                <Button
                  intent="secondary"
                  size="compact"
                  busy={busy === grant.grantId}
                  busyLabel={say('disconnecting')}
                  disabled={busy !== null && busy !== grant.grantId}
                  aria-label={say('disconnectNamed', { client })}
                  onClick={() => void disconnect(grant)}
                >
                  {say('disconnect')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {message && <p role={message.alert ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  );
}
