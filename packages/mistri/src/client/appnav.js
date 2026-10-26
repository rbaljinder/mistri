/**
 * The App framework's shell, as the kit's boot calls it (app.js; shells.ts
 * says what each part is): the App's payload and answers (appNavigation.js)
 * and the chrome around the kit's bar and menu (appChrome.js). Every page
 * names it, since a page learns whether it shows an App only from the
 * runtime, and each part asks.
 */
import { appShell, loadAppNav, reloadAppNav, retireAppNav } from './appNavigation.js';
import { whenHostPlacementMoves } from './appTheme.js';
import * as chrome from './appChrome.js';
import { showAppUnavailable, showNoWorkspace } from './appUnavailable.js';
import { ActionBar, useReachable } from './components/Actions.js';
import { useDecisionMarks } from './components/decisionMarks.js';
import { useRecordDecisions } from './components/decisionAdornment.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { setRecordDialog } from '@mistriwork/kit/client/peekpanel.js';
import { AppHome } from './components/AppHome.js';
import { FormRoom } from './components/FormRoom.js';
import { FreePage } from './components/FreePage.js';
import { ImportButton } from './components/ImportButton.js';
import { AppTargetAction } from './components/AppTargetAction.js';
import { bulkCommands, recordCommand } from './components/sdk/commands.js';
import { useAppTargetLinks } from './appTargetLinks.js';
import { navTargets } from './appNavTargets.js';
import { SplitRecordRoom } from './components/SplitRecordRoom.js';

/* A view that says `open: "modal"` opens its record in the App's own dialog (peekpanel.js), fetched the first time one does. */
setRecordDialog(onDemand(() => import('./components/RecordModal.js'), 'RecordModal', { quiet: true }));

/* A New form's lines and live figures (FormLines.tsx): fetched the first time a form has them, as the form once was
   with them. A part that cannot come leaves the form without them; the server judges the lines it is sent. */
/** @type {import('@mistriwork/kit/client/shellMode.js').FormLines | undefined} */
let formLines;
const FormLinesPart = onDemand(() => import('./components/FormLines.js').then((part) => (formLines = part)), 'LinesEditor', {
  quiet: true,
});

/* The App's answers that draw are named here, beside the chrome, and not in
   appNavigation.js: that module is the App's payload and its rules, which a
   test loads without the rooms and the kit's whole record view they bring. */
/** @type {import('@mistriwork/kit/client/shells.js').ShellChrome} */
export const appChrome = {
  answers: {
    ...appShell,
    /* The App's parts the kit's rooms draw through the shell's slots (shellMode.ts). */
    slots: {
      /* The suite's switcher and its preference, with their rules: fetched when the preferences are opened, as the preferences themselves are. */
      SuitePreference: onDemand(() => import('./components/SuiteAppPreference.js'), 'SuiteAppPreference'),
      ImportButton,
      /* An embedded list's own component, and the page's side of @mistriwork/mistri/ui with it: fetched the first time a page holds one. */
      CustomList: onDemand(() => import('./components/sdk/CustomList.js'), 'CustomList'),
      /* An author's section component, and the page's side of @mistriwork/mistri/ui with it: fetched the first time a page holds one. */
      CustomSection: onDemand(() => import('./components/sdk/CustomSection.js'), 'CustomPageSection'),
      /* A conversation's composer runs an App command; loaded where a timeline offers one. */
      TimelineComposer: onDemand(() => import('./components/TimelineComposer.js'), 'TimelineComposer'),
      ActionBar,
      useReachable,
      /* A selection's commands, and a tag's: the App's command pipeline and its form. */
      bulkCommands,
      recordCommand,
      /* Calls to action into the suite's other Apps, and the nav's targets into them. */
      TargetAction: AppTargetAction,
      useTargetLinks: useAppTargetLinks,
      navTargets,
      /* Loaded the first time a headline's call to action asks: the dialog pulls the whole form surface behind it,
         which no record page needs until then. `quiet`: a dialog has no place of its own to say it is coming. */
      FormDialog: onDemand(() => import('./components/ViewFormDialog.js'), 'ViewFormDialog', { quiet: true }),
      formLines: { ready: FormLinesPart.ready, here: FormLinesPart.here, get: () => formLines },
      /* A list's marks where a decision's suggestion waits on an empty cell: asked only for a table a decision answers. */
      useCellMarks: useDecisionMarks,
      /* A record's suggestions at its fields, the chip loaded the first time a record has one. */
      useFieldAdornment: useRecordDecisions,
    },
    /* The App's own rooms, which the content pane reaches by the walk (Content.tsx). */
    rooms: {
      /* A dashboard and its charts are a chunk of their own, loaded when one is first shown. */
      Dashboard: onDemand(() => import('./components/Dashboard.js'), 'Dashboard'),
      Home: AppHome,
      Form: FormRoom,
      /* The signed-in person's notifications, loaded when first opened (the bell's menu shares the chunk). */
      Inbox: onDemand(() => import('./components/InboxList.js'), 'InboxRoom'),
      /* The assistant's page is the panel's own component, in its own chunk: nothing of it in a first page. */
      Assistant: onDemand(() => import('./components/AssistantPanel.js'), 'AssistantRoom'),
      Page: FreePage,
      SplitRecord: SplitRecordRoom,
      /* A record put on paper: its own part, so no first page carries the sheet. */
      Document: onDemand(() => import('./components/Document.js'), 'DocumentRoom'),
    },
  },
  start: chrome.startChrome,
  loadTenancy: chrome.loadTenancy,
  lifecycle: chrome.tenantLifecycle,
  signedInStart: chrome.signedInStart,
  chooseTenant: chrome.chooseTenant,
  followHistory: chrome.followTenantHistory,
  wearLook: chrome.wearLook,
  loadNav: loadAppNav,
  reloadNav: reloadAppNav,
  loadFilters: chrome.loadSavedFilters,
  retire(me) {
    retireAppNav();
    chrome.retireLook(me);
  },
  showAccount: chrome.showAccount,
  navigationReady: chrome.setTenantNavigationReady,
  brand: chrome.brandChrome,
  dress: chrome.dressChrome,
  settings: chrome.appSettingsCommands,
  menu: chrome.appMenuShell,
  compactNavigation: chrome.compactAppNavigation,
  whenMenuMoves: whenHostPlacementMoves,
  followSaves: chrome.followSaves,
  initHelp: chrome.initHelp,
  unavailable: showAppUnavailable,
  noWorkspace: showNoWorkspace,
};
