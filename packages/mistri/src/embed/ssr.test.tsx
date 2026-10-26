// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, List, Provider } from './index.js';

describe('a server render of the host’s page', () => {
  it('imports the entry and draws each element as its empty slot, with the host’s fallback', () => {
    expect(typeof window).toBe('undefined');
    const html = renderToString(
      <Provider endpoint="/api/tw" auth={{ assertion: async () => 'never asked on the server' }}>
        <App app="compass" basePath="/crm" className="pane" fallback={<p>Loading the CRM…</p>} />
        <List app="compass" view="leads" />
      </Provider>,
    );
    expect(html).toBe('<div class="pane" data-mistri-slot="App"><p>Loading the CRM…</p></div><div data-mistri-slot="List"></div>');
  });
});
