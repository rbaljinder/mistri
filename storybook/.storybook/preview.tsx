import type { Decorator, Preview } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../packages/kit/src/client/style.css';
import '../../packages/kit/src/client/features.css';
import '../../packages/kit/src/client/page.css';
import '../../packages/kit/src/client/visualThemes.css';
import '../../packages/kit/src/client/themeFamilies.css';
import '../../packages/kit/src/client/customThemes.css';
import '../../packages/kit/src/client/structure.css';
import '../../packages/kit/src/client/components/ListEmpty.css';
import '../../packages/kit/src/client/components/Notes.css';
// The kit custom components draw with: their examples are stories too (main.ts).
import '../../packages/mistri/src/client/components/sdk/kit.css';
import {
  configureVisualThemes,
  customThemeTokens,
  setVisualTheme,
  visualThemeOverrides,
} from '../../packages/kit/src/client/visualTheme.js';
import { THEME_PRESETS } from '../../packages/engine/src/shared/themePresets.js';
import { applicationFixture } from '../mocks/core.js';

function StoryQueries({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/* Dressed the way an App is: the look's name on the root, then its palette,
   fonts and radii as the same inline tokens the App writes. */
const dressed: Decorator = (Story, context) => {
  const { look = 'workshop', mode = 'light' } = context.globals as { look?: string; mode?: 'light' | 'dark' };
  const root = document.documentElement;
  configureVisualThemes([], 'workshop', true);
  setVisualTheme(look);
  root.dataset.theme = mode;
  const tokens = customThemeTokens(mode === 'dark');
  const { radius, font } = visualThemeOverrides();
  for (const [name, value] of Object.entries({ ...tokens, ...(radius ? { '--radius': radius } : {}), '--mono': font })) {
    root.style.setProperty(name, value);
  }
  document.body.classList.add('app-mode');
  /* A story in the App's frame (stories/appShell.tsx) brings its own gutters,
     as the App does; every other story sits on the page's ground, inset. */
  const framed = context.parameters.shell === true;
  return (
    <StoryQueries key={context.id}>
      <div
        style={{ padding: framed ? 0 : 24, background: 'var(--ground)', minHeight: '100vh', color: 'var(--ink)', boxSizing: 'border-box' }}
      >
        <Story />
      </div>
    </StoryQueries>
  );
};

const preview: Preview = {
  beforeEach: async () => {
    document.body.classList.remove('app-topnav', 'sidebar-hidden', 'app-nav-rail', 'app-mobile-nav');
    await applicationFixture({ app: null, tables: [] });
  },
  decorators: [dressed],
  globalTypes: {
    look: {
      description: 'Built-in look',
      toolbar: {
        title: 'Look',
        icon: 'paintbrush',
        dynamicTitle: true,
        items: THEME_PRESETS.map((theme) => ({ value: theme.id, title: theme.label })),
      },
    },
    mode: {
      description: 'Light or dark',
      toolbar: {
        title: 'Mode',
        icon: 'mirror',
        dynamicTitle: true,
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
      },
    },
  },
  // Workshop, as an App that names no look wears it.
  initialGlobals: { look: 'workshop', mode: 'light' },
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
    /* The a11y panel runs axe on every story and lists what it finds, but a
       finding does not fail the story. The browser gate's axe spec is what
       fails a build, over the App's real rooms; a story is a component out
       of its page, and landmarks and a page's one h1 are the App's to give. */
    a11y: { test: 'todo' },
  },
};

export default preview;
