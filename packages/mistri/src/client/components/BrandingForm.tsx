/**
 * A tenant's own Branding form: what the App's `branding.allow` lets its admins
 * change, beside a live preview of what their people will see — the bar, a
 * record's head, a figure and an email's header. The preview and the refusals
 * are the save's own (shared/tenantBranding.ts): what this form says before
 * Save is what the server would say after it. Members who are not the App's
 * `branding.editors` see the same form, read-only.
 *
 * Every color reaches the page through a custom property set from a value
 * that already matched `#rrggbb`; a logo is drawn from its own object URL
 * while unsaved, and from the App's logo address once saved.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import type { ThemeDefinition, ThemeDensity } from '@mistriwork/engine/schema/theme.js';
import {
  accentFor,
  brandingProblems,
  tenantTheme,
  type BrandingKey,
  type BrandingRefusal,
  type TenantBrandingValue,
} from '../../shared/tenantBranding.js';
import { api } from '@mistriwork/kit/client/core.js';
import { served } from '@mistriwork/kit/client/addressMount.js';
import { activeApp } from '../appState.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import { Field } from '@mistriwork/ui/Field.js';
import './BrandingForm.css';
import { say } from '../copy/dashboards/components/BrandingForm.js';
import { shellRoot } from '@mistriwork/kit/client/shellHost.js';

interface BrandingReply {
  branding: TenantBrandingValue;
  revision: number;
  editor: boolean;
  allow: BrandingKey[];
  themes: ThemeDefinition[];
  error?: string;
  errors?: BrandingRefusal[];
}

const HEX = /^#[0-9a-f]{6}$/;
const RADII = ['0px', '2px', '4px', '6px', '8px'];
const LOGO_ADDRESS = /^\/api\/branding\/logo\/[0-9a-f]{64}$/;

/** The draft as the save takes it: a key the form leaves empty is the App's. */
type Draft = { -readonly [K in keyof TenantBrandingValue]?: TenantBrandingValue[K] };

function dark(): boolean {
  const root = shellRoot().dataset.theme;
  return root === 'dark' || (!root && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
}

export function BrandingForm() {
  const [reply, setReply] = useState<BrandingReply | null>(null);
  const [failed, setFailed] = useState('');
  const [draft, setDraft] = useState<Draft>({});
  /* An upload not yet saved: its bytes for the save, its object URL for the preview; null removes the saved logo. */
  const [upload, setUpload] = useState<{ base64: string; url: string } | null | undefined>(undefined);
  /* The same for the dark logo, which belongs to a logo: removing the logo takes it too. */
  const [darkUpload, setDarkUpload] = useState<{ base64: string; url: string } | null | undefined>(undefined);
  const [phase, setPhase] = useState<'idle' | 'saving'>('idle');
  const [message, setMessage] = useState('');
  const [refused, setRefused] = useState<BrandingRefusal[]>([]);
  const file = useRef<HTMLInputElement>(null);
  const darkFile = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const got = (await api('/api/branding', {})) as BrandingReply;
        if (!alive) return;
        if (got.error) setFailed(got.error);
        else {
          setReply(got);
          setDraft({ ...got.branding });
        }
      } catch (error) {
        if (alive) setFailed(error instanceof Error ? error.message : say('couldNotLoad'));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => () => (upload ? URL.revokeObjectURL(upload.url) : undefined), [upload]);
  useEffect(() => () => (darkUpload ? URL.revokeObjectURL(darkUpload.url) : undefined), [darkUpload]);

  const declaration = useMemo(() => (reply ? { themes: reply.themes, allow: reply.allow, editors: [] } : undefined), [reply]);
  /* What the save would judge: the draft without the color a reader is still typing. */
  const candidate = useMemo<TenantBrandingValue>(() => {
    const { accent, ...rest } = draft;
    return accent && HEX.test(accent.light) && HEX.test(accent.dark) ? { ...rest, accent } : rest;
  }, [draft]);
  const theme = useMemo(() => (declaration ? tenantTheme(declaration, candidate) : undefined), [declaration, candidate]);
  const problems = useMemo(() => (declaration ? brandingProblems(declaration, candidate) : []), [declaration, candidate]);

  if (failed)
    return (
      <p className="branding-form-note" role="alert">
        {failed}
      </p>
    );
  if (!reply || !declaration || !theme)
    return (
      <p className="branding-form-note" role="status">
        {say('loading')}
      </p>
    );

  const allowed = (key: BrandingKey) => reply.allow.includes(key);
  const editor = reply.editor;
  const app = activeApp();
  const name = draft.name?.trim() || app?.name || '';
  const savedLogo = reply.branding.logo ? `/api/branding/logo/${reply.branding.logo.hash}` : undefined;
  const logo = upload === null ? undefined : (upload?.url ?? (savedLogo && LOGO_ADDRESS.test(savedLogo) ? served(savedLogo) : undefined));
  const savedDark = reply.branding.logoDark ? `/api/branding/logo/${reply.branding.logoDark.hash}` : undefined;
  const darkLogo =
    !logo || darkUpload === null
      ? undefined
      : (darkUpload?.url ?? (savedDark && LOGO_ADDRESS.test(savedDark) ? served(savedDark) : undefined));
  const chosen = reply.themes.find((item) => item.id === draft.preset) ?? reply.themes[0]!;
  const palette = theme[dark() ? 'dark' : 'light'];
  const problemFor = (field: BrandingKey) =>
    [...refused.filter((item) => item.field === field), ...(field === 'accent' ? problems : [])].map((item) => item.message)[0] ?? '';
  const set = (patch: Draft) => {
    setDraft((current) => ({ ...current, ...patch }));
    setMessage('');
    setRefused([]);
  };
  const accentText = draft.accent?.light ?? '';
  /* One accent for both grounds, the dark one derived as the save derives it, in the theme the draft wears. */
  const pairFor = (light: string) => accentFor(declaration!, candidate, light);
  const preview = {
    '--bp-ground': palette.ground,
    '--bp-surface': palette.surface,
    '--bp-ink': palette.ink,
    '--bp-muted': palette.inkMuted,
    '--bp-line': palette.line,
    '--bp-accent': palette.accent,
    '--bp-accent-soft': palette.accentSoft,
    '--bp-nav': palette.navGround ?? palette.surface,
    '--bp-nav-ink': palette.navInk ?? palette.ink,
    '--bp-nav-accent': palette.navAccent ?? palette.accent,
    '--bp-chart': palette.chart1 ?? palette.accent,
    '--bp-radius': draft.radius ?? theme.radius?.control ?? '4px',
  } as CSSProperties;

  const pick = async (event: ChangeEvent<HTMLInputElement>, into: typeof setUpload) => {
    const chosenFile = event.target.files?.[0];
    event.target.value = '';
    if (!chosenFile) return;
    const bytes = new Uint8Array(await chosenFile.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    into({ base64: btoa(binary), url: URL.createObjectURL(chosenFile) });
    setMessage('');
    setRefused([]);
  };
  const save = async () => {
    if (phase === 'saving' || !editor || problems.length) return;
    setPhase('saving');
    setMessage('');
    try {
      const { logo: _logo, logoDark: _logoDark, ...value } = draft;
      const got = (await api('/api/branding/save', {
        branding:
          value.accent && !(HEX.test(value.accent.light) && HEX.test(value.accent.dark)) ? { ...value, accent: value.accent.light } : value,
        ...(upload === undefined ? {} : { logo: upload === null ? null : upload.base64 }),
        ...(darkUpload === undefined ? {} : { darkLogo: darkUpload === null ? null : darkUpload.base64 }),
      })) as BrandingReply;
      if (got.error) {
        setRefused(got.errors ?? [{ field: 'name', message: got.error }]);
        setMessage(got.error);
      } else {
        setReply(got);
        setDraft({ ...got.branding });
        setUpload(undefined);
        setDarkUpload(undefined);
        setMessage(say('saved'));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : say('couldNotSave'));
    } finally {
      setPhase('idle');
    }
  };
  const disabled = !editor || phase === 'saving';

  return (
    <div className="branding-form">
      <form
        className="branding-form-fields"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        noValidate
      >
        {!editor && <p className="branding-form-note">{say('readOnly')}</p>}
        {allowed('name') && (
          <Field label={say('name')} hint={say('nameHint')} problem={problemFor('name')} size="compact">
            <input
              className="field-control"
              name="name"
              value={draft.name ?? ''}
              placeholder={app?.name}
              maxLength={80}
              disabled={disabled}
              onChange={(event) => set({ name: event.target.value || undefined })}
            />
          </Field>
        )}
        {allowed('logo') && (
          <Field label={say('logo')} hint={say('logoHint')} problem={problemFor('logo')} size="compact" group>
            {(control) => (
              <div className="branding-form-logo" {...control} role="group">
                <span className="branding-form-logo-box">{logo ? <img src={logo} alt="" width={96} height={24} /> : say('noLogo')}</span>
                <input
                  ref={file}
                  type="file"
                  hidden
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  onChange={(event) => void pick(event, setUpload)}
                />
                <Button intent="secondary" size="compact" disabled={disabled} onClick={() => file.current?.click()}>
                  {say('chooseLogo')}
                </Button>
                {logo && (
                  <Button
                    intent="quiet"
                    size="compact"
                    disabled={disabled}
                    onClick={() => setUpload(reply.branding.logo ? null : undefined)}
                  >
                    {say('removeLogo')}
                  </Button>
                )}
              </div>
            )}
          </Field>
        )}
        {allowed('logo') && logo && (
          <Field label={say('darkLogo')} hint={say('darkLogoHint')} size="compact" group>
            {(control) => (
              <div className="branding-form-logo" {...control} role="group">
                <span className="branding-form-logo-box branding-form-logo-box--dark">
                  {darkLogo ? <img src={darkLogo} alt="" width={96} height={24} /> : say('noDarkLogo')}
                </span>
                <input
                  ref={darkFile}
                  type="file"
                  hidden
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  onChange={(event) => void pick(event, setDarkUpload)}
                />
                <Button intent="secondary" size="compact" disabled={disabled} onClick={() => darkFile.current?.click()}>
                  {say('chooseLogo')}
                </Button>
                {darkLogo && (
                  <Button
                    intent="quiet"
                    size="compact"
                    disabled={disabled}
                    onClick={() => setDarkUpload(reply.branding.logoDark ? null : undefined)}
                  >
                    {say('removeLogo')}
                  </Button>
                )}
              </div>
            )}
          </Field>
        )}
        {allowed('accent') && (
          <Field label={say('accent')} hint={say('accentHint')} problem={problemFor('accent')} size="compact" group>
            {(control) => (
              <div className="branding-form-accent" {...control} role="group">
                <input
                  type="color"
                  aria-label={say('accentColor')}
                  value={HEX.test(accentText) ? accentText : palette.accent}
                  disabled={disabled}
                  onChange={(event) => set({ accent: pairFor(event.target.value) })}
                />
                <input
                  className="field-control"
                  aria-label={say('accentColor')}
                  value={accentText}
                  placeholder={chosen.light.accent}
                  spellCheck={false}
                  maxLength={7}
                  disabled={disabled}
                  onChange={(event) => {
                    const typed = event.target.value.trim().toLowerCase();
                    set({ accent: typed ? (HEX.test(typed) ? pairFor(typed) : { light: typed, dark: typed }) : undefined });
                  }}
                />
              </div>
            )}
          </Field>
        )}
        {allowed('preset') && (
          <Field label={say('theme')} problem={problemFor('preset')} size="compact" group>
            <Dropdown
              ariaLabel={say('theme')}
              disabled={disabled}
              value={draft.preset ?? reply.themes[0]!.id}
              items={reply.themes.map((item) => ({ value: item.id, label: item.label }))}
              onChange={(next) => set({ preset: next, palette: undefined })}
            />
          </Field>
        )}
        {allowed('palette') && chosen.palettes?.length ? (
          <Field label={say('palette')} problem={problemFor('palette')} size="compact" group>
            <Dropdown
              ariaLabel={say('palette')}
              disabled={disabled}
              value={draft.palette ?? chosen.defaultPalette ?? 'default'}
              items={[{ value: 'default', label: chosen.label }, ...chosen.palettes.map((item) => ({ value: item.id, label: item.label }))]}
              onChange={(next) => set({ palette: next })}
            />
          </Field>
        ) : null}
        {allowed('radius') && (
          <Field label={say('corner')} problem={problemFor('radius')} size="compact" group>
            <Dropdown
              ariaLabel={say('corner')}
              disabled={disabled}
              value={draft.radius ?? ''}
              items={[
                { value: '', label: say('appDefault') },
                ...RADII.map((radius) => ({ value: radius, label: radius === '0px' ? say('square') : radius })),
              ]}
              onChange={(next) => set({ radius: next || undefined })}
            />
          </Field>
        )}
        {allowed('density') && (
          <Field label={say('density')} problem={problemFor('density')} size="compact" group>
            <Dropdown
              ariaLabel={say('density')}
              disabled={disabled}
              value={draft.density ?? ''}
              items={[
                { value: '', label: say('appDefault') },
                { value: 'compact', label: say('compact') },
                { value: 'comfortable', label: say('comfortable') },
                { value: 'spacious', label: say('spacious') },
              ]}
              onChange={(next) => set({ density: (next || undefined) as ThemeDensity | undefined })}
            />
          </Field>
        )}
        {editor && (
          <footer className="form-actions">
            <p className="branding-form-status" role="status">
              {message}
            </p>
            <Button
              intent="secondary"
              size="compact"
              disabled={phase === 'saving'}
              onClick={() => {
                setDraft({ ...reply.branding });
                setUpload(undefined);
                setMessage('');
                setRefused([]);
              }}
            >
              {say('reset')}
            </Button>
            <Button intent="primary" size="compact" type="submit" disabled={phase === 'saving' || problems.length > 0}>
              {phase === 'saving' ? say('saving') : say('save')}
            </Button>
          </footer>
        )}
      </form>
      <section className="branding-preview" aria-label={say('preview')} style={preview}>
        <figure>
          <figcaption>{say('previewShell')}</figcaption>
          <div className="branding-preview-shell">
            <span className="branding-preview-mark">
              {logo ? <img src={dark() && darkLogo ? darkLogo : logo} alt="" width={96} height={24} /> : null}
            </span>
            <strong>{name}</strong>
            <span className="branding-preview-nav" data-current>
              {say('sampleNav')}
            </span>
            <span className="branding-preview-nav">{say('sampleOther')}</span>
          </div>
        </figure>
        <figure>
          <figcaption>{say('previewRecord')}</figcaption>
          <div className="branding-preview-record">
            <strong>{say('sampleRecord')}</strong>
            <span className="branding-preview-pill">{say('sampleStatus')}</span>
            <span className="branding-preview-button">{say('sampleAction')}</span>
          </div>
        </figure>
        <figure>
          <figcaption>{say('previewStat')}</figcaption>
          <div className="branding-preview-stat">
            <span>{say('sampleStat')}</span>
            <strong>128</strong>
            <span className="branding-preview-bars" aria-hidden="true">
              {[40, 64, 52, 80, 70].map((height, index) => (
                <i key={index} style={{ height: `${height}%` }} />
              ))}
            </span>
          </div>
        </figure>
        <figure>
          <figcaption>{say('previewEmail')}</figcaption>
          <div className="branding-preview-email">
            <div className="branding-preview-email-head">
              {logo ? <img src={logo} alt="" width={96} height={24} /> : <strong>{name}</strong>}
            </div>
            <p>{say('sampleEmailLine')}</p>
            <span className="branding-preview-button">{say('sampleEmailButton')}</span>
          </div>
        </figure>
      </section>
    </div>
  );
}
