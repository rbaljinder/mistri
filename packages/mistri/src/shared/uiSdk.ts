/**
 * The public SDK a custom component draws with, `@mistriwork/mistri/ui`, as both sides
 * need to name it: the server serves each host module a component imports as
 * a small module over the page's own copy (componentSdk.ts), and a
 * component's bare names are written as their paths when it is served
 * (http/componentRoutes.ts). One
 * React, one QueryClient: a component that brought its own React would break
 * hooks, and one with its own query cache would outlive a sign-out.
 *
 * `UI_EXPORTS` is the SDK's runtime surface, pinned against the module that
 * implements it (packages/mistri/src/client/components/sdk/index.ts) by a component test, so
 * the served module can never offer a name the host does not have.
 */

/** Where the host modules are served, and the bare names a served component's imports are written from. */
export const SDK_PATH = '/_mistri/sdk/';
export const HOST_MODULES = {
  react: 'react.js',
  'react/jsx-runtime': 'react-jsx-runtime.js',
  'react-dom': 'react-dom.js',
  '@mistriwork/mistri/ui': 'ui.js',
  '@mistriwork/mistri/page': 'page.js',
} as const;
export type HostModule = keyof typeof HOST_MODULES;
/** The host modules once each. Pure, so the page's bundle, which reads only `HOST_GLOBAL` here, drops it. */
export const SERVED_MODULES = /* @__PURE__ */ Object.keys(HOST_MODULES) as HostModule[];

/** The global the page puts its modules on, read only by the served host modules. */
export const HOST_GLOBAL = '__mistri';

/** Every value `@mistriwork/mistri/ui` exports. */
export const UI_EXPORTS = [
  'React',
  'Fragment',
  'useState',
  'useEffect',
  'useMemo',
  'useRef',
  'useCallback',
  'useId',
  'useReducer',
  'useContext',
  'Card',
  'Stack',
  'Row',
  'Heading',
  'Button',
  'Dropdown',
  'SplitListDetail',
  'Value',
  'Tone',
  'Meter',
  'Empty',
  'Icon',
  'Segmented',
  'Stat',
  'Columns',
  'Table',
  'useRows',
  'useRecord',
  'useBreakdown',
  'useNavigate',
  'useComposer',
  'useFormat',
  'useLook',
  'useToken',
  'tokens',
  'useSectionSize',
  'useCommand',
  'useViewer',
  'useFile',
  'useFlags',
  'useVisitor',
  'useAnalytics',
  'useMessage',
] as const;

/**
 * Every value `@mistriwork/mistri/page` exports: `definePage`, and the blocks a
 * free-form page draws with — the kit's layout and parts, and the
 * platform's own command form (components/sdk/page.tsx).
 */
export const PAGE_EXPORTS = [
  'definePage',
  'useAddressState',
  'CommandForm',
  'Stack',
  'Row',
  'Columns',
  'Card',
  'Heading',
  'Button',
  'Empty',
  'Stat',
  'Value',
  'Grid',
  'Panel',
  'Tabs',
  'Rows',
  'RecordCard',
  'Metric',
  'Chart',
  'Breakdown',
  'Timeline',
  'Tree',
  'Gantt',
  'Assistant',
] as const;

/** Where an App's compiled components are served: `/{app}/_components/<file>`. */
export const COMPONENTS_SEGMENT = '_components';
