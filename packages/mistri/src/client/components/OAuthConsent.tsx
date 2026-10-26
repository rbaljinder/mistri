/**
 * An application asks for a token: the person signed in to the App says
 * which of their roles it may act with, or declines (auth/oauthServer.ts).
 *
 * Everything shown is the server's, never the client's choosing: the
 * application's name (said as its own, unverified), where the answer goes,
 * and only the roles this person may give. The answer is a native form of
 * this origin, so the server's redirect to the application is the browser's
 * own navigation; it carries a nonce good once, for this session and this
 * request. The page cannot be framed (http/handler.ts).
 *
 * In a tenant App the person first picks which of their tenants the
 * application acts in, and the roles offered are that membership's.
 */
import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { served } from '@mistriwork/kit/client/addressMount.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { roleLabel } from '@mistriwork/kit/client/roleLabels.js';
import { say } from '../copy/public/components/OAuthConsent.js';

export interface ConsentView {
  request: string;
  nonce: string;
  client: { id: string; name: string | null };
  redirect: { scheme: string; host: string };
  app: { id: string; name: string; version: number };
  account: string;
  roles: string[];
  /** A tenant App's: the person's active memberships, each with the roles it may give. */
  tenants?: { id: string; name: string; roles: string[] }[];
  expiresAt: number;
  look?: Record<string, unknown>;
}

const isView = (value: unknown): value is ConsentView => {
  const v = value as ConsentView | null;
  return (
    !!v &&
    typeof v.request === 'string' &&
    typeof v.nonce === 'string' &&
    !!v.client &&
    typeof v.client.id === 'string' &&
    (v.client.name === null || typeof v.client.name === 'string') &&
    !!v.redirect &&
    typeof v.redirect.scheme === 'string' &&
    typeof v.redirect.host === 'string' &&
    !!v.app &&
    typeof v.app.name === 'string' &&
    typeof v.account === 'string' &&
    Array.isArray(v.roles) &&
    v.roles.every((role) => typeof role === 'string') &&
    (v.tenants === undefined ||
      (Array.isArray(v.tenants) &&
        v.tenants.every(
          (tenant) =>
            !!tenant &&
            typeof tenant.id === 'string' &&
            typeof tenant.name === 'string' &&
            Array.isArray(tenant.roles) &&
            tenant.roles.every((role) => typeof role === 'string'),
        )))
  );
};

/** What the request asks, read once: the view, or the sentence to show instead. */
export async function loadConsent(request: string): Promise<ConsentView | string> {
  try {
    const res = await fetchServer(`/api/auth/oauth/consent?request=${encodeURIComponent(request)}`, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 410) return say('expired');
    const body: unknown = res.ok ? await res.json() : undefined;
    return isView(body) ? body : say('failed');
  } catch {
    return say('failed');
  }
}

export function OAuthConsent({ view }: { view: ConsentView }) {
  const tenants = view.tenants;
  // One tenant is the obvious answer; with several, the person says where the application acts.
  const [tenantId, setTenantId] = useState(() => (tenants?.length === 1 ? tenants[0].id : ''));
  const tenant = tenants?.find((candidate) => candidate.id === tenantId);
  const offered = tenants ? (tenant?.roles ?? []) : view.roles;
  // One role is the obvious answer; with several, the person picks what this application needs.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(offered.length === 1 ? offered : []));
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState(false);
  const client = view.client.name ?? say('unnamed');
  const web = view.redirect.scheme === 'https' || view.redirect.scheme === 'http';
  useEffect(() => setProblem(''), [chosen]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (sent) {
      event.preventDefault();
      return;
    }
    // The browser takes it from here: the server answers with the way back to the application.
    setSent(true);
  };
  /* Allow with nothing chosen is said here, before anything is sent; the server refuses it as well. */
  const allow = (event: MouseEvent<HTMLButtonElement>) => {
    if (tenants && !tenant) {
      event.preventDefault();
      setProblem(say('chooseATenant'));
      return;
    }
    if (chosen.size) return;
    event.preventDefault();
    setProblem(say('chooseARole'));
  };
  // Another tenant's roles are another membership's: nothing chosen for one carries to the next.
  const pickTenant = (id: string) => {
    setTenantId(id);
    const roles = tenants?.find((candidate) => candidate.id === id)?.roles ?? [];
    setChosen(new Set(roles.length === 1 ? roles : []));
  };
  const allowable = tenants ? tenants.length > 0 && (!tenant || offered.length > 0) : offered.length > 0;

  return (
    <div className="signin oauth-consent">
      <div className="signin-card">
        <h1 className="signin-title">{say('title', { client, app: view.app.name })}</h1>
        <p className="signin-lede">{say('asks', { client, app: view.app.name, account: view.account })}</p>
        <form className="signin-form" method="post" action={served('/api/auth/oauth/consent')} onSubmit={submit}>
          <input type="hidden" name="request" value={view.request} />
          <input type="hidden" name="nonce" value={view.nonce} />
          {tenants &&
            (tenants.length ? (
              <fieldset className="oauth-consent-roles">
                <legend className="form-field-label">{say('tenant')}</legend>
                <p className="form-field-hint">{say('tenantHint')}</p>
                {tenants.map((candidate) => (
                  <Field key={candidate.id} check label={candidate.name}>
                    <input
                      type="radio"
                      name="tenant"
                      value={candidate.id}
                      checked={tenantId === candidate.id}
                      onChange={() => pickTenant(candidate.id)}
                    />
                  </Field>
                ))}
              </fieldset>
            ) : (
              <p className="signin-notice">{say('noTenants')}</p>
            ))}
          {tenants && !tenant ? null : offered.length ? (
            <fieldset className="oauth-consent-roles">
              <legend className="form-field-label">{say('roles')}</legend>
              <p className="form-field-hint">{say('rolesHint')}</p>
              {offered.map((role) => (
                <Field key={role} check label={roleLabel(role) ?? role}>
                  <input
                    type="checkbox"
                    name="role"
                    value={role}
                    checked={chosen.has(role)}
                    onChange={(event) => {
                      const next = new Set(chosen);
                      if (event.currentTarget.checked) next.add(role);
                      else next.delete(role);
                      setChosen(next);
                    }}
                  />
                </Field>
              ))}
            </fieldset>
          ) : (
            <p className="signin-notice">{say('noRoles')}</p>
          )}
          <p className="signin-lede">
            {web ? say('sendsBack', { host: view.redirect.host }) : say('sendsBackApp', { scheme: view.redirect.scheme })} {say('lasts')}
          </p>
          <p className="signin-problem" role="alert" hidden={!problem}>
            {problem}
          </p>
          <div className="oauth-consent-actions">
            <Button intent="secondary" size="large" type="submit" name="decision" value="deny" busy={sent}>
              {say('deny')}
            </Button>
            {allowable && (
              <Button intent="primary" size="large" type="submit" name="decision" value="allow" busy={sent} onClick={allow}>
                {say('allow')}
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
