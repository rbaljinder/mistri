import { uiKitConformance } from '@mistriwork/ui/conformance.js';
import { test } from 'vitest';
import kit from './index';

/* The suite @mistriwork/ui holds any control kit to, run against this one: what mistri's screens rely on from
   each slot, by role and by name. */
uiKitConformance(kit, test);
