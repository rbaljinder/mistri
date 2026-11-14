import { uiKitConformance } from '@mistriwork/ui/conformance.js';
import { test } from 'vitest';

/* The control: the same suite with no kit, so every slot is today's, over Base UI. It passing here says the
   harness reads mistri's source as mistri's own tests do, and a failure in kit.test.tsx is the kit's. */
uiKitConformance({}, test);
