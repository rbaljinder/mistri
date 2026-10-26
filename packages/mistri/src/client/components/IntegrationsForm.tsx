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
}
interface Integration {
  name: string;
  secrets: Secret[];
  webhook: string | null;
  channel: string | null;
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
  return (
    <form
      className="integrations-form-card"
      aria-label={integration.name}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>{integration.name}</h3>
      {integration.channel ? <p className="integrations-form-note">{say('channel', { channel: integration.channel })}</p> : null}
      {integration.webhook ? (
        <Field label={say('webhook')} hint={say('webhookHint')} size="compact">
          <input
            className="field-control integrations-form-address"
            readOnly
            value={integration.webhook}
            onFocus={(event) => event.target.select()}
          />
        </Field>
      ) : null}
      {integration.secrets.map((secret) => {
        const status = secret.set && secret.savedAt ? say('set', { date: new Date(secret.savedAt).toLocaleDateString() }) : say('notSet');
        return editor ? (
          <Field key={secret.name} label={secret.name} hint={secret.set ? `${status}. ${say('keep')}` : status} size="compact">
            <input
              className="field-control"
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
            <span>{secret.name}</span>
            <span>{status}</span>
          </p>
        );
      })}
      {editor ? (
        <footer className="form-actions">
          <p className="integrations-form-status" role="status">
            {message}
          </p>
          {integration.secrets.some((secret) => secret.set) ? (
            <Button
              size="compact"
              disabled={busy}
              onClick={() =>
                setDraft(Object.fromEntries(integration.secrets.filter((secret) => secret.set).map((secret) => [secret.name, null])))
              }
            >
              {say('remove')}
            </Button>
          ) : null}
          <Button intent="primary" size="compact" type="submit" busy={busy} busyLabel={say('saving')} disabled={!changed.length}>
            {say('save')}
          </Button>
        </footer>
      ) : null}
    </form>
  );
}

export function IntegrationsForm() {
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
  if (!reply.integrations.length) return <p className="integrations-form-note">{say('none')}</p>;
  return (
    <div className="integrations-form">
      {!reply.editor && <p className="integrations-form-note">{say('readOnly')}</p>}
      {reply.integrations.map((integration) => (
        <IntegrationCard key={integration.name} integration={integration} editor={reply.editor} saved={setReply} />
      ))}
    </div>
  );
}
