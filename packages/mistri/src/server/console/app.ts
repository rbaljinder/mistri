/** Internal registration contract. The suite host must reserve this ID, opt in
 * explicitly, mount under its base, and use existing suite admission/login.
 * This descriptor is not itself host registration or a new identity owner. */
import { parseAppConfig } from '../../shared/app.js';

export const CONSOLE_APP_ID = 'mistri-console';
export const CONSOLE_MOUNT_PATH = '/_mistri/console';
const consoleComponent = {
  id: 'console-controls',
  kind: 'page' as const,
  module: './client/components/console/ConsoleRoom.tsx',
  props: { endpoint: { type: 'text' as const } },
};
/** The Operations, Analytics and Governance pages: each reads and acts through
 * the Console's own routes, which answer per App from that App's own
 * `operations` grants, never from the Console's `admitted` role. */
const consoleOperationsComponent = {
  id: 'console-operations',
  kind: 'page' as const,
  module: './client/components/console/OperationsRoom.tsx',
  props: { endpoint: { type: 'text' as const } },
};
const consoleAnalyticsComponent = {
  id: 'console-analytics',
  kind: 'page' as const,
  module: './client/components/console/AnalyticsRoom.tsx',
  props: { endpoint: { type: 'text' as const } },
};
/** Governance answers from each App's own `admin` role, as the suite's access page does. */
const consoleGovernanceComponent = {
  id: 'console-governance',
  kind: 'page' as const,
  module: './client/components/console/GovernanceRoom.tsx',
  props: { endpoint: { type: 'text' as const } },
};
/** Every component the Console App draws, compiled together. */
export const consoleComponentList = [
  consoleComponent,
  consoleOperationsComponent,
  consoleAnalyticsComponent,
  consoleGovernanceComponent,
] as const;
export const consoleInternalApp = Object.freeze({
  id: CONSOLE_APP_ID,
  internalApp: true,
  private: true,
  mountPath: CONSOLE_MOUNT_PATH,
});

/** Free-form pages, written as data (the App is internal and has no directory
 * of page files), plus read-only record resources. The lazy page draws
 * dedicated command forms; its Console-owned transport checks target powers.
 * The admitted role's virtual-resource reads grant no generic writes. */
export function createConsoleApp(basePath = CONSOLE_MOUNT_PATH) {
  return parseAppConfig(
    {
      id: CONSOLE_APP_ID,
      name: 'Console',
      ui: {
        logo: 'sliders',
        theme: { preset: 'lumen' },
        shell: {
          placement: 'side',
          rail: true,
          width: 'full',
          headerWidth: 'content',
          gutter: 'comfortable',
          search: false,
          breadcrumbs: false,
          counts: false,
          sidebar: { density: 'compact' },
        },
      },
      resources: { targets: {}, flags: {}, history: {}, results: {} },
      auth: {
        signUp: 'invite',
        defaultRole: 'admitted',
        rows: 'all',
        roles: { admitted: { read: ['targets', 'flags', 'history', 'results'], write: false } },
      },
      views: {
        // Each page draws its own head (ConsoleShell's ConsoleHead) — its name beside the App it is about and the jump box —
        // so the page's title is hidden and no lede stands above it; what each page is for is said here instead.
        targets: {
          kind: 'page',
          label: 'Feature flags',
          heading: false,
          icon: 'flag',
          // Release controls for each App: values, rollout and targeting, with every change recorded.
          component: consoleComponent,
          props: { endpoint: `${basePath}/api/console` },
          reads: ['targets', 'flags', 'history', 'results'],
          params: ['scope', 'flag', 'target', 'app'],
        },
        // A page declares what it reads; these two read only their own routes, so they name the one resource every admitted operator reads.
        operations: {
          kind: 'page',
          label: 'Operations',
          heading: false,
          icon: 'wrench',
          // Background work, deliveries and stores: what needs attention, and the way to put it right.
          component: consoleOperationsComponent,
          props: { endpoint: `${basePath}/api/console` },
          reads: ['targets'],
          params: ['app', 'section', 'destination', 'state', 'item'],
        },
        analytics: {
          kind: 'page',
          label: 'Analytics',
          heading: false,
          icon: 'chart-line',
          // What people did, counted. No one is named.
          component: consoleAnalyticsComponent,
          props: { endpoint: `${basePath}/api/console` },
          reads: ['targets'],
          params: ['app', 'view', 'range', 'from', 'to', 'event', 'funnel'],
        },
        governance: {
          kind: 'page',
          label: 'Governance',
          heading: false,
          icon: 'shield-check',
          // Who did what, what each role may do, and who holds which role: read, never changed here.
          component: consoleGovernanceComponent,
          props: { endpoint: `${basePath}/api/console` },
          reads: ['targets'],
          params: ['app', 'view', 'who', 'what', 'from', 'to'],
        },
        flags: { kind: 'list', from: 'flags', label: 'Flags', show: ['flagId', 'owner', 'revision', 'disabled'] },
      },
      home: 'targets',
      nav: ['targets', 'operations', 'analytics', 'governance'],
    },
    'internal Console App',
  );
}
