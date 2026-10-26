/**
 * `@mistriwork/mistri/react/react-router`: the shell under React Router (v6.4 and v7, `<BrowserRouter>` or a data
 * router). The host's route matches everything under the App's prefix:
 *
 *   <Route path="/crm/*" element={<Crm />} />
 *   function Crm() {
 *     return (
 *       <Provider endpoint="/api/tw" navigator={useReactRouterNavigator()}>
 *         <App app="compass" basePath="/crm" />
 *       </Provider>
 *     );
 *   }
 */
import type { Navigator } from './react.js';

export declare function useReactRouterNavigator(): Navigator;
