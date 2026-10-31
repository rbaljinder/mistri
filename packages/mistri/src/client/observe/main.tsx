/**
 * The dev observer's page (server/observe/): one React tree over the
 * observer's JSON, polled. Its own entry, never part of an App's bundle —
 * it is built on its own (config/vite.observe.config.ts) and served only by a
 * `--dev` start.
 */
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mistriwork/kit/client/style.css';
import './observe.css';
import { Observer } from './Observer.js';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 500 } } });
createRoot(document.getElementById('observer')!).render(
  <QueryClientProvider client={client}>
    <Observer />
  </QueryClientProvider>,
);
