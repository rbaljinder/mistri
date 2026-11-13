/**
 * `@mistriwork/mistri/ui`: everything a custom component imports from mistri. The
 * host's own React (re-exported, so a component can take its hooks from here
 * and never resolve a React of its own), the kit (kit.tsx) and the hooks
 * (hooks.ts). Nothing else of the client is reachable through it: no store,
 * no walk, no raw request.
 *
 * In the page this module is the page's own, handed to components through
 * the host modules (packages/mistri/src/server/app/componentSdk.ts); published, it is built to
 * dist/ui for a component's tests (config/vite.ui.config.ts), with its types in
 * packages/mistri/schema/ui.d.ts. Its value exports are `UI_EXPORTS` (shared/uiSdk.ts),
 * which a test holds to this list.
 */
import * as React from 'react';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';

export { React };
export { UI_TOKENS as tokens } from '@mistriwork/kit/shared/uiTokens.js';
export { Fragment, useCallback, useContext, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
export {
  Beside,
  Button,
  Card,
  Cluster,
  Columns,
  Dropdown,
  Empty,
  Heading,
  Icon,
  Item,
  Items,
  Loaded,
  Meter,
  Row,
  Segmented,
  Skeleton,
  SplitListDetail,
  Stack,
  Stat,
  Table,
  Text,
  Tone,
  Value,
  VisuallyHidden,
} from './kit.js';
/* The platform's fields, as the shell dresses its own (pageControls.ts): a part of their own with their rules, fetched
   the first time a component draws one, so one that draws none carries none. A record section that asks a question
   draws the platform's field here, not a native input dressed to look like one. The rest of the house controls (a
   modal, a drawer, a date picker) are a free-form page's, from `@mistriwork/mistri/page`. */
const controls = () => import('./pageControls.js');
export const Checkbox = onDemand(controls, 'Checkbox', { quiet: true });
export const ChoiceCards = onDemand(controls, 'ChoiceCards', { quiet: true });
export const FileField = onDemand(controls, 'FileField', { quiet: true });
export const Select = onDemand(controls, 'Select', { quiet: true });
export const Slider = onDemand(controls, 'Slider', { quiet: true });
export const Switch = onDemand(controls, 'Switch', { quiet: true });
export const TextField = onDemand(controls, 'TextField', { quiet: true });
export const YesNo = onDemand(controls, 'YesNo', { quiet: true });
export {
  useAction,
  useAnalytics,
  useBreakdown,
  useComposer,
  useCommand,
  useGranted,
  useFile,
  useFlags,
  useFormat,
  useHref,
  useLook,
  useMessage,
  useNavigate,
  useRecord,
  useRows,
  useSectionSize,
  useToken,
  useViewer,
  useVisitor,
} from './hooks.js';
/* What the deployment presents the App as (its own module: deployment.ts). */
export { useDeployment } from './deployment.js';
export { parseMoney, useField } from './fields.js';
export { layoutPoint } from './layout.js';
export { useOptions } from './options.js';
