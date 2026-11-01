/**
 * Preferences: visual theme, color mode, density, typography, and list lengths. Each
 * is a dropdown over a setting that already lives somewhere else; this
 * dialog only puts them in one place.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { api, PAGE_SIZES, pageSize, render, setPageSize, state, toast } from '../core.js';
import { shell } from '../shellMode.js';
import { ownedBy } from '../requestIdentity.js';
import { densityChoice, setDensity } from '../density.js';
import { setTypography, typographyPreference } from '../typography.js';
import {
  setVisualPalette,
  visualPaletteChoice,
  visualPaletteOptions,
  appVisualTheme,
  readerOverridesAppTheme,
  resetVisualTheme,
  setVisualTheme,
  visualThemeChoice,
  visualThemeOptions,
  visualThemeScheme,
  visualThemesOffered,
  VISUAL_THEME_EVENT,
  VISUAL_THEME_REGISTRY_EVENT,
} from '../visualTheme.js';
import { setTheme, themeChoice } from '../theme.js';
import { message, messageLanguage, offeredLanguages, servedLanguage, setMessageLanguage, subscribeMessages } from '../messages.js';
import { Dropdown } from './Dropdown.js';
import { RELATED_SIZES, relatedRows, setRelatedRows, subscribeRelatedRows } from '../relatedRows.js';
import { say } from '../copy/shell/components/Prefs.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

function Row({ label, hint, action, children }: { label: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="prefs-row">
      <div className="prefs-name">
        <span>{label}</span>
        {hint ? <span className="prefs-hint">{hint}</span> : null}
        {action}
      </div>
      {children}
    </div>
  );
}

/** A language as it calls itself: "Español", "English", "Português (Brasil)". */
function ownName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return tag;
  }
}

/**
 * The language picker. Where the App has words in several languages the
 * server says them, so the pick is one of the App's (written to the reader's
 * row where `ui.locale` names a column of it, and kept in this browser either
 * way); anywhere else it is the framework's own, kept in this browser.
 */
function LanguageRow({ language }: { language: string }) {
  const offered = offeredLanguages();
  const row = (shell().app()?.ui as { localeRow?: { table: string; key: Record<string, string | number>; column: string } } | undefined)
    ?.localeRow;
  const served = servedLanguage();
  const value = offered.length
    ? (offered.find((tag) => tag === served) ?? offered.find((tag) => served?.split('-')[0] === tag.split('-')[0]) ?? offered[0])
    : language;
  const pick = async (tag: string) => {
    if (offered.length && row) {
      try {
        const reply = (await api('/api/update', {
          ...ownedBy(state.activeConnection),
          table: row.table,
          key: row.key,
          values: { [row.column]: tag },
        })) as { errors?: Array<{ message?: string }> };
        if (reply?.errors?.length) throw new Error(reply.errors[0]?.message ?? say('notSaved'));
      } catch (error) {
        /* Still this browser's: the pick stands here, and the reader is told it did not reach their profile. */
        toast((error as Error).message || say('notSaved'), 'error');
      }
    }
    await setMessageLanguage(tag);
  };
  return (
    <Row label={message('preferences.language')} hint={message(row ? 'preferences.languageHintPerson' : 'preferences.languageHint')}>
      <Dropdown
        ariaLabel={message('preferences.language')}
        value={value}
        onChange={(tag) => void pick(tag)}
        items={
          offered.length
            ? offered.map((tag) => ({ value: tag, label: ownName(tag) }))
            : [
                { value: 'en', label: say('english') },
                { value: 'es', label: ownName('es') },
              ]
        }
      />
    </Row>
  );
}

export function PrefsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<ModalHandle>(null);
  const language = useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
  const related = useSyncExternalStore(subscribeRelatedRows, relatedRows);
  /* The choices live in their stores; a pick writes there and this looks
     again, so the picker shows what was just chosen rather than what it
     opened on. */
  const [, look] = useState(0);
  useEffect(() => {
    const refresh = () => look((n) => n + 1);
    addHostListener(window, VISUAL_THEME_REGISTRY_EVENT, refresh);
    addHostListener(window, VISUAL_THEME_EVENT, refresh);
    return () => {
      removeHostListener(window, VISUAL_THEME_REGISTRY_EVENT, refresh);
      removeHostListener(window, VISUAL_THEME_EVENT, refresh);
    };
  }, []);
  const after = (write: () => void) => {
    write();
    look((n) => n + 1);
  };
  const darkOnly = visualThemeScheme() === 'dark-only';
  /* Which of a suite's Apps opens first is the App framework's (SuiteAppPreference.tsx), drawn through the shell's slot. */
  const { SuitePreference } = shell().slots;
  return (
    <Modal className="prefs" ref={dialog} onClose={onClose} ariaLabel={message('preferences.title')}>
      <h2 className="prefs-title">{message('preferences.title')}</h2>
      {SuitePreference && <SuitePreference />}
      <LanguageRow language={language} />
      {/* Workbench picks its own look; an App may lock its authored branding. */}
      {visualThemesOffered() && (
        <Row
          label={message('preferences.visualTheme')}
          action={
            readerOverridesAppTheme() ? (
              <button type="button" className="prefs-reset" onClick={() => after(resetVisualTheme)}>
                {message('preferences.resetTheme')}
              </button>
            ) : null
          }
        >
          <Dropdown
            ariaLabel={message('preferences.visualTheme')}
            value={visualThemeChoice()}
            onChange={(v) => after(() => setVisualTheme(v))}
            items={visualThemeOptions().map((theme) => ({
              ...theme,
              swatches: [...theme.swatches],
              ...(theme.value === appVisualTheme() ? { detail: message('preferences.appTheme') } : {}),
            }))}
          />
        </Row>
      )}
      {visualThemesOffered() && visualPaletteOptions().length > 1 && (
        <Row label={message('preferences.palette')} hint={message('preferences.paletteHint')}>
          <Dropdown
            ariaLabel={message('preferences.palette')}
            value={visualPaletteChoice()}
            onChange={(v) => after(() => setVisualPalette(v))}
            items={visualPaletteOptions().map((palette) => ({ ...palette, swatches: [...palette.swatches] }))}
          />
        </Row>
      )}
      {/* A dark-only theme has no light to choose (theme.js shows dark whatever is stored): the pick is shown as what it is. */}
      <Row label={message('preferences.colorMode')} hint={darkOnly ? message('preferences.colorModeDarkOnly') : undefined}>
        <Dropdown
          ariaLabel={message('preferences.colorMode')}
          disabled={darkOnly}
          value={darkOnly ? 'dark' : themeChoice()}
          onChange={(v) => after(() => setTheme(v))}
          items={[
            { value: 'system', label: message('preferences.system') },
            { value: 'light', label: message('preferences.light') },
            { value: 'dark', label: message('preferences.dark') },
          ]}
        />
      </Row>
      <Row label={message('preferences.density')}>
        <Dropdown
          ariaLabel={message('preferences.density')}
          value={densityChoice() as string}
          onChange={(v) => after(() => setDensity(v))}
          items={[
            { value: 'comfortable', label: message('preferences.comfortable'), detail: message('preferences.defaultHint') },
            { value: 'spacious', label: message('preferences.spacious'), detail: message('preferences.spaciousHint') },
            { value: 'compact', label: message('preferences.compact'), detail: message('preferences.compactHint') },
          ]}
        />
      </Row>
      <Row label={message('preferences.typography')}>
        <Dropdown
          ariaLabel={message('preferences.typography')}
          value={typographyPreference() as string}
          onChange={(v) => after(() => setTypography(v))}
          items={[
            { value: 'default', label: message('preferences.appDefault') },
            { value: 'mono', label: message('preferences.mono'), detail: message('preferences.monoHint') },
            { value: 'sans', label: message('preferences.sans'), detail: message('preferences.sansHint') },
          ]}
        />
      </Row>
      <Row label={message('preferences.rowsPerList')} hint={message('preferences.rowsPerListHint')}>
        <Dropdown
          ariaLabel={message('preferences.rowsPerList')}
          value={String(pageSize())}
          onChange={(v) =>
            after(() => {
              setPageSize(Number(v));
              render();
            })
          }
          items={(PAGE_SIZES as number[]).map((n) => ({ value: String(n), label: String(n) }))}
        />
      </Row>
      <Row label={message('preferences.rowsPerRelatedList')} hint={message('preferences.rowsPerRelatedListHint')}>
        <Dropdown
          ariaLabel={message('preferences.rowsPerRelatedList')}
          value={String(related)}
          onChange={(v) => {
            setRelatedRows(Number(v));
            render();
          }}
          items={RELATED_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
        />
      </Row>
      <div className="prefs-foot">
        <button type="button" className="ghost" onClick={() => dialog.current?.close()}>
          {message('common.close')}
        </button>
      </div>
    </Modal>
  );
}
