/**
 * Shared `onDemand` room wrappers imported by both `AppLanding` (home) and
 * `appnav` (route dispatch) so loading a Dashboard or FreePage at home warms
 * the exact same chunk closure used when navigating to another page.
 */
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';

export const SharedDashboard = onDemand(() => import('./Dashboard.js'), 'Dashboard');
export const SharedFreePage = onDemand(() => import('./FreePage.js'), 'FreePage');
