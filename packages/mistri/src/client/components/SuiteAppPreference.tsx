import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  saveSuitePreference,
  suiteApps,
  suiteNavigationCurrent,
  suitePreference,
  SuiteRequestError,
  useSuiteNavigation,
  type SuiteApp,
  type SuiteNavigationScope,
  type SuitePreference,
} from '../suiteNavigation.js';
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { say } from '../copy/shell/components/SuiteAppPreference.js';
import './SuiteNavigation.css';

export function SuiteAppPreference() {
  const scope = useSuiteNavigation();
  return scope ? <Preference key={scope.generation} scope={scope} /> : null;
}

function Preference({ scope }: { scope: SuiteNavigationScope }) {
  useMessageLanguage();
  const hint = useId();
  const [view, setView] = useState<{
    apps: SuiteApp[];
    preference: SuitePreference | null;
    selection: string | null;
    status: 'loading' | 'ready' | 'saving' | 'refresh' | 'error';
    conflict: boolean;
    saved: boolean;
  }>({
    apps: [],
    preference: null,
    selection: null,
    status: 'loading',
    conflict: false,
    saved: false,
  });
  const lifetime = useRef<{ active: boolean; controller?: AbortController; saving: boolean }>({ active: false, saving: false });
  const current = (controller: AbortController) => lifetime.current.active && !controller.signal.aborted && suiteNavigationCurrent(scope);
  const refresh = useCallback(() => {
    const live = lifetime.current;
    if (!live.active || live.saving || !suiteNavigationCurrent(scope)) return;
    live.controller?.abort();
    const controller = (live.controller = new AbortController());
    setView((was) => ({ ...was, status: 'loading', saved: false }));
    void Promise.all([suiteApps(scope, controller.signal), suitePreference(scope, controller.signal)])
      .then(([apps, preference]) => {
        if (live.active && !controller.signal.aborted && suiteNavigationCurrent(scope))
          setView((was) => ({
            apps,
            preference,
            selection: was.preference && was.selection !== was.preference.defaultApp ? was.selection : preference.defaultApp,
            status: 'ready',
            conflict: false,
            saved: false,
          }));
      })
      .catch(() => {
        if (live.active && !controller.signal.aborted && suiteNavigationCurrent(scope)) setView((was) => ({ ...was, status: 'error' }));
      });
  }, [scope]);
  useEffect(() => {
    lifetime.current.active = true;
    refresh();
    return () => {
      lifetime.current.active = false;
      lifetime.current.controller?.abort();
    };
  }, [refresh]);
  const allowed = view.selection === null || view.apps.some((app) => app.id === view.selection);
  const save = async () => {
    const live = lifetime.current;
    if (!live.active || live.saving || !suiteNavigationCurrent(scope) || view.status !== 'ready' || !view.preference || !allowed) return;
    live.saving = true;
    live.controller?.abort();
    const controller = (live.controller = new AbortController());
    setView((was) => ({ ...was, status: 'saving', saved: false }));
    try {
      const preference = await saveSuitePreference(scope, controller.signal, view.selection, view.preference.revision);
      if (current(controller)) setView((was) => ({ ...was, preference, selection: preference.defaultApp, status: 'ready', saved: true }));
    } catch (error) {
      if (current(controller))
        setView((was) => ({ ...was, status: 'refresh', conflict: error instanceof SuiteRequestError && error.status === 409 }));
    } finally {
      live.saving = false;
    }
  };
  return (
    <section className="prefs-row suite-preference" aria-label={say('defaultApp')}>
      <div className="prefs-name">
        <span>{say('defaultApp')}</span>
        <span id={hint} className="prefs-hint">
          {say('accountHint')}
        </span>
      </div>
      <div className="suite-preference-controls">
        {/* Retire removed options without letting Select normalize the draft to Ask each time. */}
        <Dropdown
          key={JSON.stringify(view.apps.map((app) => app.id))}
          ariaLabel={say('defaultApp')}
          ariaDescribedBy={hint}
          value={view.selection ?? ''}
          disabled={view.status !== 'ready'}
          items={[{ value: '', label: say('ask') }, ...view.apps.map((app) => ({ value: app.id, label: app.name }))]}
          onChange={(value) => setView((was) => (was.status === 'ready' ? { ...was, selection: value || null, saved: false } : was))}
        />
        {view.status === 'loading' && <p role="status">{say('loading')}</p>}
        {view.status === 'error' && <p role="status">{say('loadFailed')}</p>}
        {view.status === 'refresh' && <p role="status">{view.conflict ? say('conflict') : say('uncertain')}</p>}
        {view.status === 'ready' && !allowed && <p role="status">{say('unavailable')}</p>}
        {view.saved && <p role="status">{say('saved')}</p>}
        <div className="suite-preference-actions">
          <button
            type="button"
            className="ghost"
            disabled={view.status !== 'ready' || !allowed || view.selection === view.preference?.defaultApp}
            onClick={() => void save()}
          >
            {view.status === 'saving' ? say('saving') : say('save')}
          </button>
          <button type="button" className="ghost" disabled={view.status === 'loading' || view.status === 'saving'} onClick={refresh}>
            {say('refresh')}
          </button>
        </div>
      </div>
    </section>
  );
}
