/**
 * `@mistriwork/mistri/react/tanstack-router`: the shell under TanStack Router. The host's route is a splat under
 * the App's prefix (`/crm/$`):
 *
 *   const crm = createRoute({ getParentRoute: () => root, path: '/crm/$', component: Crm });
 *   function Crm() {
 *     return (
 *       <Provider endpoint="/api/tw" navigator={useTanStackNavigator()}>
 *         <App app="compass" basePath="/crm" />
 *       </Provider>
 *     );
 *   }
 */
import type { Navigator } from './react.js';

export declare function useTanStackNavigator(): Navigator;
