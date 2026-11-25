/**
 * `@mistriwork/mistri/ui`: everything a custom component imports from mistri. The
 * host's own React (re-exported, so a component can take its hooks from here
 * and never resolve a React of its own), the unified UI controls/primitives/charts/views,
 * Mistri's schema-aware kit pieces (`kit.tsx`), and the hooks (`hooks.ts`). Nothing else of the
 * client is reachable through it: no store, no walk, no raw request.
 *
 * In the page this module is the page's own, handed to components through
 * the host modules (packages/mistri/src/server/app/componentSdk.ts); published, it is built to
 * dist/ui for a component's tests (config/vite.ui.config.ts), with its types in
 * packages/mistri/schema/ui.d.ts. Its value exports are `UI_EXPORTS` (shared/uiSdk.ts),
 * which a test holds to this list.
 */
import '@mistriwork/kit/client/formControls.css';
import { installSurfaceSeam } from '@mistriwork/ui';
import * as React from 'react';
import { mistriSurfaceSeam } from './seam.js';

export { React };
export { UI_TOKENS as tokens } from '@mistriwork/kit/shared/uiTokens.js';
export { Fragment, useCallback, useContext, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
export {
  Badge,
  Button,
  Checkbox,
  ChoiceCards,
  Dropdown,
  FileField,
  Select,
  Slider,
  Switch,
  TextArea,
  TextField,
  YesNo,
} from '@mistriwork/ui';
export {
  AiBadge,
  Beside,
  Card,
  Cluster,
  DescriptionList,
  EmptyState,
  Heading,
  ItemList,
  ItemRow,
  Meter,
  Person,
  Row,
  SegmentedControl,
  Skeleton,
  Stack,
  StatCard,
  StatusDot,
  Text,
  VisuallyHidden,
} from '@mistriwork/ui/primitives.js';
export { BreakdownList, MiniBars, Sparkline } from '@mistriwork/ui/charts.js';
export { SplitView } from '@mistriwork/ui/views.js';
export { Columns, Icon, Loaded, Table, Tile, Value } from './kit.js';
export {
  useAction,
  useAnalytics,
  useAssistant,
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
  useNotice,
  useRecord,
  useRows,
  useSectionSize,
  useToken,
  useViewer,
  useVisitor,
} from './hooks.js';
export { useTeam } from './team.js';
export { useAccountProfile } from './accountProfile.js';
/* The tenant's read audit, as the Settings Reads room reads it (its own module: readAudit.ts). */
export { useReadAudit } from './readAudit.js';
/* Opening a tenant in one request from a platform App's own screen (its own module: openTenant.ts). */
export { useOpenTenant } from './openTenant.js';
/* What the deployment presents the App as (its own module: deployment.ts). */
export { useBranding, useDeployment } from './deployment.js';
export { parseMoney, useField } from './fields.js';
export { layoutPoint } from './layout.js';
export { useOptions } from './options.js';

installSurfaceSeam(mistriSurfaceSeam);
