/**
 * The shell's answers a page's boot names (app.js, appNavigation.js's appShell), read
 * from the modules those answers come from, for a component test that drives
 * the App, the visitor, the tenant, Undo or the record's verbs through those modules, or a mock of
 * them, as the page does: `beforeEach(bridgeShell)`.
 *
 * Called in the test's own hook, after its vi.mock calls, so a mock is what is
 * read; an export a mock leaves out keeps the Workbench's answer. Not in the
 * setup file: importing these modules there, ahead of a test that resets the
 * module graph (vi.resetModules), leaves that test two session identities.
 */
import { installShell, shell } from '../packages/kit/src/client/shellMode.js';

export async function bridgeShell(): Promise<void> {
  /* A module whose own imports a test mocked away cannot load; its answers stay the Workbench's. */
  const load = <T>(module: Promise<T>) => module.catch(() => undefined);
  const [
    appState,
    visitor,
    mutations,
    account,
    transport,
    undo,
    actions,
    importing,
    split,
    freePage,
    customList,
    pageBuilder,
    composer,
    commands,
    targetAction,
    targetLinks,
    navTargets,
    formDialog,
    formLines,
  ] = await Promise.all([
    load(import('../packages/mistri/src/client/appState.js')),
    load(import('../packages/mistri/src/client/publicVisitor.js')),
    load(import('../packages/mistri/src/client/tenantMutationState.js')),
    load(import('../packages/mistri/src/client/tenantAccountState.js')),
    load(import('../packages/mistri/src/client/tenantTransport.js')),
    load(import('../packages/tablewalk/src/client/undo.js')),
    load(import('../packages/mistri/src/client/components/Actions.js')),
    load(import('../packages/mistri/src/client/components/ImportButton.js')),
    load(import('../packages/mistri/src/client/components/SplitRecordRoom.js')),
    load(import('../packages/mistri/src/client/components/FreePage.js')),
    load(import('../packages/mistri/src/client/components/sdk/CustomList.js')),
    load(import('../packages/tablewalk/src/client/pagebuilder.js')),
    load(import('../packages/mistri/src/client/components/TimelineComposer.js')),
    load(import('../packages/mistri/src/client/components/sdk/commands.js')),
    load(import('../packages/mistri/src/client/components/AppTargetAction.js')),
    load(import('../packages/mistri/src/client/appTargetLinks.js')),
    load(import('../packages/mistri/src/client/appNavTargets.js')),
    load(import('../packages/mistri/src/client/components/FormDialog.js')),
    load(import('../packages/mistri/src/client/components/FormLines.js')),
  ]);
  /* A mock's missing export throws when read. */
  const has = (module: object | undefined, name: string) => {
    try {
      return module !== undefined && (module as Record<string, unknown>)[name] != null;
    } catch {
      return false;
    }
  };
  const answers: Parameters<typeof installShell>[0] = {};
  if (has(appState, 'activeApp')) answers.app = () => appState!.activeApp();
  if (has(appState, 'inAppMode')) answers.inApp = () => appState!.inAppMode();
  if (has(appState, 'appLoadError')) answers.loadError = () => appState!.appLoadError();
  if (has(appState, 'appSaveMode')) answers.saveMode = () => appState!.appSaveMode();
  if (has(visitor, 'isPublicVisitor')) answers.publicVisitor = () => visitor!.isPublicVisitor();
  if (has(mutations, 'tenantMutationState')) answers.mutations = mutations!.tenantMutationState;
  if (has(account, 'hasUnresolvedAdministration') && has(account, 'hasUnresolvedInvitations'))
    answers.accountBusy = () => account!.hasUnresolvedAdministration() || account!.hasUnresolvedInvitations();
  if (has(transport, 'tenantReadApi') && has(transport, 'tenantMutationApi') && has(transport, 'isTenantMutationPath'))
    answers.tenant = { read: transport!.tenantReadApi, mutate: transport!.tenantMutationApi, isMutation: transport!.isTenantMutationPath };
  answers.undo = {
    refresh: () => (has(undo, 'refreshUndo') ? undo!.refreshUndo() : undefined),
    last: (id) => (has(undo, 'undoLast') ? undo!.undoLast(id as never) : undefined),
    toast: (id, after) => (has(undo, 'undoToast') ? undo!.undoToast(id, after) : undefined),
  };
  if (has(actions, 'ActionBar'))
    /* A slot no module here answers keeps the Workbench's none: an author's page section (sdk/CustomSection.tsx)
       is drawn by its own test, and a suite's preference by its. */
    answers.slots = {
      ...shell().slots,
      ImportButton: has(importing, 'ImportButton') ? importing!.ImportButton : null,
      CustomList: has(customList, 'CustomList') ? customList!.CustomList : null,
      TimelineComposer: has(composer, 'TimelineComposer') ? composer!.TimelineComposer : null,
      ActionBar: actions!.ActionBar,
      useReachable: has(actions, 'useReachable') ? actions!.useReachable : () => new Set<string>(),
    };
  /* The App framework's parts in the kit's lists, headlines, notes, menu and New form (appnav.js names them). */
  const slots: Partial<ReturnType<typeof shell>['slots']> = {};
  if (has(commands, 'bulkCommands')) slots.bulkCommands = commands!.bulkCommands;
  if (has(commands, 'recordCommand')) slots.recordCommand = commands!.recordCommand;
  if (has(targetAction, 'AppTargetAction')) slots.TargetAction = targetAction!.AppTargetAction;
  if (has(targetLinks, 'useAppTargetLinks')) slots.useTargetLinks = targetLinks!.useAppTargetLinks;
  if (has(navTargets, 'navTargets')) slots.navTargets = navTargets!.navTargets;
  if (has(formDialog, 'FormDialog')) slots.FormDialog = formDialog!.FormDialog;
  if (has(formLines, 'LinesEditor')) {
    const part = formLines!;
    slots.formLines = { ready: () => Promise.resolve(), here: () => true, get: () => part };
  }
  answers.slots = { ...(answers.slots ?? shell().slots), ...slots };
  /* The App's rooms the kit's rooms reach through the slot, where a test draws them (Rooms.tsx). */
  if (has(split, 'SplitRecordRoom') || has(freePage, 'FreePage'))
    answers.rooms = {
      ...shell().rooms,
      SplitRecord: has(split, 'SplitRecordRoom') ? split!.SplitRecordRoom : null,
      Page: has(freePage, 'FreePage') ? freePage!.FreePage : null,
    };
  /* The Workbench's page builder (workbench.js installs it), read through the module so a mock of it is what opens. */
  if (has(pageBuilder, 'openBuilder')) answers.editPage = (page, options) => void pageBuilder!.openBuilder(page as never, options);
  installShell(answers);
}
