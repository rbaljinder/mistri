/**
 * A page inside the theme bench (server/themeBench/bench.ts): one of its two
 * frames, named `mistri-theme-bench:light` or `:dark`. It holds that mode
 * whatever the reader chose elsewhere — and does not remember it, so the App
 * in its own tab is untouched — and wears each theme the bench posts through
 * the door an embedding host dresses the shell by. Only a page served by a
 * dev server joins (shellStart.js), and only its parent may dress it.
 */
import { setHostPlacement, setHostTheme } from './appTheme.js';
import { holdTheme } from '@mistriwork/kit/client/theme.js';
import type { ThemeDefinition } from '@mistriwork/engine/shared/theme.js';

const BENCH_FRAME = 'mistri-theme-bench:';

export function joinThemeBench(name: string): void {
  const mode = name.slice(BENCH_FRAME.length) === 'dark' ? 'dark' : 'light';
  holdTheme(mode);
  // host-global: the bench's frame is a whole page of its own, never an embedded shell; its parent posts to the window.
  window.addEventListener('message', (event: MessageEvent<{ type?: string; theme?: ThemeDefinition; placement?: 'side' | 'top' }>) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    if (event.data?.type !== 'mistri:theme-bench' || !event.data.theme) return;
    setHostTheme(event.data.theme);
    // Where the theme suggests the menu stands, when the App does not say: the bench works it out (bench.ts).
    setHostPlacement(event.data.placement === 'side' || event.data.placement === 'top' ? event.data.placement : undefined);
  });
  window.parent.postMessage({ type: 'mistri:theme-bench-ready', mode }, window.location.origin);
}
