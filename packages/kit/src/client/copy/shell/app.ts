/** What app says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages(
  {
    /* The skip link and the wordmark's title, said over the page's HTML (index.html). */
    skipToContent: 'Skip to content',
    backToTheSchema: 'Back to the schema (h)',
    brandHome: '{app} home',
    openingWorkspace: 'Opening workspace…',
    filterMenu: 'Filter menu',
    filterTables: 'Filter tables',
    appMenu: 'App menu',
    authoring: 'Authoring',
    themeLab: 'Theme lab',
    appSettings: 'App settings',
    viewMenu: 'View',
    preferences: 'Preferences…',
    appearanceAndListSettings: 'appearance and list settings',
    pages: 'Pages',
    showingInstead: '{message} Showing {label} instead.',
    sessionExpired: 'Session expired',
    signedOut: 'Signed out',
    accountChanged: 'Account changed',
    sessionUnavailable: 'Session unavailable',
    reloadToVerifyYourSession:
      'Reload to verify your session and continue. Unsaved edits have not been submitted. If a save was in progress, check the record before trying again.',
    couldNotReadTheSchema: 'Could not read the schema: {message}',
    thisTenantLinkIsInvalid: 'This tenant link is invalid. Your current tenant has not changed.',
    darkMode: 'Dark mode',
    theCurrentDatabase: 'the current database',
    one: 'one {base}',
  },
  {
    /* The words a visitor sees in the shell; the rest are said in English. */
    es: {
      appMenu: 'Menú de la aplicación',
      viewMenu: 'Ver',
      preferences: 'Preferencias…',
      appearanceAndListSettings: 'apariencia y ajustes de las listas',
      darkMode: 'Modo oscuro',
      skipToContent: 'Saltar al contenido',
      brandHome: 'Inicio de {app}',
      appSettings: 'Ajustes de la aplicación',
      pages: 'Páginas',
    },
  },
);
