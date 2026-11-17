/**
 * The reader's settings as one page, `/{app}/settings`: their profile, how the App looks, and how it reads. Each
 * section says what it is about on one side and holds its rows on the other, with a rule between sections.
 *
 * Nothing here is a second copy of a setting. The profile is the profile dialog's own form drawn without its
 * dialog (AccountProfile.tsx), and the preferences are the kit's rows (Prefs.tsx), which still apply as they are
 * chosen. The room is fetched when it is first opened (appnav.js), so no first page carries it.
 */
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { personFacing } from '@mistriwork/kit/client/audience.js';
import { PrefsRows } from '@mistriwork/kit/client/components/Prefs.js';
import { message, messageLanguage, subscribeMessages } from '@mistriwork/kit/client/messages.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { activeApp, profileIsOffered } from '../appState.js';
import { AccountProfile } from './AccountProfile.js';
import { TenantDomains } from './TenantDomains.js';
import { say } from '../copy/account/components/AccountProfile.js';
import { say as words } from '../copy/account/components/SettingsRoom.js';
import './SettingsRoom.css';

function Section({
  title,
  about,
  children,
  at,
}: {
  title: string;
  about: string;
  children: ReactNode;
  at?: (node: HTMLElement | null) => void;
}) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id} ref={at}>
      <div className="settings-about">
        <h2 id={id}>{title}</h2>
        <p>{about}</p>
      </div>
      <div className="settings-rows">{children}</div>
    </section>
  );
}

export function SettingsRoom({ section }: { section?: string }) {
  const id = useId();
  /* The words follow the language as it is picked on this very page. */
  useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity);
  const profile = identity.mode === 'authenticated' && profileIsOffered();
  const person = personFacing();
  const preferences = useRef<HTMLElement | null>(null);
  /* Opened at its preferences, the page shows them: on a short screen the profile would fill it. The profile is
     first, so opening at it needs no move, and its name takes the focus as it does in the dialog. */
  useEffect(() => {
    if (section === 'preferences' && profile) preferences.current?.scrollIntoView({ block: 'start' });
  }, [section, profile]);
  /* The pane bar's trail reads the menu's current row, and this room has none: it says its own name there while
     it stands (sidebarShell.js hears it). */
  const title = message('common.settings');
  useEffect(() => {
    const tell = (detail: string): void => {
      document.dispatchEvent(new CustomEvent('mistri:room-title', { detail }));
    };
    tell(title);
    return () => tell('');
  }, [title]);
  return (
    <section className="settings" aria-labelledby={`${id}-title`}>
      <div className="applist-head">
        <h1 className="applist-title" id={`${id}-title`}>
          {title}
        </h1>
      </div>
      {profile && (
        <Section title={say('yourProfile')} about={say('yourNameIsEditable')}>
          <AccountProfile embedded focus={section === 'profile'} onClose={() => {}} />
        </Section>
      )}
      {/* One region by the dialog's name: the reader's preferences are these two sections, wherever they are met. */}
      <div
        className="settings-group"
        role="region"
        aria-label={message('preferences.title')}
        ref={(node) => {
          preferences.current = node;
        }}
      >
        {/* The look is the App owner's, and how lists are drawn is the office's: the App's own public keeps their
            language alone (audience.ts). */}
        {!person && (
          <Section title={words('appearance')} about={words('appearanceHint')}>
            <PrefsRows part="appearance" />
          </Section>
        )}
        <Section title={words('reading')} about={words(person ? 'readingHintPerson' : 'readingHint')}>
          <PrefsRows part="language" />
          {!person && <PrefsRows part="lists" />}
        </Section>
      </div>
      {/* Only where the suite lets a tenant bring its own domain: the payload says so for a tenant's lease alone. */}
      {(activeApp() as { domains?: true } | null)?.domains === true && (
        <Section title={words('domains')} about={words('domainsHint')}>
          <TenantDomains />
        </Section>
      )}
    </section>
  );
}
