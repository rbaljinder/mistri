/**
 * Add or edit a connection: a URL to paste, or the parts to fill in — two
 * views of one value, shown at once, kept the same thing by `connurl.js`.
 * Opened straight away, so a bad target fails here rather than later. The
 * long argument for each choice on this form is in the vanilla history of
 * `connmanager.js`; what survives here is the behaviour.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { api } from '@mistriwork/kit/client/core.js';
import {
  DEFAULT_PORTS,
  DRIVERS,
  buildConnectionUrl,
  isEnvReference,
  looksSchemeless,
  parseConnectionUrl,
  redactConnectionUrl,
} from '../connurl.js';
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import { ConfirmDialog } from '@mistriwork/kit/client/components/Prompt.js';
import { say } from '../copy/workbench/components/ConnectionDialog.js';
import { addHostListener, removeHostListener } from '@mistriwork/kit/client/shellHost.js';

export interface Parts {
  driver: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  file: string;
}
export interface Submission {
  url: string;
  name: string;
  schemas: string[];
}
export interface ConnectionDialogProps {
  title: string;
  name?: string;
  url?: string;
  schemas?: string[];
  verb: string;
  /** Returns `{ error }` to keep the dialog open with the message, or null to close it. */
  run: (submission: Submission) => Promise<{ error: string } | null | undefined>;
  onClose: () => void;
}
interface Result {
  ok: boolean;
  text: string;
  detail?: string;
}

const parse = (url: string) => parseConnectionUrl(url) as Parts;
const build = (parts: Parts) => buildConnectionUrl(parts) as string;
const envName = (value: string) =>
  String(value ?? '')
    .replace(/^\$\{?/, '')
    .replace(/\}$/, '');

/** The database's own name is what people call it out loud, so that is the suggestion. */
function suggestedName(parts: Parts): string {
  return (
    parts.driver === 'sqlite'
      ? (String(parts.file ?? '')
          .split('/')
          .pop() ?? '')
      : parts.database || parts.host || ''
  ).trim();
}

export function ConnectionDialog({
  title,
  name: nameValue,
  url: urlValue,
  schemas: schemasValue,
  verb,
  run,
  onClose,
}: ConnectionDialogProps) {
  const dialog = useRef<ModalHandle>(null);
  const urlBox = useRef<HTMLInputElement>(null);
  const resultBox = useRef<HTMLDivElement>(null);
  const [parts, setParts] = useState<Parts>(() => parse(urlValue ?? ''));
  /* The box shows the shareable half — everything except a typed password —
     and `parts` stays the single source of truth. A half-typed URL must not
     be read as a value, so the box has text of its own while it is being typed. */
  const [urlText, setUrlText] = useState(() => shownUrl(parse(urlValue ?? '')));
  const [name, setName] = useState(nameValue ?? '');
  const [schemas, setSchemas] = useState((schemasValue ?? []).join(', '));
  const [secretMode, setSecretMode] = useState<'typed' | 'env'>(() =>
    /^\$\{?[A-Za-z_]/.test(parse(urlValue ?? '').password ?? '') ? 'env' : 'typed',
  );
  const [result, setResult] = useState<Result | null>(null);
  const [testing, setTesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [discard, setDiscard] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const approvedClose = useRef(false);
  const testGeneration = useRef(0);
  const fingerprint = JSON.stringify([parts, urlText, name, schemas]);
  const initial = useRef(fingerprint);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      testGeneration.current++;
    };
  }, []);
  useEffect(() => {
    testGeneration.current++;
    setTesting(false);
    setResult(null);
  }, [fingerprint]);
  useEffect(() => {
    if (completed) {
      approvedClose.current = true;
      dialog.current?.close();
    }
  }, [completed]);
  useEffect(() => {
    if (!submitting && fingerprint === initial.current) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    addHostListener(window, 'beforeunload', warn);
    return () => removeHostListener(window, 'beforeunload', warn);
  }, [submitting, fingerprint]);
  const beforeClose = () => {
    if (busy.current) return false;
    if (!approvedClose.current && fingerprint !== initial.current) {
      setDiscard(true);
      return false;
    }
    return true;
  };

  useEffect(() => {
    if (result) resultBox.current?.scrollIntoView?.({ block: 'nearest' });
  }, [result]);

  /* An environment reference is not a secret — it names a variable and reveals nothing. A typed one is. */
  function secretIsHidden(p: Parts) {
    return Boolean(p.password) && !isEnvReference(p.password);
  }
  function shownUrl(p: Parts) {
    return build(secretIsHidden(p) ? { ...p, password: '' } : p);
  }
  const targetUrl = () => build(parts);
  const chosenName = () => name.trim() || suggestedName(parts);
  const schemaList = () =>
    schemas
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  /** A part changed: the box follows. */
  const updateParts = (next: Parts) => {
    setParts(next);
    setUrlText(shownUrl(next));
  };
  /** The box changed: the parts follow, once there is a value to read. */
  const onUrlInput = (text: string) => {
    setUrlText(text);
    const trimmed = text.trim();
    const parsed = parse(trimmed);
    const started = /^[a-z][\w+.-]*:\/?$/i.test(trimmed);
    if (trimmed && (started || (!parsed.host && !parsed.file))) return;
    /* A URL with no password does not clear one that was typed into the field. */
    const password = !parsed.password && secretIsHidden(parts) ? parts.password : parsed.password;
    const next = { ...parsed, password };
    setParts(next);
    setSecretMode(isEnvReference(next.password) ? 'env' : 'typed');
  };
  const repair = (scheme: string) => {
    onUrlInput(`${scheme}://${urlText.trim()}`);
    urlBox.current?.focus();
  };

  const test = async () => {
    if (busy.current || testing) return;
    const generation = ++testGeneration.current;
    const current = () => alive.current && generation === testGeneration.current;
    const target = targetUrl().trim();
    /* Nothing to test, and saying so rather than doing nothing — Edit opens blank on purpose, the stored string never leaves the server. */
    if (!target) {
      setResult({ ok: false, text: say('nothingToTestYet') });
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      const answer = await api('/api/connections/test', { url: target, name: chosenName(), schemas: schemaList() });
      if (!current()) return;
      const where = answer.secret && answer.secret !== 'none' ? say('passwordFromSecret', { secret: answer.secret }) : '';
      setResult({
        ok: answer.ok,
        text: answer.ok ? say('connectedTables', { dialect: answer.dialect, count: answer.tables, where }) : answer.error,
        detail: answer.ok ? answer.warning : undefined,
      });
    } catch (err) {
      if (current()) setResult({ ok: false, text: (err as Error).message });
    } finally {
      if (current()) setTesting(false);
    }
  };
  const submit = async () => {
    if (busy.current || !alive.current) return;
    busy.current = true;
    testGeneration.current++;
    setTesting(false);
    setSubmitting(true);
    setResult(null);
    try {
      const outcome = await run({ url: targetUrl().trim(), name: chosenName(), schemas: schemaList() });
      if (!alive.current) return;
      if (outcome?.error) setResult({ ok: false, text: outcome.error });
      else setCompleted(true);
    } catch (error) {
      if (alive.current) setResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      busy.current = false;
      if (alive.current) setSubmitting(false);
    }
  };

  const part = (label: string, key: keyof Parts, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field-stack">
      <span>{label}</span>
      <input
        type="text"
        className="cell-edit"
        spellCheck={false}
        aria-label={label}
        value={parts[key] ?? ''}
        onChange={(e) => updateParts({ ...parts, [key]: e.currentTarget.value })}
        {...extra}
      />
    </label>
  );
  const secretTab = (label: string, which: 'typed' | 'env', hint: string) => (
    <button
      type="button"
      className={`conn-tab${secretMode === which ? ' active' : ''}`}
      aria-pressed={secretMode === which}
      title={hint}
      onClick={() => {
        setSecretMode(which);
        updateParts({ ...parts, password: '' });
      }}
    >
      {label}
    </button>
  );
  const schemeless = looksSchemeless(urlText);
  return (
    <Modal
      className="confirm conn-dialog"
      ref={dialog}
      onClose={onClose}
      initialFocus={urlBox}
      closeDisabled={submitting}
      beforeClose={beforeClose}
    >
      <h2>{title}</h2>
      <p>{say('openedStraightAwaySoABad')}</p>
      <fieldset className="conn-form-fields" disabled={submitting} aria-busy={submitting}>
        <div>
          <label className="field-stack">
            <span>{say('pasteAUrl')}</span>
            <input
              ref={urlBox}
              type="text"
              className="cell-edit"
              value={urlText}
              onChange={(e) => onUrlInput(e.currentTarget.value)}
              placeholder={say('postgresUserHostDb')}
              aria-label={say('connectionUrlOrFile')}
              spellCheck={false}
            />
            {/* `user@host/db` with no `://` is being read as a file path; which driver it wants is asked rather than guessed. */}
            <p className="conn-scheme-hint" hidden={!schemeless}>
              {schemeless ? (
                <>
                  <span>{say('noSchemeSoThisIsBeing')}</span>
                  <button type="button" className="conn-scheme-fix" onClick={() => repair('postgres')}>
                    postgres://
                  </button>
                  <button type="button" className="conn-scheme-fix" onClick={() => repair('mysql')}>
                    mysql://
                  </button>
                </>
              ) : null}
            </p>
          </label>
          <div className="conn-or" role="separator">
            <span>{say('orFillInTheParts')}</span>
          </div>
          <label className="field-stack">
            <span>{say('driver')}</span>
            <Dropdown
              ariaLabel={say('driver')}
              value={parts.driver}
              items={(DRIVERS as string[]).map((d) => ({ value: d, label: d }))}
              onChange={(driver) => updateParts({ ...parts, driver })}
            />
          </label>
          {parts.driver === 'sqlite' ? (
            <div className="conn-parts">{part(say('file'), 'file', { placeholder: '/path/to/database.sqlite' })}</div>
          ) : (
            <div className="conn-parts">
              {part(say('host'), 'host', { placeholder: '127.0.0.1' })}
              {part(say('port'), 'port', {
                placeholder: String((DEFAULT_PORTS as Record<string, number>)[parts.driver] ?? ''),
                inputMode: 'numeric',
              })}
              {part(say('database'), 'database', { placeholder: 'appdb' })}
              {part(say('user'), 'user', { placeholder: 'postgres' })}
              <div className="field-stack conn-secret">
                <div className="conn-secret-head">
                  <span>{say('common.password')}</span>
                  <div className="conn-tabs conn-tabs-small">
                    {secretTab(say('type'), 'typed', say('movedToTheKeychain'))}
                    {secretTab(say('fromTheEnvironment'), 'env', say('storedNowhereReadFromTheEnvironment'))}
                  </div>
                </div>
                {secretMode === 'env' ? (
                  <input
                    type="text"
                    className="cell-edit"
                    spellCheck={false}
                    aria-label={say('environmentVariable')}
                    placeholder="PROD_PASSWORD"
                    value={envName(parts.password)}
                    onChange={(e) =>
                      updateParts({ ...parts, password: e.currentTarget.value.trim() ? `\${${e.currentTarget.value.trim()}}` : '' })
                    }
                  />
                ) : (
                  <input
                    type="password"
                    className="cell-edit"
                    spellCheck={false}
                    aria-label={say('common.password')}
                    placeholder={say('keptOutOfTheConfig')}
                    value={isEnvReference(parts.password) ? '' : (parts.password ?? '')}
                    onChange={(e) => updateParts({ ...parts, password: e.currentTarget.value })}
                  />
                )}
                <p className="conn-secret-note">
                  {secretMode === 'env' ? say('theUrlWillHold', { reference: '${NAME}' }) : say('keptInThisSession')}
                </p>
              </div>
            </div>
          )}
          {/* Only worth a line when it says something the box above does not. */}
          <p className="conn-preview-row" hidden={!secretIsHidden(parts)}>
            <span>{say('opens')}</span>
            <code className="conn-preview">{(redactConnectionUrl(targetUrl()) as string) || '—'}</code>
          </p>
        </div>
        <label className="field-stack">
          <span>{say('common.name')}</span>
          <input
            type="text"
            className="cell-edit"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder={suggestedName(parts) || say('optionalName')}
            aria-label={say('connectionName')}
          />
          <span className="field-hint">{say('whatItIsCalled')}</span>
        </label>
        <label className="field-stack">
          <span>{say('schemas')}</span>
          <input
            type="text"
            className="cell-edit"
            spellCheck={false}
            value={schemas}
            onChange={(e) => setSchemas(e.currentTarget.value)}
            placeholder={say('publicPostgresOnlyComma')}
            aria-label={say('postgresSchemasToBrowse')}
          />
        </label>
        <p className="conn-fineprint">{say('thisConnectionLastsUntil')}</p>
      </fieldset>
      <div
        ref={resultBox}
        className={`conn-result${result ? ` ${result.ok ? 'ok' : 'bad'}` : ''}`}
        hidden={!result}
        role="status"
        aria-live="polite"
      >
        {result ? (
          <>
            <span className="conn-result-mark" aria-hidden="true">
              {result.ok ? '✓' : '✕'}
            </span>
            <div>
              <p className="conn-result-text">{result.text}</p>
              {result.detail ? <p className="conn-result-detail">{result.detail}</p> : null}
            </div>
          </>
        ) : null}
      </div>
      <div className="confirm-actions">
        <Button disabled={submitting} onClick={() => dialog.current?.close()}>
          {say('common.cancel')}
        </Button>
        <Button disabled={testing || submitting} onClick={() => void test()}>
          {testing ? say('testing') : say('test')}
        </Button>
        <Button intent="primary" disabled={submitting} onClick={() => void submit()}>
          {submitting ? 'Saving...' : verb}
        </Button>
      </div>
      {discard && (
        <ConfirmDialog
          title={say('discardConnectionChanges')}
          body={say('changesInThisForm')}
          confirmLabel={say('discardChanges')}
          cancelLabel={say('keepEditing')}
          onDone={(confirmed) => {
            setDiscard(false);
            if (confirmed && !busy.current) {
              approvedClose.current = true;
              dialog.current?.close();
            }
          }}
        />
      )}
    </Modal>
  );
}
