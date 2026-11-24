/**
 * The integrations' settings screen: each integration the App's
 * jobs module lists, its secrets set or not — the server never sends a
 * value back, so nothing here can show one — the webhook address its
 * provider sends events to, and the channel it sends on. An editor (the
 * jobs module's `integrations.editors`) types a new value and saves it;
 * anyone else reads the same form, without the inputs. Loaded on demand
 * (Dashboard.tsx), so none of it stands in a first paint.
 */
import { useEffect, useState } from 'react';
import { api } from '@mistriwork/kit/client/core.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import './IntegrationsForm.css';
import { say } from '../copy/dashboards/components/IntegrationsForm.js';

interface Secret {
  name: string;
  set: boolean;
  savedAt: number | null;
  /** The fewest characters the server saves it with: a webhook's signing secret. */
  least?: number;
}
interface Integration {
  name: string;
  /** The package's own heading and sentence; absent, the name is made readable. */
  label?: string;
  description?: string;
  canCheck?: boolean;
  secrets: Secret[];
  webhook: string | null;
  channel: string | null;
}
/** Words a key spells in capitals: `apiKey` is "API key", not "Api key". */
const ACRONYMS = new Set(['api', 'id', 'url', 'uri', 'sms', 'sid', 'ssl', 'tls', 'jwt', 'ip', 'sdk', 'otp', 'oauth', 'dsn']);

/**
 * A name as a person reads it: `apiKey`, `api_key`, `STRIPE_SECRET_KEY` and `twilio-sms` are "API key", "Stripe secret
 * key" and "Twilio SMS". The seam has the integration declare only a name and its secrets' names (defineIntegration), so
 * this is all the screen has to go on; a declared label would stand before it.
 */
export function readableName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const said = words.map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word)).join(' ');
  return said.charAt(0).toUpperCase() + said.slice(1);
}

interface Reply {
  integrations: Integration[];
  editor: boolean;
  error?: string;
}

function IntegrationCard({ integration, editor, saved }: { integration: Integration; editor: boolean; saved: (reply: Reply) => void }) {
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; message: string } | undefined>();
  const heading = integration.label ?? readableName(integration.name);
  const changed = Object.keys(draft).filter((name) => draft[name] === null || !!draft[name]?.trim());
  const save = async () => {
    if (busy || !changed.length) return;
    setBusy(true);
    setMessage('');
    try {
      const got = (await api('/api/integrations/save', {
        integration: integration.name,
        secrets: Object.fromEntries(changed.map((name) => [name, draft[name]])),
      })) as Reply;
      if (got.error) setMessage(got.error);
      else {
        setDraft({});
        setMessage(say('saved'));
        saved(got);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : say('couldNotSave'));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    if (testing) return;
    setTesting(true);
    setTested(undefined);
    try {
      const got = (await api('/api/integrations/check', { integration: integration.name })) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (got.error) setTested({ ok: false, message: got.error });
      else setTested(got.ok ? { ok: true, message: say('connected') } : { ok: false, message: got.message || say('couldNotTest') });
    } catch {
      setTested({ ok: false, message: say('couldNotTest') });
    } finally {
      setTesting(false);
    }
  };
  /* Where the connection stands, from what the screen knows: which secrets are saved. Whether the provider accepts them
     is not asked here (the seam has no check to call), and a failed call is journaled, not kept per integration. */
  const held = integration.secrets.filter((secret) => secret.set).length;
  const connection =
    held === integration.secrets.length
      ? { state: 'configured', words: say('configured') }
      : held === 0
        ? { state: 'missing', words: say('notConfigured') }
        : { state: 'partial', words: say('partlyConfigured', { set: String(held), count: String(integration.secrets.length) }) };
  return (
    <form
      className="integrations-form-card"
      aria-label={heading}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>{heading}</h3>
      {integration.description ? <p className="integrations-form-note">{integration.description}</p> : null}
      {integration.secrets.length ? (
        <p className="integrations-form-state" data-state={connection.state}>
          {connection.words}
        </p>
      ) : null}
      {integration.channel ? <p className="integrations-form-note">{say('channel', { channel: integration.channel })}</p> : null}
      {integration.webhook ? (
        <Field label={say('webhook')} hint={say('webhookHint')} size="sm">
          <input
            data-slot="input"
            className="integrations-form-address"
            readOnly
            value={integration.webhook}
            onFocus={(event) => event.target.select()}
          />
        </Field>
      ) : null}
      {integration.secrets.map((secret) => {
        const status = secret.set && secret.savedAt ? say('set', { date: new Date(secret.savedAt).toLocaleDateString() }) : say('notSet');
        const said = secret.set ? `${status}. ${say('keep')}` : status;
        return editor ? (
          <Field
            key={secret.name}
            label={readableName(secret.name)}
            hint={secret.least ? `${said}${secret.set ? '' : '.'} ${say('least', { count: String(secret.least) })}` : said}
            size="sm"
          >
            <input
              data-slot="input"
              type="password"
              name={secret.name}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              disabled={busy || draft[secret.name] === null}
              placeholder={draft[secret.name] === null ? say('remove') : say('newValue')}
              value={draft[secret.name] ?? ''}
              onChange={(event) => setDraft((current) => ({ ...current, [secret.name]: event.target.value }))}
            />
          </Field>
        ) : (
          <p key={secret.name} className="integrations-form-secret">
            <span>{readableName(secret.name)}</span>
            <span>{status}</span>
          </p>
        );
      })}
      {editor ? (
        <footer className="form-actions">
          <p className="integrations-form-status" role="status" data-ok={tested && !message ? String(tested.ok) : undefined}>
            {message || tested?.message}
          </p>
          {integration.canCheck ? (
            <Button size="sm" disabled={busy} loading={testing} loadingLabel={say('testing')} onClick={() => void test()}>
              {say('testConnection')}
            </Button>
          ) : null}
          {integration.secrets.some((secret) => secret.set) ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                setDraft(Object.fromEntries(integration.secrets.filter((secret) => secret.set).map((secret) => [secret.name, null])))
              }
            >
              {say('remove')}
            </Button>
          ) : null}
          <Button variant="primary" size="sm" type="submit" loading={busy} loadingLabel={say('saving')} disabled={!changed.length}>
            {say('save')}
          </Button>
        </footer>
      ) : null}
    </form>
  );
}

/** `only`: the integrations this page shows, by name, in that order (the section's `integrations`); every one without it. */
export function IntegrationsForm({ only }: { only?: readonly string[] } = {}) {
  const [reply, setReply] = useState<Reply | undefined>();
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const got = (await api('/api/integrations', {})) as Reply;
        if (!alive) return;
        if (got.error) setFailed(got.error);
        else setReply(got);
      } catch (error) {
        if (alive) setFailed(error instanceof Error ? error.message : say('couldNotLoad'));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  if (failed)
    return (
      <p className="integrations-form-note" role="alert">
        {failed}
      </p>
    );
  if (!reply)
    return (
      <p className="integrations-form-note" role="status">
        {say('loading')}
      </p>
    );
  /* A page per integration shows its own keys alone; a save still answers every integration, so the narrowing is here. */
  const shown = only
    ? only.flatMap((name) => reply.integrations.find((integration) => integration.name === name) ?? [])
    : reply.integrations;
  if (!shown.length) return <p className="integrations-form-note">{say('none')}</p>;
  return (
    <div className="integrations-form">
      {!reply.editor && <p className="integrations-form-note">{say('readOnly')}</p>}
      {shown.map((integration) => (
        <IntegrationCard key={integration.name} integration={integration} editor={reply.editor} saved={setReply} />
      ))}
    </div>
  );
}
