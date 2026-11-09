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
  'Cluster',
  'Heading',
  'Button',
  'Dropdown',
  'SplitListDetail',
  'Value',
  'Tone',
  'Meter',
  'Empty',
  'Loaded',
  'Icon',
  'Segmented',
  'Stat',
  'Columns',
  'Table',
  'useRows',
  'useRecord',
  'useBreakdown',
  'useNavigate',
  'useHref',
  'useComposer',
  'useFormat',
  'useLook',
  'useToken',
  'tokens',
  'useSectionSize',
  'useCommand',
  'useAction',
  'useViewer',
  'useFile',
  'useFlags',
  'useVisitor',
  'useAnalytics',
  'useMessage',
  'useDeployment',
  'useField',
  'parseMoney',
  'layoutPoint',
  'useOptions',
] as const;

/**
 * What `@mistriwork/mistri/page` adds to the SDK: `definePage` and `defineSurface`, the platform's command form and per-row buttons,
 * `Scope` and `List`, the platform's sections as blocks (components/sdk/page.tsx) and the house controls.
 */
const PAGE_ONLY = [
  'definePage',
  'defineSurface',
  'useAddressState',
  'CommandForm',
  'CommandButton',
  'ActionButton',
  'Scope',
  'List',
  'Grid',
  'Panel',
  'Text',
  'Tabs',
  'Rows',
  'RecordCard',
  'Metric',
  'Chart',
  'Breakdown',
  'Timeline',
  'Tree',
  'Gantt',
  'Board',
  'Calendar',
  'Gallery',
  'Split',
  'Assistant',
  'Choose',
  'Search',
  'DateRange',
  'Steps',
  'Avatar',
  'CheckCards',
  'Checkbox',
  'ChoiceCards',
  'DateField',
  'Drawer',
  'Modal',
  'Pagination',
  'Popover',
  'Select',
  'Slider',
  'Switch',
  'TextField',
  'Tooltip',
  'YesNo',
] as const;

/**
 * Every value `@mistriwork/mistri/page` exports: the one import a page needs. `@mistriwork/mistri/ui` is a part of
 * it, so a component written for a record page moves to a free-form page without changing an import.
 */
export const PAGE_EXPORTS = [...UI_EXPORTS, ...PAGE_ONLY] as const;

/** Where an App's compiled components are served: `/{app}/_components/<file>`. */
export const COMPONENTS_SEGMENT = '_components';
